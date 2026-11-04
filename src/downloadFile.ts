import fs from 'fs-extra';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import axios, { AxiosResponse } from 'axios';
import cliProgress from 'cli-progress';
import { log } from './util/logger.js';

interface AxiosHeadResponse {
    headers: Record<string, string | undefined>;
    request?: { res?: { responseUrl?: string } };
}

export interface DownloadOptions {
    /** Attempts in total, including the first. */
    attempts?: number;
    /** Abort an attempt when no data arrives for this long. */
    stallMs?: number;
    /** Wait before retry n (1-based) in ms. */
    backoffMs?: (attempt: number) => number;
    /** Save under this name instead of the last URL segment. */
    fileName?: string;
    /** No "Finished downloading" line (callers that report their own progress). */
    quiet?: boolean;
}

const DEFAULTS: Required<Omit<DownloadOptions, 'fileName' | 'quiet'>> = {
    attempts: 5,
    stallMs: 60_000,
    backoffMs: attempt => Math.min(30_000, 2_000 * 2 ** (attempt - 1))
};

/**
 * HEAD to resolve redirect (wget-style)
 */
export async function downloadWgetStyle(url: string): Promise<string> {
    const head = (await axios.head(url, {
        maxRedirects: 10,
        validateStatus: null
    })) as unknown as AxiosHeadResponse;
    const finalUrl =
        (head.headers.location as string | undefined) ||
        head.request?.res?.responseUrl ||
        url;
    return download(finalUrl);
}

/**
 * Download into the current directory with a progress bar. Returns the
 * filename. Retries dropped or stalled connections and resumes with an HTTP
 * Range request when the server supports it (CDNs drop long downloads of
 * multi-GB server packs).
 */
export async function download(url: string, options: DownloadOptions = {}): Promise<string> {
    const opts = { ...DEFAULTS, ...options };
    let fileName: string = options.fileName || url.split('/').pop()?.split('?')[0] || 'modpack.zip';
    if (!fileName) fileName = 'download.bin';

    await fs.ensureDir(process.cwd());
    const destPath = path.join(process.cwd(), fileName);
    await fs.remove(destPath);

    let lastError: unknown;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        if (attempt > 1) {
            const wait = opts.backoffMs(attempt - 1);
            const msg = lastError instanceof Error ? lastError.message : String(lastError);
            log.warn(`Download of ${fileName} failed (${msg}); retry ${attempt - 1}/${opts.attempts - 1} in ${Math.round(wait / 1000)}s...`);
            await new Promise(r => setTimeout(r, wait));
        }
        try {
            await downloadAttempt(url, destPath, opts.stallMs);
            if (!options.quiet) log.info(`Finished downloading ${fileName}`);
            return fileName;
        } catch (err) {
            lastError = err;
            // 4xx won't change on retry (except timeout / rate limit).
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
                throw new Error(`Download of ${fileName} failed: HTTP ${status}`);
            }
        }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Download of ${fileName} failed after ${opts.attempts} attempts: ${msg}`);
}

async function downloadAttempt(url: string, destPath: string, stallMs: number): Promise<void> {
    const have = (await fs.pathExists(destPath)) ? (await fs.stat(destPath)).size : 0;
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.get(url, {
        responseType: 'stream',
        maxRedirects: 10,
        timeout: stallMs,
        // identity: byte counts and Range offsets refer to the file itself.
        headers: {
            'accept-encoding': 'identity',
            ...(have > 0 ? { range: `bytes=${have}-` } : {})
        },
        validateStatus: (status: number) => status >= 200 && status < 400
    });

    // 206 = server resumed at our offset; anything else is the whole file again.
    const resumed = have > 0 && res.status === 206;
    if (have > 0 && !resumed) log.info('Server does not support resume, restarting download.');
    const start = resumed ? have : 0;
    const length = Number(res.headers['content-length'] || 0);
    const total = length > 0 ? start + length : 0;

    const progressReporter = createProgress(path.basename(destPath), total, start);

    // Abort when the connection goes quiet; a stalled socket otherwise hangs forever.
    let received = start;
    let timer: NodeJS.Timeout | undefined;
    const source = res.data as NodeJS.ReadableStream & { destroy(err?: Error): void };
    const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => source.destroy(new Error(`no data for ${stallMs / 1000}s`)), stallMs);
    };
    const progress = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            progressReporter.update(received);
            arm();
            cb(null, chunk);
        }
    });

    arm();
    try {
        // pipeline() applies backpressure and resolves only after the file is flushed.
        await pipeline(source, progress, fs.createWriteStream(destPath, { flags: resumed ? 'a' : 'w' }));
    } finally {
        clearTimeout(timer);
        progressReporter.stop(received);
    }
    if (total > 0 && received < total) {
        throw new Error(`connection closed early (${received} of ${total} bytes)`);
    }
}

const LOG_MIN_BYTES = 10 * 1024 * 1024;
const LOG_EVERY_MS = 15_000;

interface Progress {
    update(received: number): void;
    stop(received: number): void;
}

/**
 * Terminal: a live progress bar. Anything else (the panel's install console,
 * log files): cli-progress draws nothing there, so print a line every 10% or
 * 15 s instead. Small files (mods) get no progress lines.
 */
function createProgress(name: string, total: number, start: number): Progress {
    if (process.stdout.isTTY) {
        const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        if (total > 0) bar.start(total, start);
        return {
            update: received => { if (total > 0) bar.update(received); },
            stop: () => { if (total > 0) bar.stop(); }
        };
    }

    const began = Date.now();
    let lastLog = began;
    let lastPct = total > 0 ? Math.floor((start / total) * 10) : 0;
    let logged = false;
    const line = (received: number): void => {
        const secs = Math.max(1, (Date.now() - began) / 1000);
        const rate = (received - start) / secs;
        const pct = total > 0 ? `${Math.floor((received / total) * 100)}% ` : '';
        const size = total > 0 ? `${mb(received)}/${mb(total)} MB` : `${mb(received)} MB`;
        const left = total > 0 && rate > 0 ? (total - received) / rate : 0;
        const eta = left <= 0 ? '' : left < 60 ? `, ~${Math.ceil(left)} s left` : `, ~${Math.ceil(left / 60)} min left`;
        log.info(`Downloading ${name}: ${pct}(${size}, ${(rate / 1048576).toFixed(1)} MB/s${eta})`);
        logged = true;
    };
    return {
        update: received => {
            if (Math.max(total, received) < LOG_MIN_BYTES) return;
            const now = Date.now();
            const pct = total > 0 ? Math.floor((received / total) * 10) : 0;
            if (pct > lastPct || now - lastLog >= LOG_EVERY_MS) {
                lastPct = pct;
                lastLog = now;
                line(received);
            }
        },
        stop: received => {
            if (logged && total > 0 && received >= total) return; // 100% line already printed
            if (logged) line(received);
        }
    };
}

function mb(bytes: number): string {
    return (bytes / 1048576).toFixed(0);
}
