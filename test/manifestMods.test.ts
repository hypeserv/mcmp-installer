import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackFileUrl } from '../src/downloadManifestMods.js';

test('fallback file URL from file id and name', () => {
    assert.equal(fallbackFileUrl(3726051, 'neoncraft2-2.2.jar'), 'https://edge.forgecdn.net/files/3726/51/neoncraft2-2.2.jar');
    assert.equal(
        fallbackFileUrl(3857874, 'BuildersDelight-1.18.2-v.1.0.jar'),
        'https://edge.forgecdn.net/files/3857/874/BuildersDelight-1.18.2-v.1.0.jar'
    );
    assert.equal(fallbackFileUrl(7107048, 'a b+c.jar'), 'https://edge.forgecdn.net/files/7107/48/a%20b%2Bc.jar');
});

test('manifest install reports restricted, failed and client-only mods', async () => {
    const http = await import('node:http');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = (await import('fs-extra')).default;
    const yazl = (await import('yazl')).default;
    const { downloadManifestMods } = await import('../src/downloadManifestMods.js');

    const jarBuf = (toml: string): Promise<Buffer> => new Promise(resolve => {
        const z = new yazl.ZipFile();
        z.addBuffer(Buffer.from(toml), 'META-INF/mods.toml');
        z.end();
        const chunks: Buffer[] = [];
        z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
    });
    const files: Record<string, Buffer> = {
        '/files/1/1/common.jar': await jarBuf('[[mods]]\nmodId="common"\n'),
        '/files/2/2/restricted.jar': await jarBuf('[[mods]]\nmodId="restricted"\n'),
        '/files/4/4/LegendaryTooltips-1.0.jar': await jarBuf('[[mods]]\nmodId="legendarytooltips"\n')
    };
    // mod API: project 1 normal, 2 restricted (no URL), 3 restricted and not on the CDN, 4 client-only
    const api: Record<string, object> = {
        '1/1001': { id: 1001, fileName: 'common.jar', downloadUrl: 'BASE/files/1/1/common.jar' },
        '2/2002': { id: 2002, fileName: 'restricted.jar', downloadUrl: null },
        '3/3003': { id: 3003, fileName: 'gone.jar', downloadUrl: null },
        '4/4004': { id: 4004, fileName: 'LegendaryTooltips-1.0.jar', downloadUrl: 'BASE/files/4/4/LegendaryTooltips-1.0.jar' }
    };
    const server = http.createServer((req, res) => {
        const m = /^\/v3\/modpack\/fileUrl\/(\d+\/\d+)$/.exec(req.url || '');
        if (m) {
            const d = JSON.parse(JSON.stringify(api[m[1]]).replace(/BASE/g, base));
            res.end(JSON.stringify({ success: true, data: d }));
            return;
        }
        // fallback layout: /files/<id/1000>/<id%1000>/<name>
        const fb: Record<string, string> = { '/files/2/2/restricted.jar': '/files/2/2/restricted.jar' };
        const body = files[req.url || ''] ?? files[fb[req.url || ''] ?? ''];
        if (!body) { res.writeHead(404); res.end(); return; }
        res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    process.env.MCI_MOD_API_BASE = base;
    process.env.MCI_FILE_FALLBACK_BASE = base;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-man-'));
    await fs.writeJson(path.join(dir, 'manifest.json'), {
        files: [1, 2, 3, 4].map(n => ({ projectID: n, fileID: n * 1000 + n }))
    });
    await fs.ensureDir(path.join(dir, 'mods'));
    const prev = process.cwd();
    process.chdir(path.join(dir, 'mods'));
    const origLog = console.log, origWarn = console.warn;
    console.log = () => undefined; console.warn = () => undefined;
    try {
        const report = await downloadManifestMods(path.join(dir, 'manifest.json'), false);
        assert.equal(report.total, 4);
        assert.equal(report.installed, 2);
        assert.deepEqual(report.restricted, [
            { projectId: 2, fileId: 2002, fileName: 'restricted.jar', installed: true },
            { projectId: 3, fileId: 3003, fileName: 'gone.jar', installed: false }
        ]);
        assert.equal(report.failed.length, 1);
        assert.equal(report.failed[0].fileName, 'gone.jar');
        assert.deepEqual(report.clientOnlyRemoved, ['LegendaryTooltips-1.0.jar']);
        assert.ok(await fs.pathExists(path.join(dir, 'mods', 'restricted.jar')));
    } finally {
        console.log = origLog; console.warn = origWarn;
        process.chdir(prev);
        delete process.env.MCI_MOD_API_BASE; delete process.env.MCI_FILE_FALLBACK_BASE;
        server.close();
        await fs.remove(dir);
    }
});
