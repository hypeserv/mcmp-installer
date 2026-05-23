import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { spawn } from 'node:child_process';
import { log } from './util/logger.js';
import { download, downloadWgetStyle } from './downloadFile.js';
import { unzip } from './unzipModpack.js';
import {
    getServerModpackUrl,
    getModpackMinecraftVersion,
    Provider,
    ModpackUrls
} from './getModpackInfo.js';
import { downloadManifestMods } from './downloadManifestMods.js';
import {
    downloadModrinthMods,
    moveModrinthOverrides,
    grabModrinthServerJars,
    ModrinthIndex
} from './downloadModrinthMods.js';
import { getLoaderFromManifest, LoaderInfo } from './getForgeOrFabricVersion.js';
import { installLoader } from './installLoader.js';
import {
    parseVariablesTxt,
    variablesToLoaderInfo
} from './parseVariablesTxt.js';
import {
    upOneDirectory,
    deleteDirectory,
    deleteTreeDirectory
} from './util/fsHelpers.js';

export interface InstallerOptions {
    provider?: Provider;
    modpackId: string;
    modpackVersion: string | false;
    wings: boolean;
    cleanScripts: boolean;
    update: boolean;
    folderName: string | false;
    workingPath: string | false;
    manifestApiKey: string | false;
    wgetMode: boolean;
}

interface InstallPipelineInput {
    filename: string;
    modpackName: string;
    thisDir: string;
    explicitFolderName: string | false;
    update: boolean;
    manifestApiKey: string | false;
    cleanScripts: boolean;
}

export async function runInstaller(opts: InstallerOptions): Promise<void> {
    const {
        provider,
        modpackId,
        modpackVersion,
        wings,
        cleanScripts,
        update,
        folderName: explicitFolderName,
        workingPath,
        manifestApiKey,
        wgetMode
    } = opts;

    const operatingSystem = os.platform().startsWith('win') ? 'Windows' : 'Linux';
    const architecture = os.arch();
    log.info(`Detected OS ${operatingSystem}, arch ${architecture}`);

    const thisDir = workingPath || process.cwd();
    process.chdir(thisDir);

    // wget-mode: skip provider detection/parsing — modpackId IS the zip URL.
    if (wgetMode) {
        if (!modpackId) {
            log.error('wget-mode requires --modpack-id to be a direct zip URL.');
            process.exit(1);
        }
        log.info(`wget-mode: pulling zip directly from ${modpackId}`);
        const filename = await downloadWgetStyle(modpackId);
        const modpackName = deriveNameFromFilename(filename) || 'Direct_Download';

        const installedAt = await runInstallPipeline({
            filename,
            modpackName,
            thisDir,
            explicitFolderName: explicitFolderName || false,
            update,
            manifestApiKey,
            cleanScripts
        });
        if (wings) {
            await flattenIntoWorkingDir(installedAt, thisDir);
        }
        log.info(`Finished downloading and installing modpack ${modpackName}! :)`);
        return;
    }

    if (!provider) {
        log.error('--provider is required unless --wget-mode is set.');
        process.exit(1);
    }
    if (!modpackId) {
        log.error('--modpack-id is required.');
        process.exit(1);
    }

    let minecraftVersion: string;
    if (['curse', 'technic', 'ftb', 'modrinth'].includes(provider)) {
        const v = await getModpackMinecraftVersion(provider, modpackId);
        minecraftVersion = v || 'unknown';
    } else {
        minecraftVersion = 'unknown';
    }

    const result = await getServerModpackUrl(
        provider,
        modpackId,
        modpackVersion,
        operatingSystem,
        architecture
    );

    const [modpackName, modpackUrls]: [string, ModpackUrls, string] = result;

    if (!modpackName) {
        log.error('Modpack info not provided. Exiting.');
        process.exit(1);
    }

    log.info(`Modpack: ${modpackName} (MC ${minecraftVersion})`);
    log.info(modpackUrls);

    const downloadUrl = pickDownloadUrl(modpackUrls, modpackName);
    if (!downloadUrl) {
        log.error('No download URL available, exiting.');
        process.exit(1);
    }

    // FTB ships an executable installer binary, not a zip.
    if (provider === 'ftb') {
        const ftbFile = await downloadWgetStyle(downloadUrl);
        await runExecutable(ftbFile, thisDir);
        await fs.remove(ftbFile);
        log.info('Finished running FTB server install binary.');
        return;
    }

    const filename = await download(downloadUrl);
    const installedAt = await runInstallPipeline({
        filename,
        modpackName,
        thisDir,
        explicitFolderName: explicitFolderName || false,
        update,
        manifestApiKey,
        cleanScripts
    });
    if (wings) {
        await flattenIntoWorkingDir(installedAt, thisDir);
    }
    log.info(`Finished downloading and installing modpack ${modpackName}! :)`);
}

/**
 * Move every entry from the install subfolder up to the working directory
 * (wings mode), then remove the now-empty subfolder. Used so the server
 * panel daemon finds files at /mnt/server, not /mnt/server/<modpack>/.
 */
async function flattenIntoWorkingDir(installedAt: string, workingDir: string): Promise<void> {
    if (path.resolve(installedAt) === path.resolve(workingDir)) return;
    log.info(`Wings mode: flattening ${installedAt} -> ${workingDir}`);
    const entries = await fs.readdir(installedAt);
    for (const entry of entries) {
        const from = path.join(installedAt, entry);
        const to = path.join(workingDir, entry);
        await fs.move(from, to, { overwrite: true });
    }
    await fs.remove(installedAt);
}

function pickDownloadUrl(modpackUrls: ModpackUrls, modpackName: string): string | null {
    if (modpackUrls.SpecifiedVersion) {
        log.info(`Downloading specified version of ${modpackName}...`);
        return modpackUrls.SpecifiedVersion;
    }
    if (modpackUrls.LatestReleaseServerpack) {
        log.info(`Downloading latest release serverpack of ${modpackName}...`);
        return modpackUrls.LatestReleaseServerpack;
    }
    if (modpackUrls.LatestBetaServerpack) {
        log.info(`Downloading latest beta serverpack of ${modpackName}...`);
        return modpackUrls.LatestBetaServerpack;
    }
    if (modpackUrls.LatestAlphaServerpack) {
        log.info(`Downloading latest alpha serverpack of ${modpackName}...`);
        return modpackUrls.LatestAlphaServerpack;
    }
    if (modpackUrls.LatestReleaseNonServerpack) {
        log.info(`Downloading latest non-serverpack of ${modpackName}...`);
        return modpackUrls.LatestReleaseNonServerpack;
    }
    return null;
}

function deriveNameFromFilename(filename: string): string | null {
    const base = path.basename(filename, path.extname(filename));
    if (!base) return null;
    return base.replace(/[:,\s]/g, '_');
}

async function runInstallPipeline(input: InstallPipelineInput): Promise<string> {
    const {
        filename,
        modpackName,
        thisDir,
        explicitFolderName,
        update,
        manifestApiKey,
        cleanScripts
    } = input;

    log.info('Extracting downloaded modpack archive...');
    const fileExt = path.extname(filename);
    const extractedFolderName = await unzip(
        filename,
        modpackName,
        fileExt,
        thisDir,
        explicitFolderName || false
    );
    const modpackFolderPath = path.join(thisDir, extractedFolderName);

    let existingSubdir: string | null = null;
    for (const name of await fs.readdir(modpackFolderPath)) {
        const full = path.join(modpackFolderPath, name);
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
            const inner = await fs.readdir(full);
            if (
                inner.some(
                    f => f === 'mods' || f.endsWith('.sh') || f.endsWith('.bat')
                )
            ) {
                existingSubdir = full;
                break;
            }
        }
    }

    if (existingSubdir) {
        log.info('Found nested folder, moving contents to parent directory...');
        const subfolderName = path.basename(existingSubdir);
        await upOneDirectory(modpackFolderPath, subfolderName);
        await deleteDirectory(existingSubdir);
    }

    if (update) {
        log.info('Update mode enabled. Cleaning old mods and libraries...');
        const patterns = ['libraries', 'mods', 'coremods', '.fabric'];
        for (const p of patterns) {
            const full = path.join(thisDir, p);
            if (await fs.pathExists(full)) {
                log.info(`Deleting ${full}...`);
                await deleteTreeDirectory(full);
            }
        }
    }

    const manifestPath = path.join(modpackFolderPath, 'manifest.json');
    if ((await fs.pathExists(manifestPath)) && manifestApiKey) {
        log.info('Running manifest installer...');
        const modsDir = path.join(modpackFolderPath, 'mods');
        await fs.ensureDir(modsDir);
        process.chdir(modsDir);
        await downloadManifestMods(manifestPath, manifestApiKey);
        process.chdir(modpackFolderPath);
    }

    const modrinthIndex = path.join(modpackFolderPath, 'modrinth.index.json');
    if (await fs.pathExists(modrinthIndex)) {
        log.info('Running Modrinth installer logic...');
        const modsDir = path.join(modpackFolderPath, 'mods');
        await fs.ensureDir(modsDir);
        process.chdir(modsDir);
        await downloadModrinthMods(modrinthIndex);
        process.chdir(modpackFolderPath);

        const overridesPath = path.join(modpackFolderPath, 'overrides');
        if (await fs.pathExists(overridesPath)) {
            await moveModrinthOverrides(overridesPath, modpackFolderPath);
        }

        const indexRaw = await fs.readFile(modrinthIndex, 'utf8');
        const indexData = JSON.parse(indexRaw) as ModrinthIndex;
        await grabModrinthServerJars(indexData.dependencies, modpackFolderPath);
    }

    const loader = await detectLoader(modpackFolderPath);
    if (loader) {
        log.info(
            `Detected ${loader.kind} ${loader.loaderVersion} (MC ${loader.mcVersion}), installing loader...`
        );
        try {
            await installLoader(loader, modpackFolderPath);
            log.info(`${loader.kind} install finished.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`Loader install failed: ${msg}`);
        }
    } else {
        log.warn(
            'No loader info found (no manifest.json / variables.txt with loader fields). ' +
            'If this pack needs Forge/NeoForge/Fabric, run its start script — it may bootstrap the loader itself.'
        );
    }

    if (cleanScripts) {
        log.info('Removing startup scripts (.sh / .bat)...');
        const entries = await fs.readdir(modpackFolderPath);
        for (const e of entries) {
            if (e.endsWith('.sh') || e.endsWith('.bat')) {
                await fs.remove(path.join(modpackFolderPath, e));
            }
        }
    }

    return modpackFolderPath;
}

/**
 * Resolve loader info from any supported source inside the modpack folder.
 * Tries Curseforge-style manifest.json first, then serverpack-creator /
 * ServerStarter style variables.txt.
 */
async function detectLoader(modpackFolderPath: string): Promise<LoaderInfo | null> {
    const manifestPath = path.join(modpackFolderPath, 'manifest.json');
    if (await fs.pathExists(manifestPath)) {
        const fromManifest = await getLoaderFromManifest(manifestPath);
        if (fromManifest) {
            log.info('Loader info source: manifest.json');
            return fromManifest;
        }
        log.info('manifest.json present but no primary loader entry found.');
    }

    const variablesPath = path.join(modpackFolderPath, 'variables.txt');
    if (await fs.pathExists(variablesPath)) {
        const vars = await parseVariablesTxt(variablesPath);
        const fromVars = variablesToLoaderInfo(vars);
        if (fromVars) {
            log.info('Loader info source: variables.txt');
            return fromVars;
        }
        log.info(
            `variables.txt present but missing loader fields ` +
            `(MINECRAFT_VERSION=${vars.mcVersion || '?'}, ` +
            `MODLOADER=${vars.modloader || '?'}, ` +
            `MODLOADER_VERSION=${vars.modloaderVersion || '?'}).`
        );
    }

    return null;
}

async function runExecutable(filename: string, cwd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const proc = spawn(filename, {
            cwd,
            shell: true,
            stdio: 'inherit'
        });
        proc.on('exit', (code: number | null) => {
            if (code === 0) resolve();
            else {
                log.warn(`Installer exited with code ${code}, continuing.`);
                resolve();
            }
        });
        proc.on('error', reject);
    });
}
