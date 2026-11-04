import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import yazl from 'yazl';
import { ensureStartTarget, readMainClass } from '../src/ensureStartTarget.js';

const FABRIC = 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher';
const VANILLA = 'net.minecraft.bundler.Main';
const FORGE = 'net.minecraftforge.fml.relauncher.ServerLaunchWrapper';

function jar(file: string, mainClass: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const z = new yazl.ZipFile();
        z.addBuffer(Buffer.from(`Manifest-Version: 1.0\r\nMain-Class: ${mainClass}\r\n\r\n`), 'META-INF/MANIFEST.MF');
        z.end();
        z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

async function tmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-start-'));
}

test('fabric: vanilla server.jar is swapped for the Fabric launcher', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'server.jar'), VANILLA);
    await jar(path.join(dir, 'fabric-server-launch.jar'), FABRIC);

    await ensureStartTarget(dir);

    assert.equal(await readMainClass(path.join(dir, 'server.jar')), FABRIC);
    assert.equal(await readMainClass(path.join(dir, 'vanilla.jar')), VANILLA);
    assert.match(await fs.readFile(path.join(dir, 'fabric-server-launcher.properties'), 'utf8'), /^serverJar=vanilla\.jar$/m);
    await fs.remove(dir);
});

test('fabric: keeps other launcher properties and an existing vanilla.jar', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'vanilla.jar'), VANILLA);
    await jar(path.join(dir, 'fabric-server-launch.jar'), FABRIC);
    await fs.writeFile(path.join(dir, 'fabric-server-launcher.properties'), 'launch.mainClass=x\nserverJar=server.jar\n');

    await ensureStartTarget(dir);

    assert.equal(await readMainClass(path.join(dir, 'server.jar')), FABRIC);
    assert.equal(
        await fs.readFile(path.join(dir, 'fabric-server-launcher.properties'), 'utf8'),
        'launch.mainClass=x\nserverJar=vanilla.jar\n'
    );
    await fs.remove(dir);
});

test('fabric: an existing launcher server.jar is left alone', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'server.jar'), FABRIC);
    await jar(path.join(dir, 'fabric-server-launch.jar'), FABRIC);

    await ensureStartTarget(dir);

    assert.equal(await fs.pathExists(path.join(dir, 'fabric-server-launcher.properties')), false);
    await fs.remove(dir);
});

test('legacy forge: forge jar is copied to server.jar, vanilla moved aside', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'server.jar'), VANILLA);
    await jar(path.join(dir, 'forge-1.12.2-14.23.5.2860.jar'), FORGE);
    await jar(path.join(dir, 'forge-1.12.2-14.23.5.2860-installer.jar'), 'net.minecraftforge.installer.SimpleInstaller');

    await ensureStartTarget(dir);

    assert.equal(await readMainClass(path.join(dir, 'server.jar')), FORGE);
    assert.equal(await readMainClass(path.join(dir, 'vanilla.jar')), VANILLA);
    await fs.remove(dir);
});

test('unix_args.txt wins and nothing is touched', async () => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'unix_args.txt'), '-cp x');
    await jar(path.join(dir, 'fabric-server-launch.jar'), FABRIC);

    await ensureStartTarget(dir);

    assert.equal(await fs.pathExists(path.join(dir, 'server.jar')), false);
    await fs.remove(dir);
});

test('custom server.jar (e.g. ServerStarter) is kept', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'server.jar'), 'atm.bigbird.ServerStarter');

    await ensureStartTarget(dir);

    assert.equal(await readMainClass(path.join(dir, 'server.jar')), 'atm.bigbird.ServerStarter');
    await fs.remove(dir);
});

test('packwiz: pack.toml URL is found with variable expansion', async () => {
    const { extractPackTomlUrl } = await import('../src/packwiz.js');
    const script = [
        'FORGE_VERSION="1.20.1-47.4.10"',
        'PACK_TAG="v1.14.5"',
        '# java -jar packwiz-installer-bootstrap.jar https://example.com/old/pack.toml',
        'java -jar packwiz-installer-bootstrap.jar -g -s server https://raw.githubusercontent.com/GregTechCEu/GregTech-Modern-Community-Pack/refs/tags/$PACK_TAG/pack.toml'
    ].join('\n');
    assert.equal(
        extractPackTomlUrl(script),
        'https://raw.githubusercontent.com/GregTechCEu/GregTech-Modern-Community-Pack/refs/tags/v1.14.5/pack.toml'
    );
    assert.equal(
        extractPackTomlUrl('PACK_URL="https://x.dev/${PACK}/pack.toml"\nPACK=a\njava -jar packwiz-installer-bootstrap.jar "$PACK_URL"'),
        'https://x.dev/a/pack.toml'
    );
    assert.equal(extractPackTomlUrl('java -jar server.jar'), null);
});

test('legacy forge: the newest runnable forge jar wins', async () => {
    const dir = await tmp();
    await jar(path.join(dir, 'forge-1.16.5-36.2.20.jar'), 'old.Main');
    await jar(path.join(dir, 'forge-1.16.5-36.2.34.jar'), FORGE);

    await ensureStartTarget(dir);

    assert.equal(await readMainClass(path.join(dir, 'server.jar')), FORGE);
    await fs.remove(dir);
});
