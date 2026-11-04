import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { log } from './util/logger.js';
import { download, downloadWgetStyle } from './downloadFile.js';
import { unzip } from './unzipModpack.js';
import {
    getModpackSource,
    normalizeProvider,
    CanonicalProvider,
    ModpackSource,
    Provider
} from './getModpackInfo.js';
import { getResolverUrl, getResolverToken } from './resolveModpack.js';
import { downloadManifestMods, ManifestModsReport } from './downloadManifestMods.js';
import {
    downloadModrinthMods,
    moveModrinthOverrides,
    grabModrinthServerJars,
    ModrinthIndex
} from './downloadModrinthMods.js';
import { getLoaderFromManifest, LoaderInfo } from './getForgeOrFabricVersion.js';
import {
    getLoaderFromRunScripts,
    getLoaderFromLibraries
} from './getLoaderFromRunScripts.js';
import { installLoader } from './installLoader.js';
import { ensureStartTarget } from './ensureStartTarget.js';
import { guessLoaderFromMods, loaderFromInstallerJar } from './guessLoader.js';
import { findPackwizPackUrl, runPackwiz } from './packwiz.js';
import { installFtbManifest } from './ftb.js';
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
    resolverUrl: string | false;
    /** Bearer token for modpack-magic (falls back to MODPACK_MAGIC_TOKEN). Never logged. */
    resolverToken: string | false;
    /** Wings mode: keep world dirs (and server.properties) already in the working dir. */
    preserveWorld: boolean;
}

interface InstallPipelineInput {
    filename: string;
    modpackName: string;
    thisDir: string;
    explicitFolderName: string | false;
    update: boolean;
    manifestApiKey: string | false;
    cleanScripts: boolean;
    /** MC version from the resolver, used when the pack itself has no loader info. */
    mcVersionHint: string | null;
}

interface InstallPipelineResult {
    folder: string;
    loader: LoaderInfo | null;
    mods: ManifestModsReport | null;
}

/** Written to <server root>/.hypeserv/modpack.json after a successful install. */
interface InstalledModpackInfo {
    provider: CanonicalProvider;
    projectId: string;
    versionId: string | null;
    mcVersion: string | null;
    loader: string | null;
    installedAt: string;
    /** Manifest installs only: restricted / failed / removed mods, for panel warnings. */
    mods?: ManifestModsReport;
}

export async function runInstaller(opts: InstallerOptions): Promise<void> {
    const {
        provider: rawProvider,
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
    log.info(`Detected OS ${operatingSystem}, arch ${os.arch()}`);

    const thisDir = workingPath || process.cwd();
    process.chdir(thisDir);

    if (!modpackId) {
        log.error('--modpack-id is required.');
        process.exit(1);
    }
    if (!wgetMode && !rawProvider) {
        log.error('--provider is required unless --wget-mode is set.');
        process.exit(1);
    }

    // wget-mode: skip provider detection/parsing — modpackId IS the zip URL.
    const provider: CanonicalProvider = wgetMode ? 'direct' : normalizeProvider(rawProvider!);
    let source: ModpackSource;
    if (wgetMode) {
        log.info(`wget-mode: pulling zip directly from ${modpackId}`);
        source = {
            name: 'Direct_Download',
            downloadUrl: modpackId,
            versionId: null,
            mcVersion: null,
            loader: null
        };
    } else {
        const resolverUrl = getResolverUrl(opts.resolverUrl);
        const resolverToken = getResolverToken(opts.resolverToken);
        if (provider === 'curseforge' || provider === 'modrinth' || provider === 'ftb') {
            log.info(
                `Resolving ${provider} modpack ${modpackId} via ${resolverUrl}` +
                (resolverToken ? ' (with auth token)...' : '...')
            );
        }
        source = await getModpackSource(provider, modpackId, modpackVersion, resolverUrl, resolverToken);
        log.info(
            `Modpack: ${source.name}` +
            (source.versionId ? ` (version ${source.versionId}` : '') +
            (source.mcVersion ? `, MC ${source.mcVersion}` : '') +
            (source.loader ? `, ${source.loader}` : '') +
            (source.versionId ? ')' : '')
        );
        if (source.kind) log.info(`Download kind: ${source.kind}`);
        if (source.kind === 'client-manifest' && !manifestApiKey) {
            log.warn(
                'Pack has no server pack, only a client manifest. ' +
                'Mods are downloaded through the manifest API, which needs --manifest-api-key.'
            );
        }
    }

    if (!source.downloadUrl) {
        log.error('No download URL available, exiting.');
        process.exit(1);
    }

    let result: InstallPipelineResult;
    let modpackName: string;
    if (source.kind === 'ftb-manifest') {
        modpackName = source.name;
        result = await runFtbPipeline({
            manifestUrl: source.downloadUrl,
            folder: path.join(thisDir, explicitFolderName || modpackName.replace(/[:,\s/\\]/g, '_')),
            thisDir,
            update,
            manifestApiKey,
            cleanScripts
        });
    } else {
        const filename = wgetMode
            ? await downloadWgetStyle(source.downloadUrl)
            : await download(source.downloadUrl);
        modpackName = wgetMode
            ? deriveNameFromFilename(filename) || source.name
            : source.name;

        result = await runInstallPipeline({
            filename,
            modpackName,
            thisDir,
            explicitFolderName: explicitFolderName || false,
            update,
            manifestApiKey,
            cleanScripts,
            mcVersionHint: source.mcVersion
        });
    }

    let finalDir = result.folder;
    if (wings) {
        await flattenIntoWorkingDir(result.folder, thisDir, opts.preserveWorld);
        finalDir = thisDir;
    }

    await writeInstalledModpackInfo(finalDir, {
        provider,
        projectId: modpackId,
        versionId: source.versionId,
        mcVersion: source.mcVersion || result.loader?.mcVersion || null,
        loader: source.loader || result.loader?.kind || null,
        installedAt: new Date().toISOString(),
        ...(result.mods ? { mods: result.mods } : {})
    });

    log.info(`Finished downloading and installing modpack ${modpackName}! :)`);
}

async function writeInstalledModpackInfo(
    serverRoot: string,
    info: InstalledModpackInfo
): Promise<void> {
    // Last step of every successful install. The egg script treats a missing
    // file as a failed install, so a write error must fail the run too.
    const file = path.join(serverRoot, '.hypeserv', 'modpack.json');
    await fs.outputJson(file, info, { spaces: 2 });
    log.info(`Wrote install info to ${file}`);
}

/**
 * Move every entry from the install subfolder up to the working directory
 * (wings mode), then remove the now-empty subfolder. Used so the server
 * panel daemon finds files at /mnt/server, not /mnt/server/<modpack>/.
 *
 * With preserveWorld, world dirs and server.properties that already exist in
 * the working dir are kept; the pack's copies are dropped. Otherwise a pack
 * that ships its own world/ would overwrite the player's world on reinstall,
 * and a pack server.properties could point level-name at another folder.
 */
async function flattenIntoWorkingDir(
    installedAt: string,
    workingDir: string,
    preserveWorld: boolean
): Promise<void> {
    if (path.resolve(installedAt) === path.resolve(workingDir)) return;
    log.info(`Wings mode: flattening ${installedAt} -> ${workingDir}`);
    const keep = preserveWorld ? await existingWorldEntries(workingDir) : new Set<string>();
    const entries = await fs.readdir(installedAt);
    for (const entry of entries) {
        const from = path.join(installedAt, entry);
        if (keep.has(entry)) {
            log.info(`Preserving existing ${entry}, skipping the pack's copy.`);
            await fs.remove(from);
            continue;
        }
        const to = path.join(workingDir, entry);
        await fs.move(from, to, { overwrite: true });
    }
    await fs.remove(installedAt);
}

/** World dirs + server.properties currently present in the server root. */
async function existingWorldEntries(serverRoot: string): Promise<Set<string>> {
    let levelName = 'world';
    const propsPath = path.join(serverRoot, 'server.properties');
    if (await fs.pathExists(propsPath)) {
        const props = await fs.readFile(propsPath, 'utf8');
        const match = props.match(/^level-name=(.*)$/m);
        const value = match?.[1]?.trim();
        if (value) levelName = value;
    }
    const candidates = new Set([
        'server.properties',
        'world', 'world_nether', 'world_the_end',
        levelName, `${levelName}_nether`, `${levelName}_the_end`
    ]);
    const present = new Set<string>();
    for (const name of candidates) {
        if (await fs.pathExists(path.join(serverRoot, name))) present.add(name);
    }
    return present;
}

function deriveNameFromFilename(filename: string): string | null {
    const base = path.basename(filename, path.extname(filename));
    if (!base) return null;
    return base.replace(/[:,\s]/g, '_');
}

async function runInstallPipeline(input: InstallPipelineInput): Promise<InstallPipelineResult> {
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

    if (update) await cleanForUpdate(thisDir);

    let modsReport: ManifestModsReport | null = null;
    const packwizUrl = await findPackwizPackUrl(modpackFolderPath);
    if (packwizUrl) {
        await runPackwiz(modpackFolderPath, packwizUrl);
    }

    const manifestPath = path.join(modpackFolderPath, 'manifest.json');
    if ((await fs.pathExists(manifestPath)) && manifestApiKey) {
        log.info('Running manifest installer...');
        const modsDir = path.join(modpackFolderPath, 'mods');
        await fs.ensureDir(modsDir);
        process.chdir(modsDir);
        modsReport = await downloadManifestMods(manifestPath, manifestApiKey);
        process.chdir(modpackFolderPath);

        // CurseForge client packs ship configs etc. in overrides/.
        const overridesPath = path.join(modpackFolderPath, 'overrides');
        if (await fs.pathExists(overridesPath)) {
            log.info(`Moving manifest overrides from ${overridesPath} to ${modpackFolderPath}`);
            await fs.copy(overridesPath, modpackFolderPath, { overwrite: true });
            await fs.remove(overridesPath);
        }
    }

    const modrinthIndex = path.join(modpackFolderPath, 'modrinth.index.json');
    const isMrpack = await fs.pathExists(modrinthIndex);
    if (isMrpack) {
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

    // mrpacks install their loader from modrinth.index.json above.
    let loader = isMrpack ? null : await detectLoader(modpackFolderPath);
    if (!isMrpack && !loader) {
        loader =
            (await loaderFromInstallerJar(modpackFolderPath, input.mcVersionHint)) ||
            (await guessLoaderFromMods(modpackFolderPath, input.mcVersionHint));
    }
    if (isMrpack) {
        // handled by grabModrinthServerJars
    } else if (loader) {
        log.info(
            `Detected ${loader.kind} ${loader.loaderVersion} (MC ${loader.mcVersion}), installing loader...`
        );
        try {
            loader = await installLoader(loader, modpackFolderPath);
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

    await ensureStartTarget(modpackFolderPath);
    await warnIfNoMods(modpackFolderPath);

    if (cleanScripts) await removeStartScripts(modpackFolderPath);

    return { folder: modpackFolderPath, loader, mods: modsReport };
}

async function cleanForUpdate(thisDir: string): Promise<void> {
    log.info('Update mode enabled. Cleaning old mods and libraries...');
    for (const p of ['libraries', 'mods', 'coremods', '.fabric']) {
        const full = path.join(thisDir, p);
        if (await fs.pathExists(full)) {
            log.info(`Deleting ${full}...`);
            await deleteTreeDirectory(full);
        }
    }
}

async function removeStartScripts(dir: string): Promise<void> {
    log.info('Removing startup scripts (.sh / .bat)...');
    for (const e of await fs.readdir(dir)) {
        if (e.endsWith('.sh') || e.endsWith('.bat')) await fs.remove(path.join(dir, e));
    }
}

interface FtbPipelineInput {
    manifestUrl: string;
    folder: string;
    thisDir: string;
    update: boolean;
    manifestApiKey: string | false;
    cleanScripts: boolean;
}

/** FTB packs: files come from the version manifest, the loader from its targets. */
async function runFtbPipeline(input: FtbPipelineInput): Promise<InstallPipelineResult> {
    const { manifestUrl, folder, thisDir, update, manifestApiKey, cleanScripts } = input;
    if (update) await cleanForUpdate(thisDir);
    await fs.ensureDir(folder);

    const ftb = await installFtbManifest(manifestUrl, folder, manifestApiKey);
    let loader = ftb.loader;
    if (loader) {
        log.info(`Installing ${loader.kind} ${loader.loaderVersion} (MC ${loader.mcVersion}) from the FTB manifest...`);
        try {
            loader = await installLoader(loader, folder);
            log.info(`${loader.kind} install finished.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`Loader install failed: ${msg}`);
        }
    } else {
        log.warn('FTB manifest names no mod loader; installing files only.');
    }

    await ensureStartTarget(folder);
    await warnIfNoMods(folder);
    if (cleanScripts) await removeStartScripts(folder);
    return { folder, loader, mods: ftb.mods };
}

/** A modpack install that ends with an empty mods/ folder almost always means the pack content was never fetched. */
async function warnIfNoMods(dir: string): Promise<void> {
    const modsDir = path.join(dir, 'mods');
    const mods = (await fs.pathExists(modsDir))
        ? (await fs.readdir(modsDir)).filter(f => f.endsWith('.jar'))
        : [];
    if (mods.length === 0) {
        log.warn('mods/ is empty after install. The server will start without the pack\'s mods.');
    } else {
        log.info(`${mods.length} mod jars in mods/.`);
    }
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

    // No manifest / variables.txt: fall back to the pack's own start scripts,
    // whose launch command encodes the loader path (kind + MC + loader version).
    const fromScripts = await getLoaderFromRunScripts(modpackFolderPath);
    if (fromScripts) {
        log.info('Loader info source: run script (run.sh / run.bat).');
        return fromScripts;
    }

    // Last resort: a loader already unpacked under libraries/ but no parseable
    // script (the loader is pre-installed; install will be skipped downstream).
    const fromLibraries = await getLoaderFromLibraries(modpackFolderPath);
    if (fromLibraries) {
        log.info('Loader info source: libraries/ scan.');
        return fromLibraries;
    }

    return null;
}
