import path from 'node:path';
import fs from 'fs-extra';
import axios from 'axios';
import yauzl from 'yauzl';
import { log } from './util/logger.js';
import { LoaderInfo, ModLoaderKind } from './getForgeOrFabricVersion.js';

/**
 * Last resort for packs that ship mods but no loader and no loader metadata
 * (e.g. RLCraft's server pack): infer the loader kind from the mods'
 * own metadata files, and take that loader's recommended/latest version for
 * the pack's Minecraft version.
 */
export async function guessLoaderFromMods(dir: string, mcVersion: string | null): Promise<LoaderInfo | null> {
    if (!mcVersion) return null;
    const kind = await detectLoaderKindFromMods(path.join(dir, 'mods'));
    if (!kind) return null;
    const loaderVersion = await latestLoaderVersion(kind, mcVersion);
    if (!loaderVersion) {
        log.warn(`Mods look like ${kind}, but no ${kind} version was found for MC ${mcVersion}.`);
        return null;
    }
    log.warn(
        `Pack has no loader info. Inferred ${kind} from the mods' metadata and picked ` +
        `${kind} ${loaderVersion} (recommended/latest for MC ${mcVersion}).`
    );
    return { kind, mcVersion, loaderVersion };
}

/**
 * Packs like SkyFactory 4 ship the loader installer instead of the loader:
 * forge-<mc>-<ver>-installer.jar / neoforge-<ver>-installer.jar. Its name
 * gives the exact version.
 */
export async function loaderFromInstallerJar(dir: string, mcVersion: string | null): Promise<LoaderInfo | null> {
    for (const f of await fs.readdir(dir)) {
        const forge = /^forge-(1\.\d+(?:\.\d+)?)-([\d.]+)-installer\.jar$/i.exec(f);
        if (forge) {
            log.info(`Loader info source: ${f}`);
            return { kind: 'forge', mcVersion: forge[1], loaderVersion: forge[2] };
        }
        const neo = /^neoforge-([\d.]+(?:-beta)?)-installer\.jar$/i.exec(f);
        if (neo) {
            const mc = mcVersion || `1.${neo[1].split('.').slice(0, 2).join('.')}`.replace(/\.0$/, '');
            log.info(`Loader info source: ${f}`);
            return { kind: 'neoforge', mcVersion: mc, loaderVersion: neo[1] };
        }
    }
    return null;
}

const MARKERS: [string, ModLoaderKind][] = [
    ['META-INF/neoforge.mods.toml', 'neoforge'],
    ['fabric.mod.json', 'fabric'],
    ['META-INF/mods.toml', 'forge'],
    ['mcmod.info', 'forge']
];

/** Majority vote over the metadata files of up to `sample` mod jars. */
export async function detectLoaderKindFromMods(modsDir: string, sample = 40): Promise<ModLoaderKind | null> {
    if (!(await fs.pathExists(modsDir))) return null;
    const jars = (await fs.readdir(modsDir)).filter(f => f.endsWith('.jar')).slice(0, sample);
    const votes: Record<ModLoaderKind, number> = { forge: 0, neoforge: 0, fabric: 0 };
    for (const jar of jars) {
        const names = await listZipEntries(path.join(modsDir, jar)).catch(() => new Set<string>());
        const hit = MARKERS.find(([file]) => names.has(file));
        if (hit) votes[hit[1]]++;
    }
    const [best, count] = (Object.entries(votes) as [ModLoaderKind, number][]).sort((a, b) => b[1] - a[1])[0];
    return count > 0 ? best : null;
}

async function latestLoaderVersion(kind: ModLoaderKind, mc: string): Promise<string | null> {
    try {
        if (kind === 'forge') {
            const res = await axios.get<{ promos: Record<string, string> }>(
                'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
                { timeout: 30000 }
            );
            return res.data.promos[`${mc}-recommended`] || res.data.promos[`${mc}-latest`] || null;
        }
        if (kind === 'fabric') {
            const res = await axios.get<{ loader: { version: string; stable: boolean } }[]>(
                `https://meta.fabricmc.net/v2/versions/loader/${mc}`,
                { timeout: 30000 }
            );
            const stable = res.data.find(v => v.loader.stable) || res.data[0];
            return stable?.loader.version || null;
        }
        // NeoForge versions encode the MC version: 1.21.1 -> 21.1.x
        const res = await axios.get<{ versions: string[] }>(
            'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
            { timeout: 30000 }
        );
        const prefix = mc.replace(/^1\./, '') + '.';
        const matching = res.data.versions.filter(v => v.startsWith(prefix) && !/beta|alpha/i.test(v));
        return matching[matching.length - 1] || null;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Looking up ${kind} versions for MC ${mc} failed: ${msg}`);
        return null;
    }
}

function listZipEntries(file: string): Promise<Set<string>> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err || !zip) return reject(err);
            const names = new Set<string>();
            zip.on('entry', (e: yauzl.Entry) => { names.add(e.fileName); zip.readEntry(); });
            zip.on('end', () => resolve(names));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}
