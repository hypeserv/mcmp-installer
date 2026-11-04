import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import yazl from 'yazl';
import { isClientOnlyByMetadata, isClientOnlyByName } from '../src/clientOnlyMods.js';

function jar(file: string, entries: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
        const z = new yazl.ZipFile();
        for (const [name, body] of Object.entries(entries)) z.addBuffer(Buffer.from(body), name);
        z.end();
        z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

test('client-only by filename (ServerPackCreator list) with whitelist', () => {
    assert.equal(isClientOnlyByName('LegendaryTooltips-1.18.2-1.3.1.jar'), true);
    assert.equal(isClientOnlyByName('BetterF3-1.3.2.jar'), true);
    assert.equal(isClientOnlyByName('appleskin-forge-mc1.18.2-2.4.1.jar'), false);
    assert.equal(isClientOnlyByName('the_vault-1.18.2-3.21.6.jar'), false);
    assert.equal(isClientOnlyByName('create-1.18.2-0.5.1.jar'), false);
});

test('client-only by jar metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-client-'));
    const cases: [string, Record<string, string>, boolean][] = [
        ['fabric-client.jar', { 'fabric.mod.json': '{"id":"x","environment":"client"}' }, true],
        ['fabric-both.jar', { 'fabric.mod.json': '{"id":"x","environment":"*"}' }, false],
        ['forge-client.jar', { 'META-INF/mods.toml': 'modLoader="javafml"\nclientSideOnly=true\n' }, true],
        ['neo-client.jar', { 'META-INF/neoforge.mods.toml': 'clientSideOnly = true' }, true],
        ['forge-common.jar', { 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="x"\n' }, false],
        ['legacy.jar', { 'mcmod.info': '[]' }, false]
    ];
    for (const [name, entries, expected] of cases) {
        await jar(path.join(dir, name), entries);
        assert.equal(await isClientOnlyByMetadata(path.join(dir, name)), expected, name);
    }
    assert.equal(await isClientOnlyByMetadata(path.join(dir, 'missing.jar')), false);
    await fs.remove(dir);
});

test('client-only candidates are kept when another mod requires them', async () => {
    const { removeClientOnlyMods } = await import('../src/clientOnlyMods.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-deps-'));
    // AE2 requires GuideME (on ServerPackCreator's list) -> keep GuideME.
    await jar(path.join(dir, 'appliedenergistics2-forge-15.4.jar'), {
        'META-INF/mods.toml': '[[mods]]\nmodId="ae2"\n[[dependencies.ae2]]\nmodId="guideme"\nmandatory=true\nside="BOTH"\n'
    });
    await jar(path.join(dir, 'guideme-20.1.15.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="guideme"\n' });
    // Legendary Tooltips (listed) needs Iceberg; nothing needs Legendary Tooltips -> both go?
    // Iceberg is not listed, so it stays; Legendary Tooltips is removed.
    await jar(path.join(dir, 'LegendaryTooltips-1.18.2-1.3.1.jar'), {
        'META-INF/mods.toml': '[[mods]]\nmodId="legendarytooltips"\n[[dependencies.legendarytooltips]]\nmodId="iceberg"\nmandatory=true\nside="BOTH"\n'
    });
    await jar(path.join(dir, 'Iceberg-1.18.2-forge-1.0.49.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="iceberg"\n' });
    // A client-side-only dependency does not protect a candidate.
    await jar(path.join(dir, 'somemod-1.0.jar'), {
        'META-INF/mods.toml': '[[mods]]\nmodId="somemod"\n[[dependencies.somemod]]\nmodId="betterf3"\ntype="required"\nside="CLIENT"\n'
    });
    await jar(path.join(dir, 'BetterF3-1.3.2.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="betterf3"\n' });
    // Not downloaded by this step (server-pack mod) -> never removed.
    await jar(path.join(dir, 'BetterAdvancements-1.0.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="betteradvancements"\n' });

    const downloaded = new Set((await fs.readdir(dir)).filter(f => !f.startsWith('BetterAdvancements')));
    const removed = await removeClientOnlyMods(dir, downloaded);

    assert.deepEqual(removed.sort(), ['BetterF3-1.3.2.jar', 'LegendaryTooltips-1.18.2-1.3.1.jar']);
    assert.ok(await fs.pathExists(path.join(dir, 'guideme-20.1.15.jar')));
    assert.ok(await fs.pathExists(path.join(dir, 'BetterAdvancements-1.0.jar')));
    await fs.remove(dir);
});

test('HypeServ supplement: NeoForge builds of Sodium and Iris', () => {
    assert.equal(isClientOnlyByName('sodium-neoforge-0.8.13+mc1.21.1.jar'), true);
    assert.equal(isClientOnlyByName('iris-neoforge-1.8.14-beta.1+mc1.21.1.jar'), true);
});

test('HypeServ supplement: ItemPhysic Guns (client addon of client-only ItemPhysic Lite)', () => {
    assert.equal(isClientOnlyByName('itemphysicguns-1.0.3-7686b43.jar'), true);
    assert.equal(isClientOnlyByName('ItemPhysicLite_FORGE_v1.6.13_mc1.20.1.jar'), true);
});
