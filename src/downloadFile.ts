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
 * Download with progress bar. Returns filename.
 */
export async function download(url: string): Promise<string> {
    const res: AxiosResponse<NodeJS.ReadableStream> = await axios.get(url, {
        responseType: 'stream',
        maxRedirects: 10,
        validateStatus: (status: number) => status >= 200 && status < 400
    });

    let fileName: string =
        url.split('/').pop()?.split('?')[0] || 'modpack.zip';
    if (!fileName) fileName = 'download.bin';

    const total = Number(res.headers['content-length'] || 0);
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

    if (total > 0) bar.start(total, 0);

    await fs.ensureDir(process.cwd());
    const destPath = path.join(process.cwd(), fileName);

    // pipeline() applies backpressure (no buffering of a fast network into
    // memory) and resolves only after the file is flushed to disk.
    let downloaded = 0;
    const progress = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            downloaded += chunk.length;
            if (total > 0) bar.update(downloaded);
            cb(null, chunk);
        }
    });
    try {
        await pipeline(res.data, progress, fs.createWriteStream(destPath));
    } catch (err) {
        if (total > 0) bar.stop();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Download of ${fileName} failed: ${msg}`);
    }
    if (total > 0) bar.stop();
    log.info(`Finished downloading ${fileName}`);
    return fileName;
}
