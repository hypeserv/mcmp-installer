import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import yazl from 'yazl';
import { detectLoaderKindFromMods } from '../src/guessLoader.js';

function jarWith(file: string, entry: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const z = new yazl.ZipFile();
        z.addBuffer(Buffer.from('{}'), entry);
        z.end();
        z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

async function modsDir(entries: string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-guess-'));
    await fs.ensureDir(path.join(dir, 'mods'));
    await Promise.all(entries.map((e, i) => jarWith(path.join(dir, 'mods', `m${i}.jar`), e)));
    return dir;
}

const cases: [string, string[], string | null][] = [
    ['legacy forge (mcmod.info)', ['mcmod.info', 'mcmod.info', 'assets/x.png'], 'forge'],
    ['modern forge (mods.toml)', ['META-INF/mods.toml', 'META-INF/mods.toml'], 'forge'],
    ['neoforge', ['META-INF/neoforge.mods.toml', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml'], 'neoforge'],
    ['fabric', ['fabric.mod.json', 'fabric.mod.json', 'mcmod.info'], 'fabric'],
    ['no metadata', ['assets/x.png'], null]
];

for (const [name, entries, expected] of cases) {
    test(`detects loader kind: ${name}`, async () => {
        const dir = await modsDir(entries);
        assert.equal(await detectLoaderKindFromMods(path.join(dir, 'mods')), expected);
        await fs.remove(dir);
    });
}

test('no mods dir: null', async () => {
    assert.equal(await detectLoaderKindFromMods('/nonexistent/mods'), null);
});

test('loader from a shipped installer jar', async () => {
    const { loaderFromInstallerJar } = await import('../src/guessLoader.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-inst-'));
    await fs.writeFile(path.join(dir, 'forge-1.12.2-14.23.5.2860-installer.jar'), '');
    assert.deepEqual(await loaderFromInstallerJar(dir, null), { kind: 'forge', mcVersion: '1.12.2', loaderVersion: '14.23.5.2860' });
    await fs.remove(path.join(dir, 'forge-1.12.2-14.23.5.2860-installer.jar'));
    await fs.writeFile(path.join(dir, 'neoforge-21.1.172-installer.jar'), '');
    assert.deepEqual(await loaderFromInstallerJar(dir, '1.21.1'), { kind: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.172' });
    await fs.remove(dir);
});
