import path from 'node:path';
import fs from 'fs-extra';
import yauzl from 'yauzl';
import { log } from './util/logger.js';
import { compareVersions } from './installLoader.js';

const FABRIC_LAUNCHER_MAIN = 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher';
const VANILLA_MAINS = new Set(['net.minecraft.bundler.Main', 'net.minecraft.server.MinecraftServer', 'net.minecraft.server.Main']);

/**
 * The panel starts servers with `java @unix_args.txt` when that file exists,
 * otherwise `java -jar server.jar` (egg variable SERVER_JARFILE). Make sure
 * the install leaves one of those at the root, and that server.jar launches
 * the loader rather than plain vanilla.
 */
export async function ensureStartTarget(root: string): Promise<void> {
    if (await fs.pathExists(path.join(root, 'unix_args.txt'))) {
        log.info('Start target: @unix_args.txt');
        return;
    }

    const serverJar = path.join(root, 'server.jar');
    const serverMain = await readMainClass(serverJar);

    // Fabric: the installer's -downloadMinecraft writes the vanilla jar as
    // server.jar and the loader as fabric-server-launch.jar. Swap them so
    // `-jar server.jar` starts Fabric, which then loads vanilla.jar.
    const fabricLauncher = path.join(root, 'fabric-server-launch.jar');
    if (await fs.pathExists(fabricLauncher)) {
        if (serverMain === FABRIC_LAUNCHER_MAIN) {
            log.info('Start target: server.jar (Fabric launcher)');
            return;
        }
        const vanillaJar = path.join(root, 'vanilla.jar');
        if (serverMain && VANILLA_MAINS.has(serverMain)) {
            await fs.move(serverJar, vanillaJar, { overwrite: true });
        }
        if (!(await fs.pathExists(vanillaJar))) {
            log.warn('Fabric launcher found but no vanilla server jar; Fabric will fail to start.');
        }
        await setFabricServerJar(root, 'vanilla.jar');
        await fs.copy(fabricLauncher, serverJar, { overwrite: true });
        log.info('Start target: server.jar (Fabric launcher, vanilla in vanilla.jar)');
        return;
    }

    // Legacy Forge (pre-1.17): the loader is a runnable forge-*.jar at the root.
    const forgeJar = await findLegacyForgeJar(root);
    if (forgeJar) {
        if (serverMain && !VANILLA_MAINS.has(serverMain)) {
            log.info(`Start target: server.jar (${serverMain})`);
            return;
        }
        if (serverMain) {
            // A vanilla server.jar would shadow Forge. Keep it under a neutral name.
            await fs.move(serverJar, path.join(root, 'vanilla.jar'), { overwrite: true });
        }
        await fs.copy(path.join(root, forgeJar), serverJar, { overwrite: true });
        log.info(`Start target: server.jar (copy of ${forgeJar})`);
        return;
    }

    if (serverMain) {
        log.info(`Start target: server.jar (${serverMain})`);
        return;
    }
    log.warn(
        'No start target found: neither unix_args.txt nor server.jar exists at the server root. ' +
        'The panel start command (java -jar server.jar) will fail unless SERVER_JARFILE is changed.'
    );
}

async function findLegacyForgeJar(root: string): Promise<string | null> {
    const jars = (await fs.readdir(root)).filter(
        f => /^forge-.*\.jar$/i.test(f) && !/-(installer|sources|javadoc|client|slim|shim)\.jar$/i.test(f)
    );
    if (!jars.length) return null;
    // Newest version first (a pack can ship an old Forge next to the one we installed).
    jars.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
    for (const jar of jars) {
        const main = await readMainClass(path.join(root, jar));
        if (main && !VANILLA_MAINS.has(main)) return jar;
    }
    return null;
}

function versionOf(jar: string): string {
    return jar.replace(/^forge-/i, '').replace(/(-universal)?\.jar$/i, '').split('-').slice(1).join('-');
}

async function setFabricServerJar(root: string, jarName: string): Promise<void> {
    const file = path.join(root, 'fabric-server-launcher.properties');
    const lines = (await fs.pathExists(file))
        ? (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(l => l && !/^serverJar=/.test(l))
        : [];
    lines.push(`serverJar=${jarName}`);
    await fs.writeFile(file, lines.join('\n') + '\n');
}

/** Main-Class from a jar's manifest, or null if the jar is missing/unreadable. */
export async function readMainClass(jar: string): Promise<string | null> {
    if (!(await fs.pathExists(jar))) return null;
    try {
        const manifest = await readZipEntry(jar, 'META-INF/MANIFEST.MF');
        if (!manifest) return null;
        // Manifest lines wrap at 72 bytes with a leading space on continuations.
        const unwrapped = manifest.replace(/\r?\n /g, '');
        const match = unwrapped.match(/^Main-Class:\s*(\S+)/m);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

function readZipEntry(zipPath: string, name: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err || !zip) return reject(err);
            let found = false;
            zip.on('error', reject);
            zip.on('end', () => { if (!found) resolve(null); });
            zip.on('entry', (entry: yauzl.Entry) => {
                if (entry.fileName !== name) return zip.readEntry();
                found = true;
                zip.openReadStream(entry, (e, stream) => {
                    if (e || !stream) { zip.close(); return reject(e); }
                    const chunks: Buffer[] = [];
                    stream.on('data', (c: Buffer) => chunks.push(c));
                    stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
                    stream.on('error', reject);
                });
            });
            zip.readEntry();
        });
    });
}
