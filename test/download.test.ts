import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import fs from 'fs-extra';
import { download } from '../src/downloadFile.js';

const BODY = crypto.randomBytes(256 * 1024);
const FAST = { backoffMs: () => 10 };

type Mode = 'drop-then-resume' | 'drop-no-range' | 'stall-then-ok';

async function serve(mode: Mode): Promise<{ url: string; requests: string[]; close: () => void }> {
    const requests: string[] = [];
    let count = 0;
    const server = http.createServer((req, res) => {
        count++;
        const range = req.headers.range;
        requests.push(range || 'full');
        const m = range && mode !== 'drop-no-range' ? /bytes=(\d+)-/.exec(range) : null;
        const start = m ? Number(m[1]) : 0;
        const body = BODY.subarray(start);
        res.writeHead(m ? 206 : 200, {
            'content-length': body.length,
            'accept-ranges': mode === 'drop-no-range' ? 'none' : 'bytes',
            ...(m ? { 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {})
        });
        if (count === 1) {
            // First attempt: send a third of the file, then misbehave.
            res.write(body.subarray(0, Math.floor(BODY.length / 3)));
            if (mode === 'stall-then-ok') return; // keep the socket open, send nothing
            setTimeout(() => res.destroy(), 20);
            return;
        }
        res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/pack.zip`,
        requests,
        close: () => { server.closeAllConnections(); server.close(); }
    };
}

async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-dl-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
        return await fn(dir);
    } finally {
        process.chdir(prev);
        await fs.remove(dir);
    }
}

test('dropped connection resumes with a Range request', async () => {
    const s = await serve('drop-then-resume');
    try {
        await inTmp(async dir => {
            const name = await download(s.url, FAST);
            assert.equal(name, 'pack.zip');
            assert.ok((await fs.readFile(path.join(dir, name))).equals(BODY));
        });
        assert.equal(s.requests.length, 2);
        assert.match(s.requests[1], /^bytes=\d+-$/);
    } finally {
        s.close();
    }
});

test('server without Range support: restart from zero, file still correct', async () => {
    const s = await serve('drop-no-range');
    try {
        await inTmp(async dir => {
            const name = await download(s.url, FAST);
            assert.ok((await fs.readFile(path.join(dir, name))).equals(BODY));
        });
        assert.equal(s.requests.length, 2);
    } finally {
        s.close();
    }
});

test('stalled connection is aborted and retried', async () => {
    const s = await serve('stall-then-ok');
    try {
        await inTmp(async dir => {
            const name = await download(s.url, { ...FAST, stallMs: 300 });
            assert.ok((await fs.readFile(path.join(dir, name))).equals(BODY));
        });
        assert.equal(s.requests.length, 2);
    } finally {
        s.close();
    }
});

test('gives up after the configured attempts', async () => {
    await inTmp(async () => {
        await assert.rejects(
            download('http://127.0.0.1:1/x.zip', { attempts: 2, backoffMs: () => 1 }),
            /failed after 2 attempts/
        );
    });
});

test('HTTP 404 fails at once without retries', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => { hits++; res.writeHead(404); res.end(); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
        await inTmp(async () => {
            await assert.rejects(download(`http://127.0.0.1:${port}/x.jar`), /HTTP 404/);
        });
        assert.equal(hits, 1);
    } finally {
        server.close();
    }
});
