import fs from 'fs-extra';
import path from 'node:path';
import axios from 'axios';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';
import { ModProgress } from './util/modProgress.js';
import { installLoader } from './installLoader.js';
import { LoaderInfo } from './getForgeOrFabricVersion.js';

export interface ModrinthFileEntry {
    path: string;
    downloads?: string[];
    env?: { client?: string; server?: string };
}

export interface ModrinthDependencies {
    minecraft?: string;
    'fabric-loader'?: string;
    forge?: string;
    neoforge?: string;
    [key: string]: string | undefined;
}

export interface ModrinthIndex {
    files?: ModrinthFileEntry[];
    dependencies?: ModrinthDependencies;
}

interface MojangVersionEntry {
    id: string;
    url: string;
}

interface MojangVersionManifest {
    versions: MojangVersionEntry[];
}

interface MojangVersionInfo {
    downloads?: { server?: { url?: string } };
}

/**
 * Download every file listed in modrinth.index.json to its `path`, relative
 * to the pack root (the index's folder). Client-only files
 * (env.server = "unsupported") are skipped.
 */
export async function downloadModrinthMods(indexPath: string): Promise<void> {
    const raw = await fs.readFile(indexPath, 'utf8');
    const data = JSON.parse(raw) as ModrinthIndex;
    const root = path.resolve(path.dirname(indexPath));
    const files = data.files || [];

    log.info(`Downloading ${files.length} files from modrinth.index.json...`);
    const progress = new ModProgress(files.filter(f => f.env?.server !== 'unsupported').length);
    const prev = process.cwd();
    try {
        for (const mod of files) {
            if (mod.env?.server === 'unsupported') {
                progress.skip();
                continue;
            }
            const name = path.basename(mod.path);
            const dest = path.resolve(root, mod.path);
            if (!dest.startsWith(root + path.sep)) {
                progress.fail(name, `path outside the pack: ${mod.path}`);
                continue;
            }
            const url = mod.downloads?.[0];
            if (!url) {
                progress.fail(name, 'no download URL');
                continue;
            }
            try {
                await fs.ensureDir(path.dirname(dest));
                process.chdir(path.dirname(dest));
                await download(url, { fileName: name, quiet: true });
                progress.ok(name);
            } catch (err) {
                progress.fail(name, err instanceof Error ? err.message : String(err));
            }
        }
    } finally {
        process.chdir(prev);
        progress.finish();
    }
}

export async function moveModrinthOverrides(
    overridesPath: string,
    targetRoot: string
): Promise<void> {
    if (!(await fs.pathExists(overridesPath))) return;
    log.info(`Moving Modrinth overrides from ${overridesPath} to ${targetRoot}`);
    await fs.copy(overridesPath, targetRoot, { overwrite: true });
}

export async function grabModrinthServerJars(
    dependencies: ModrinthDependencies | undefined,
    targetDir: string
): Promise<void> {
    const dependencyNames = Object.keys(dependencies || {});
    const mcVersion = dependencies?.minecraft;

    if (!mcVersion) {
        log.warn('No minecraft dependency, skipping server jar download.');
        return;
    }

    try {
        const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
        const manifest = (await axios.get<MojangVersionManifest>(manifestUrl, { timeout: 60000 })).data;
        const version = manifest.versions.find(v => v.id === mcVersion);
        if (version) {
            const versionInfo = (await axios.get<MojangVersionInfo>(version.url)).data;
            const serverUrl = versionInfo.downloads?.server?.url;
            if (serverUrl) {
                log.info(`Downloading vanilla server ${mcVersion}...`);
                const vanillaFile = await download(serverUrl);
                await fs.move(vanillaFile, path.join(targetDir, 'vanilla.jar'), { overwrite: true });
            }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Error downloading vanilla server jar: ${message}`);
    }

    const loader = resolveModrinthLoader(dependencies, dependencyNames, mcVersion);
    if (loader) {
        log.info(`Found ${loader.kind} ${loader.loaderVersion}, installing loader...`);
        try {
            await installLoader(loader, targetDir);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`Loader install failed: ${msg}`);
        }
    }
}

function resolveModrinthLoader(
    dependencies: ModrinthDependencies | undefined,
    dependencyNames: string[],
    mcVersion: string
): LoaderInfo | null {
    if (!dependencies) return null;
    if (dependencyNames.includes('fabric-loader') && dependencies['fabric-loader']) {
        return { kind: 'fabric', mcVersion, loaderVersion: dependencies['fabric-loader'] };
    }
    if (dependencyNames.includes('neoforge') && dependencies.neoforge) {
        return { kind: 'neoforge', mcVersion, loaderVersion: dependencies.neoforge };
    }
    if (dependencyNames.includes('forge') && dependencies.forge) {
        return { kind: 'forge', mcVersion, loaderVersion: dependencies.forge };
    }
    return null;
}
