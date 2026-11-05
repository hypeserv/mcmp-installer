import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import fs from 'fs-extra';
import yazl from 'yazl';
import { downloadManifestMods, fallbackFileUrl, manifestStep, readLevelName } from '../src/downloadManifestMods.js';
import { lookupCurseForgeFiles } from '../src/cfFiles.js';

const sha1 = (b: Buffer): string => crypto.createHash('sha1').update(b).digest('hex');
const FILES_ROUTE = '/api/v1/games/minecraft/curseforge/files';

const jarBuf = (toml: string): Promise<Buffer> => new Promise(resolve => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from(toml), 'META-INF/mods.toml');
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const origLog = console.log, origWarn = console.warn;
    console.log = () => undefined; console.warn = () => undefined;
    try { return await fn(); } finally { console.log = origLog; console.warn = origWarn; }
};

/** Fake modpack-magic files endpoint + CDN. `meta` maps "project/file" to the lookup entry. */
async function fakeServer(meta: Record<string, object>, blobs: Record<string, Buffer>) {
    const calls: { auth?: string; files: { projectId: number; fileId: number }[] }[] = [];
    let base = '';
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === FILES_ROUTE) {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const { files } = JSON.parse(body) as { files: { projectId: number; fileId: number }[] };
                calls.push({ auth: req.headers.authorization, files });
                if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); res.end('{}'); return; }
                // Like modpack-magic: reject entries with keys other than projectId / fileId.
                const extra = files.flatMap(f => Object.keys(f).filter(k => k !== 'projectId' && k !== 'fileId'));
                if (extra.length) { res.writeHead(400); res.end(JSON.stringify({ error: `Unrecognized keys: ${[...new Set(extra)].join(', ')}` })); return; }
                const found = files.filter(f => meta[`${f.projectId}/${f.fileId}`]);
                const missing = files.filter(f => !meta[`${f.projectId}/${f.fileId}`]);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    files: found.map(f => JSON.parse(JSON.stringify(meta[`${f.projectId}/${f.fileId}`]).replace(/BASE/g, base))),
                    missing
                }));
            });
            return;
        }
        const body = blobs[req.url || ''];
        if (!body) { res.writeHead(404); res.end(); return; }
        res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, base, calls };
}

test('fallback file URL from file id and name', () => {
    assert.equal(fallbackFileUrl(3726051, 'neoncraft2-2.2.jar'), 'https://edge.forgecdn.net/files/3726/51/neoncraft2-2.2.jar');
    assert.equal(
        fallbackFileUrl(3857874, 'BuildersDelight-1.18.2-v.1.0.jar'),
        'https://edge.forgecdn.net/files/3857/874/BuildersDelight-1.18.2-v.1.0.jar'
    );
    assert.equal(fallbackFileUrl(7107048, 'a b+c.jar'), 'https://edge.forgecdn.net/files/7107/48/a%20b%2Bc.jar');
});

test('level-name from server.properties, overrides copy, default world', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-lvl-'));
    try {
        assert.equal(await readLevelName(dir), 'world');
        await fs.outputFile(path.join(dir, 'overrides', 'server.properties'), 'motd=x\nlevel-name=packworld\n');
        assert.equal(await readLevelName(dir), 'packworld');
        await fs.writeFile(path.join(dir, 'server.properties'), 'level-name=../escape\n');
        assert.equal(await readLevelName(dir), 'world');
        await fs.writeFile(path.join(dir, 'server.properties'), 'level-name = My World\n');
        assert.equal(await readLevelName(dir), 'My World');
    } finally {
        await fs.remove(dir);
    }
});

test('manifest install: one batch lookup, types, datapacks, restricted, sha1, client-only', async () => {
    const blobs: Record<string, Buffer> = {
        '/cdn/common.jar': await jarBuf('[[mods]]\nmodId="common"\n'),
        '/files/2/2/restricted.jar': await jarBuf('[[mods]]\nmodId="restricted"\n'),
        '/cdn/LegendaryTooltips-1.0.jar': await jarBuf('[[mods]]\nmodId="legendarytooltips"\n'),
        '/cdn/structures.zip': Buffer.from('datapack'),
        '/cdn/tampered.jar': Buffer.from('tampered')
    };
    const meta: Record<string, object> = {
        '1/1001': { projectId: 1, fileId: 1001, fileName: 'common.jar', url: 'BASE/cdn/common.jar', sha1: sha1(blobs['/cdn/common.jar']), type: 'mod', classId: 6 },
        '2/2002': { projectId: 2, fileId: 2002, fileName: 'restricted.jar', url: null, type: 'mod', classId: 6 },
        '3/3003': { projectId: 3, fileId: 3003, fileName: 'gone.jar', url: null, type: 'mod', classId: 6 },
        '4/4004': { projectId: 4, fileId: 4004, fileName: 'LegendaryTooltips-1.0.jar', url: 'BASE/cdn/LegendaryTooltips-1.0.jar', type: 'mod', classId: 6 },
        '5/5005': { projectId: 5, fileId: 5005, fileName: 'Faithful.zip', url: 'BASE/cdn/x', type: 'resourcepack', classId: 12 },
        '6/6006': { projectId: 6, fileId: 6006, fileName: 'Complementary.zip', url: 'BASE/cdn/x', type: 'shader', classId: 6552 },
        '7/7007': { projectId: 7, fileId: 7007, fileName: 'structures.zip', url: 'BASE/cdn/structures.zip', type: 'datapack', classId: 6945 },
        '8/8008': { projectId: 8, fileId: 8008, fileName: 'tampered.jar', url: 'BASE/cdn/tampered.jar', sha1: sha1(Buffer.from('expected')), type: 'mod' },
        '10/10010': { projectId: 10, fileId: 10010, fileName: 'world.zip', url: 'BASE/cdn/x', type: 'other' }
    };
    const { server, base, calls } = await fakeServer(meta, blobs);
    process.env.MCI_FILE_FALLBACK_BASE = base;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-man-'));
    await fs.writeJson(path.join(dir, 'manifest.json'), {
        files: [
            ...[1, 2, 3, 4, 5, 6, 7, 8, 10].map(n => ({ projectID: n, fileID: n * 1000 + n, required: true })),
            { projectID: 9, fileID: 9009, required: false } // optional, gone from CurseForge
        ]
    });
    await fs.outputFile(path.join(dir, 'overrides', 'server.properties'), 'level-name=packworld\n');
    const modsDir = path.join(dir, 'mods');
    try {
        const report = await quiet(() => downloadManifestMods(path.join(dir, 'manifest.json'), {
            modsDir, serverRoot: dir, lookup: { resolverUrl: base, token: 'good' }
        }));
        assert.equal(calls.length, 1, 'one batch call');
        assert.equal(calls[0].files.length, 10);

        assert.equal(report.total, 10);
        assert.deepEqual(report.clientOnlyRemoved, ['LegendaryTooltips-1.0.jar']);
        assert.deepEqual(report.datapacks, ['structures.zip']);
        assert.equal(report.installed, 3); // common, restricted, structures
        assert.deepEqual(report.restricted.sort((a, b) => a.projectId - b.projectId), [
            { projectId: 2, fileId: 2002, fileName: 'restricted.jar', installed: true },
            { projectId: 3, fileId: 3003, fileName: 'gone.jar', installed: false }
        ]);
        const failed = Object.fromEntries(report.failed.map(f => [f.fileName, f.reason]));
        assert.match(failed['gone.jar'], /HTTP 404/);
        assert.match(failed['tampered.jar'], /sha1 mismatch/);
        assert.deepEqual(
            report.skipped.map(s => `${s.projectId}:${s.type}`).sort(),
            ['10:other', '5:resourcepack', '6:shader', '9:missing (optional)']
        );

        assert.ok(await fs.pathExists(path.join(modsDir, 'common.jar')));
        assert.ok(await fs.pathExists(path.join(modsDir, 'restricted.jar')));
        assert.ok(!(await fs.pathExists(path.join(modsDir, 'tampered.jar'))));
        assert.ok(!(await fs.pathExists(path.join(modsDir, 'Faithful.zip'))));
        assert.ok(!(await fs.pathExists(path.join(modsDir, 'Complementary.zip'))));
        assert.equal(await fs.readFile(path.join(dir, 'packworld', 'datapacks', 'structures.zip'), 'utf8'), 'datapack');
    } finally {
        delete process.env.MCI_FILE_FALLBACK_BASE;
        server.close();
        await fs.remove(dir);
    }
});

test('manifest install fails hard: no token, refused token, required file missing, no mod downloadable', async () => {
    const meta: Record<string, object> = {
        '1/1001': { projectId: 1, fileId: 1001, fileName: 'a.jar', url: 'BASE/cdn/nothing.jar', type: 'mod' }
    };
    const { server, base } = await fakeServer(meta, {});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-man-'));
    const manifest = path.join(dir, 'manifest.json');
    const run = (token: string | null) => quiet(() => downloadManifestMods(manifest, {
        modsDir: path.join(dir, 'mods'), serverRoot: dir, lookup: { resolverUrl: base, token }
    }));
    try {
        await fs.writeJson(manifest, { files: [{ projectID: 1, fileID: 1001 }] });
        await assert.rejects(run(null), /needs 1 CurseForge file lookups, but no modpack-magic token/);
        await assert.rejects(run('bad'), /refused \(HTTP 401\).*modpack:files/);
        await assert.rejects(run('good'), /None of the 1 mods from manifest.json could be downloaded/);

        await fs.writeJson(manifest, { files: [{ projectID: 1, fileID: 1001 }, { projectID: 9, fileID: 9009 }] });
        await assert.rejects(run('good'), /1 files from manifest.json no longer exist on CurseForge.*9\/9009/);
    } finally {
        server.close();
        await fs.remove(dir);
    }
});

test('lookup chunks at 1000 entries and dedupes', async () => {
    const meta: Record<string, object> = {};
    for (let i = 1; i <= 1500; i++) meta[`${i}/${i}`] = { projectId: i, fileId: i, fileName: `m${i}.jar`, url: null, type: 'mod' };
    const { server, base, calls } = await fakeServer(meta, {});
    try {
        const refs = Array.from({ length: 1500 }, (_, i) => ({ projectId: i + 1, fileId: i + 1 }));
        const result = await lookupCurseForgeFiles([...refs, refs[0]], { resolverUrl: base, token: 'good' });
        assert.deepEqual(calls.map(c => c.files.length), [1000, 500]);
        assert.equal(result.files.size, 1500);
        assert.deepEqual(result.missing, []);
        assert.equal(result.files.get('7/7')?.url, null);
    } finally {
        server.close();
    }
});

test('manifest step: server pack with shipped mods is not downloaded again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-step-'));
    const manifest = path.join(dir, 'manifest.json');
    const mods = path.join(dir, 'mods');
    try {
        await fs.writeJson(manifest, { files: [] });
        assert.equal(await manifestStep(manifest, mods), 'none');
        await fs.writeJson(manifest, { files: [{ projectID: 1, fileID: 1001 }] });
        assert.equal(await manifestStep(manifest, mods), 'download');
        await fs.ensureDir(mods);
        await fs.writeFile(path.join(mods, 'readme.txt'), 'x');
        assert.equal(await manifestStep(manifest, mods), 'download');
        await fs.writeFile(path.join(mods, 'shipped.jar'), 'x');
        assert.equal(await manifestStep(manifest, mods), 'shipped');
    } finally {
        await fs.remove(dir);
    }
});
