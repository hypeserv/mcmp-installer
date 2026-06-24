import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import axios from 'axios';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';
import { LoaderInfo } from './getForgeOrFabricVersion.js';

interface FabricInstallerMeta {
    version: string;
    stable: boolean;
}

/**
 * Download + run the appropriate loader installer for serverpack-creator
 * style packs that ship a manifest.json but no loader jar.
 *
 * Supports Forge, NeoForge, and Fabric.
 */
export async function installLoader(
    info: LoaderInfo,
    targetDir: string
): Promise<void> {
    // Many server packs ship the loader pre-installed (their run.sh just
    // launches it). If the loader artifacts are already on disk, skip the
    // download + --installServer step and only ensure the runtime files are
    // in place at the root.
    if (await loaderArtifactsPresent(info, targetDir)) {
        log.info(
            `${info.kind} ${info.loaderVersion} already present in libraries, skipping install.`
        );
        await copyLoaderRuntimeFiles(info, targetDir);
        return;
    }

    switch (info.kind) {
        case 'forge':
            await installForge(info.mcVersion, info.loaderVersion, targetDir);
            break;
        case 'neoforge':
            await installNeoForge(info.mcVersion, info.loaderVersion, targetDir);
            break;
        case 'fabric':
            await installFabric(info.mcVersion, info.loaderVersion, targetDir);
            break;
    }
    await copyLoaderRuntimeFiles(info, targetDir);
}

/**
 * After running the loader installer, make sure the server start command
 * has what it needs at the modpack root:
 *
 *   - Modern Forge / NeoForge (MC 1.17+): server jar is replaced by
 *     libraries/.../unix_args.txt + win_args.txt. Many start scripts call
 *     `java @unix_args.txt`, expecting it at the root. Copy it there.
 *
 *   - Legacy Forge (pre-1.17): installer drops `forge-<ver>.jar` at the root
 *     directly, but some packs put it inside libraries instead. If it's only
 *     in libraries, copy it to the root so `java -jar forge-*.jar` works.
 */
async function copyLoaderRuntimeFiles(info: LoaderInfo, targetDir: string): Promise<void> {
    const libsDir = path.join(targetDir, 'libraries');
    if (!(await fs.pathExists(libsDir))) return;

    const loaderLibDir = resolveLoaderLibDir(info, libsDir);
    if (!loaderLibDir || !(await fs.pathExists(loaderLibDir))) return;

    for (const argFile of ['unix_args.txt', 'win_args.txt']) {
        const src = path.join(loaderLibDir, argFile);
        if (await fs.pathExists(src)) {
            const dest = path.join(targetDir, argFile);
            await fs.copy(src, dest, { overwrite: true });
            log.info(`Copied ${argFile} to modpack root.`);
        }
    }

    const entries = await fs.readdir(loaderLibDir);
    for (const e of entries) {
        if (!/^(forge|neoforge)-.*\.jar$/i.test(e)) continue;
        // Skip the universal/client artifacts that ship without a runnable main.
        if (/-(sources|javadoc|client|slim)\.jar$/i.test(e)) continue;
        const src = path.join(loaderLibDir, e);
        const dest = path.join(targetDir, e);
        if (await fs.pathExists(dest)) continue;
        await fs.copy(src, dest, { overwrite: true });
        log.info(`Copied ${e} to modpack root.`);
    }
}

/**
 * Sanity check: are the loader's runtime artifacts actually on disk?
 *
 * Returns true when the loader is already installed and runnable, so the
 * install step can be skipped. Guards against the case where a pack's run.sh
 * references a loader path that isn't there yet (e.g. a bootstrap script that
 * was meant to install it first) — in that case we still run the installer.
 */
export async function loaderArtifactsPresent(
    info: LoaderInfo,
    targetDir: string
): Promise<boolean> {
    if (info.kind === 'fabric') {
        for (const jar of ['fabric-server-launch.jar', 'fabric-server-launcher.jar']) {
            if (await fs.pathExists(path.join(targetDir, jar))) return true;
        }
        return false;
    }

    const libsDir = path.join(targetDir, 'libraries');
    const loaderLibDir = resolveLoaderLibDir(info, libsDir);
    if (!loaderLibDir || !(await fs.pathExists(loaderLibDir))) return false;

    // Modern (1.17+): the args files are the launch contract.
    for (const argFile of ['unix_args.txt', 'win_args.txt']) {
        if (await fs.pathExists(path.join(loaderLibDir, argFile))) return true;
    }

    // Legacy: a runnable forge/neoforge jar (skip slim/client artifacts).
    for (const e of await fs.readdir(loaderLibDir)) {
        if (!/^(forge|neoforge)-.*\.jar$/i.test(e)) continue;
        if (/-(sources|javadoc|client|slim)\.jar$/i.test(e)) continue;
        return true;
    }
    return false;
}

function resolveLoaderLibDir(info: LoaderInfo, libsDir: string): string | null {
    const { kind, mcVersion, loaderVersion } = info;
    if (kind === 'forge') {
        return path.join(
            libsDir,
            'net',
            'minecraftforge',
            'forge',
            `${mcVersion}-${loaderVersion}`
        );
    }
    if (kind === 'neoforge') {
        if (mcVersion === '1.20.1') {
            return path.join(
                libsDir,
                'net',
                'neoforged',
                'forge',
                `${mcVersion}-${loaderVersion}`
            );
        }
        return path.join(libsDir, 'net', 'neoforged', 'neoforge', loaderVersion);
    }
    // Fabric installer drops `fabric-server-launch.jar` at the root already.
    return null;
}

async function installForge(
    mcVersion: string,
    loaderVersion: string,
    targetDir: string
): Promise<void> {
    const fullVer = `${mcVersion}-${loaderVersion}`;
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
    log.info(`Downloading Forge installer ${fullVer}...`);

    const dest = await downloadInto(url, targetDir, 'forge-installer.jar');
    await runJavaInstaller(dest, ['--installServer'], targetDir);
    await cleanupInstaller(dest);
}

async function installNeoForge(
    mcVersion: string,
    loaderVersion: string,
    targetDir: string
): Promise<void> {
    // NeoForge has two maven layouts:
    //   - 1.20.1 only: net/neoforged/forge/<mc>-<loader>/forge-<mc>-<loader>-installer.jar
    //   - 1.20.2+:     net/neoforged/neoforge/<loader>/neoforge-<loader>-installer.jar
    //                  (loader version embeds the MC version, e.g. 20.4.x → 1.20.4)
    let url: string;
    if (mcVersion === '1.20.1') {
        const fullVer = `${mcVersion}-${loaderVersion}`;
        url = `https://maven.neoforged.net/releases/net/neoforged/forge/${fullVer}/forge-${fullVer}-installer.jar`;
    } else {
        url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    }
    log.info(`Downloading NeoForge installer ${loaderVersion} (MC ${mcVersion})...`);

    const dest = await downloadInto(url, targetDir, 'neoforge-installer.jar');
    await runJavaInstaller(dest, ['--installServer'], targetDir);
    await cleanupInstaller(dest);
}

async function installFabric(
    mcVersion: string,
    loaderVersion: string,
    targetDir: string
): Promise<void> {
    const installerVersion = await getLatestFabricInstallerVersion();
    const url = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
    log.info(`Downloading Fabric installer ${installerVersion}...`);

    const dest = await downloadInto(url, targetDir, 'fabric-installer.jar');
    await runJavaInstaller(
        dest,
        ['server', '-mcversion', mcVersion, '-loader', loaderVersion, '-downloadMinecraft'],
        targetDir
    );
    await cleanupInstaller(dest);
}

async function getLatestFabricInstallerVersion(): Promise<string> {
    try {
        const res = await axios.get<FabricInstallerMeta[]>(
            'https://meta.fabricmc.net/v2/versions/installer',
            { timeout: 30000 }
        );
        const stable = res.data.find(v => v.stable) || res.data[0];
        if (stable?.version) return stable.version;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Fabric installer meta lookup failed: ${msg}. Falling back to pinned version.`);
    }
    return '1.0.1';
}

async function downloadInto(
    url: string,
    targetDir: string,
    finalName: string
): Promise<string> {
    const prevDir = process.cwd();
    process.chdir(targetDir);
    try {
        const file = await download(url);
        const src = path.join(targetDir, file);
        const dest = path.join(targetDir, finalName);
        if (src !== dest) {
            await fs.move(src, dest, { overwrite: true });
        }
        return dest;
    } finally {
        process.chdir(prevDir);
    }
}

async function cleanupInstaller(installerPath: string): Promise<void> {
    await fs.remove(installerPath).catch(() => undefined);
    const sideLog = `${installerPath}.log`;
    await fs.remove(sideLog).catch(() => undefined);
}

async function runJavaInstaller(
    jar: string,
    args: string[],
    cwd: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        log.info(`Running: java -jar ${path.basename(jar)} ${args.join(' ')}`);
        const proc = spawn('java', ['-jar', jar, ...args], {
            cwd,
            stdio: 'inherit'
        });
        proc.on('exit', (code: number | null) => {
            if (code === 0) {
                resolve();
            } else {
                log.warn(`Loader installer exited with code ${code}, continuing.`);
                resolve();
            }
        });
        proc.on('error', reject);
    });
}
