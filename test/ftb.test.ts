import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import fs from 'fs-extra';
import { ftbLoader, installFtbManifest } from '../src/ftb.js';

const sha1 = (b: Buffer): string => crypto.createHash('sha1').update(b).digest('hex');

test('ftbLoader reads game + modloader targets', () => {
    const targets = (loader: string, version: string) => [
        { name: 'minecraft', version: '1.21.1', type: 'game' },
        { name: loader, version, type: 'modloader' },
        { name: 'java', version: '21.0.4+7-LTS', type: 'runtime' }
    ];
    assert.deepEqual(ftbLoader({ targets: targets('neoforge', '21.1.248') }).loader, { kind: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.248' });
    assert.deepEqual(ftbLoader({ targets: targets('forge', '43.5.0') }).loader, { kind: 'forge', mcVersion: '1.21.1', loaderVersion: '43.5.0' });
    assert.equal(ftbLoader({ targets: [{ name: 'minecraft', version: '1.20.1', type: 'game' }] }).loader, null);
    assert.throws(() => ftbLoader({ targets: targets('quilt', '0.20.0') }), /quilt loader, which is not supported/);
});

test('FTB manifest install: files, client-only skip, traversal guard, sha1 check, CF fallback', async () => {
    const blobs: Record<string, Buffer> = {
        '/blob/mod.jar': Buffer.from('mod jar'),
        '/blob/cfg.toml': Buffer.from('a=1'),
        '/blob/bad.jar': Buffer.from('tampered'),
        '/cf/files/9/9/cfmod.jar': Buffer.from('from curseforge')
    };
    let base = '';
    const files = () => [
        { name: 'mod.jar', path: './mods', url: `${base}/blob/mod.jar`, sha1: sha1(blobs['/blob/mod.jar']), size: 7 },
        { name: 'cfg.toml', path: './config/sub', url: `${base}/blob/cfg.toml`, sha1: sha1(blobs['/blob/cfg.toml']) },
        { name: 'client.jar', path: './mods', url: `${base}/blob/mod.jar`, clientonly: true },
        { name: 'evil.jar', path: '../outside', url: `${base}/blob/mod.jar` },
        { name: 'abs.jar', path: '/tmp', url: `${base}/blob/mod.jar` },
        { name: '../x.jar', path: './mods', url: `${base}/blob/mod.jar` },
        { name: 'bad.jar', path: './mods', url: `${base}/blob/bad.jar`, sha1: sha1(Buffer.from('expected')) },
        { name: 'cfmod.jar', path: './mods', url: '', curseforge: { project: '1', file: '9009' } }
    ];
    const server = http.createServer((req, res) => {
        const url = req.url || '';
        if (url === '/modpack/1/2') {
            res.end(JSON.stringify({
                status: 'success', parent: 1, name: 'Test 1.0',
                targets: [
                    { name: 'minecraft', version: '1.20.1', type: 'game' },
                    { name: 'forge', version: '47.1.3', type: 'modloader' }
                ],
                files: files()
            }));
            return;
        }
        if (url === '/modpack/1/404') { res.writeHead(404); res.end('{"status":"error"}'); return; }
        // HypeServ mod API: restricted file without URL -> fallback layout
        if (url === '/v3/modpack/fileUrl/1/9009') {
            res.end(JSON.stringify({ success: true, data: { id: 9009, fileName: 'cfmod.jar', downloadUrl: null } }));
            return;
        }
        const body = blobs[url];
        if (!body) { res.writeHead(404); res.end(); return; }
        res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.MCI_MOD_API_BASE = base;
    process.env.MCI_FILE_FALLBACK_BASE = `${base}/cf`;

    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-ftb-'));
    const root = path.join(parent, 'server');
    await fs.ensureDir(root);
    const origLog = console.log, origWarn = console.warn;
    console.log = () => undefined; console.warn = () => undefined;
    try {
        const result = await installFtbManifest(`${base}/modpack/1/2`, root, false);

        assert.deepEqual(result.loader, { kind: 'forge', mcVersion: '1.20.1', loaderVersion: '47.1.3' });
        assert.equal(await fs.readFile(path.join(root, 'mods/mod.jar'), 'utf8'), 'mod jar');
        assert.equal(await fs.readFile(path.join(root, 'config/sub/cfg.toml'), 'utf8'), 'a=1');
        assert.equal(await fs.readFile(path.join(root, 'mods/cfmod.jar'), 'utf8'), 'from curseforge');
        assert.equal(await fs.pathExists(path.join(root, 'mods/client.jar')), false);
        assert.equal(await fs.pathExists(path.join(parent, 'outside')), false);
        assert.equal(await fs.pathExists('/tmp/abs.jar'), false);
        assert.equal(await fs.pathExists(path.join(root, 'x.jar')), false);
        assert.equal(await fs.pathExists(path.join(root, 'mods/bad.jar')), false);

        assert.equal(result.mods.source, 'ftb');
        assert.equal(result.mods.total, 7);
        assert.equal(result.mods.installed, 3);
        assert.deepEqual(result.mods.clientOnlyRemoved, ['client.jar']);
        const failed = Object.fromEntries(result.mods.failed.map(f => [f.fileName, f.reason]));
        assert.match(failed['evil.jar'], /outside the server root/);
        assert.match(failed['abs.jar'], /outside the server root/);
        assert.match(failed['../x.jar'], /outside the server root/);
        assert.match(failed['bad.jar'], /sha1 mismatch/);

        await assert.rejects(installFtbManifest(`${base}/modpack/1/404`, root, false), /HTTP 404/);
    } finally {
        console.log = origLog; console.warn = origWarn;
        delete process.env.MCI_MOD_API_BASE; delete process.env.MCI_FILE_FALLBACK_BASE;
        server.close();
        await fs.remove(parent);
    }
});
