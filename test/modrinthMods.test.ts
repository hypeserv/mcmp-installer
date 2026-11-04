import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import fs from 'fs-extra';
import { downloadModrinthMods } from '../src/downloadModrinthMods.js';

test('mrpack files land at their index path, client-only files are skipped', async () => {
    const server = http.createServer((req, res) => {
        if (req.url?.includes('missing')) { res.writeHead(404); res.end(); return; }
        res.end(`content of ${req.url}`);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-mr-'));
    await fs.writeJson(path.join(root, 'modrinth.index.json'), {
        files: [
            { path: 'mods/fabric-api-0.116.17+1.21.1.jar', downloads: [`${base}/data/fabric-api-0.116.17%2B1.21.1.jar`] },
            { path: 'resourcepacks/pack.zip', downloads: [`${base}/data/pack.zip`] },
            { path: 'mods/sodium.jar', downloads: [`${base}/data/sodium.jar`], env: { client: 'required', server: 'unsupported' } },
            { path: '../escape.jar', downloads: [`${base}/data/escape.jar`] },
            { path: 'mods/gone.jar', downloads: [`${base}/missing/gone.jar`] }
        ]
    });

    const lines: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
        await downloadModrinthMods(path.join(root, 'modrinth.index.json'));
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        server.close();
    }

    assert.equal(await fs.readFile(path.join(root, 'mods/fabric-api-0.116.17+1.21.1.jar'), 'utf8'), 'content of /data/fabric-api-0.116.17%2B1.21.1.jar');
    assert.ok(await fs.pathExists(path.join(root, 'resourcepacks/pack.zip')));
    assert.equal(await fs.pathExists(path.join(root, 'mods/sodium.jar')), false);
    assert.equal(await fs.pathExists(path.join(root, '..', 'escape.jar')), false);
    assert.equal(await fs.pathExists(path.join(root, 'mods/gone.jar')), false);

    const out = lines.join('\n');
    assert.match(out, /Mods \[#+-*\] 1\/4 \(25%\) fabric-api-0\.116\.17\+1\.21\.1\.jar/);
    assert.match(out, /Mods \[#{20}\] 4\/4 \(100%\)/);
    assert.match(out, /Mods done: 2\/4 downloaded, 2 failed, 1 skipped \(client-only \/ not a mod\)\./);
    await fs.remove(root);
});
