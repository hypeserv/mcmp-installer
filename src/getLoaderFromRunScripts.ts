import path from 'node:path';
import fs from 'fs-extra';
import { LoaderInfo, ModLoaderKind } from './getForgeOrFabricVersion.js';

/**
 * Start scripts a server pack might ship. Forge/NeoForge installers emit
 * run.sh/run.bat; other tooling uses start*/launch* variants.
 */
const RUN_SCRIPT_NAMES = [
    'run.sh',
    'run.bat',
    'start.sh',
    'start.bat',
    'startserver.sh',
    'startserver.bat',
    'server-start.sh',
    'server_start.sh',
    'launch.sh',
    'launch.bat'
];

// Modern Forge/NeoForge (MC 1.17+) launch via an args file the installer drops
// under libraries/. The launch line looks like:
//   java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.4.20/unix_args.txt "$@"
//   java @libraries/net/neoforged/neoforge/20.4.190/unix_args.txt "$@"
const FORGE_ARGS_RE =
    /libraries[/\\]net[/\\]minecraftforge[/\\]forge[/\\]([^/\\]+)[/\\](?:unix|win)_args\.txt/i;
// NeoForge for MC 1.20.1 lives under net/neoforged/forge/<mc>-<loader>.
const NEOFORGE_1201_ARGS_RE =
    /libraries[/\\]net[/\\]neoforged[/\\]forge[/\\]([^/\\]+)[/\\](?:unix|win)_args\.txt/i;
// NeoForge for MC 1.20.2+ lives under net/neoforged/neoforge/<loader>.
const NEOFORGE_ARGS_RE =
    /libraries[/\\]net[/\\]neoforged[/\\]neoforge[/\\]([^/\\]+)[/\\](?:unix|win)_args\.txt/i;
// Legacy Forge (pre-1.17) launches a forge jar directly.
const LEGACY_FORGE_JAR_RE =
    /forge-(\d[\w.]*?)-(\d[\w.]+?)(?:-universal)?\.jar/i;

/**
 * Try to recover loader info from a server pack's start scripts.
 *
 * This is the fallback for packs that ship neither a Curseforge manifest.json
 * nor a serverpack-creator variables.txt, but DO carry a run.sh / run.bat whose
 * launch command references the loader's args file or jar. That path encodes the
 * loader kind, the MC version and the loader version.
 *
 * Returns null when no script is present, or when the script bootstraps the
 * loader at runtime (e.g. `java -jar forge-installer.jar`) rather than launching
 * an already-installed one — in that case there's nothing to parse and the pack
 * should be left to install its own loader.
 */
export async function getLoaderFromRunScripts(
    dir: string
): Promise<LoaderInfo | null> {
    for (const name of RUN_SCRIPT_NAMES) {
        const scriptPath = path.join(dir, name);
        if (!(await fs.pathExists(scriptPath))) continue;

        const content = await fs.readFile(scriptPath, 'utf8');
        const info = parseRunScript(content);
        if (info) return info;
    }
    return null;
}

/** Parse a single start-script body into LoaderInfo, if it launches a loader. */
export function parseRunScript(content: string): LoaderInfo | null {
    let m = content.match(FORGE_ARGS_RE);
    if (m) {
        const split = splitMcAndLoader(m[1]);
        if (split) {
            return { kind: 'forge', mcVersion: split.mc, loaderVersion: split.loader };
        }
    }

    m = content.match(NEOFORGE_1201_ARGS_RE);
    if (m) {
        const split = splitMcAndLoader(m[1]);
        if (split) {
            return { kind: 'neoforge', mcVersion: split.mc, loaderVersion: split.loader };
        }
    }

    m = content.match(NEOFORGE_ARGS_RE);
    if (m) {
        const loaderVersion = m[1];
        return {
            kind: 'neoforge',
            mcVersion: deriveNeoforgeMcVersion(loaderVersion),
            loaderVersion
        };
    }

    m = content.match(LEGACY_FORGE_JAR_RE);
    if (m) {
        return { kind: 'forge', mcVersion: m[1], loaderVersion: m[2] };
    }

    return null;
}

/**
 * Scan the libraries/ tree for an already-installed loader. Used when a pack
 * has no parseable start script but ships its loader pre-installed.
 */
export async function getLoaderFromLibraries(
    dir: string
): Promise<LoaderInfo | null> {
    const libs = path.join(dir, 'libraries');
    if (!(await fs.pathExists(libs))) return null;

    // Forge: libraries/net/minecraftforge/forge/<mc>-<loader>/
    const forgeDir = path.join(libs, 'net', 'minecraftforge', 'forge');
    const forgeVer = await firstVersionDir(forgeDir);
    if (forgeVer) {
        const split = splitMcAndLoader(forgeVer);
        if (split) {
            return { kind: 'forge', mcVersion: split.mc, loaderVersion: split.loader };
        }
    }

    // NeoForge 1.20.1: libraries/net/neoforged/forge/<mc>-<loader>/
    const neoForge1201Dir = path.join(libs, 'net', 'neoforged', 'forge');
    const neo1201Ver = await firstVersionDir(neoForge1201Dir);
    if (neo1201Ver) {
        const split = splitMcAndLoader(neo1201Ver);
        if (split) {
            return { kind: 'neoforge', mcVersion: split.mc, loaderVersion: split.loader };
        }
    }

    // NeoForge 1.20.2+: libraries/net/neoforged/neoforge/<loader>/
    const neoForgeDir = path.join(libs, 'net', 'neoforged', 'neoforge');
    const neoVer = await firstVersionDir(neoForgeDir);
    if (neoVer) {
        return {
            kind: 'neoforge',
            mcVersion: deriveNeoforgeMcVersion(neoVer),
            loaderVersion: neoVer
        };
    }

    return null;
}

/** Return the first immediate sub-directory name, or null if none. */
async function firstVersionDir(parent: string): Promise<string | null> {
    if (!(await fs.pathExists(parent))) return null;
    for (const entry of await fs.readdir(parent)) {
        const full = path.join(parent, entry);
        if ((await fs.stat(full)).isDirectory()) return entry;
    }
    return null;
}

/**
 * Split a "<mc>-<loader>" dir name (e.g. "1.20.1-47.4.20") into its parts.
 * The MC version is everything before the first hyphen; the loader version is
 * the remainder. Returns null if it doesn't look like an MC version.
 */
function splitMcAndLoader(combined: string): { mc: string; loader: string } | null {
    const hyphen = combined.indexOf('-');
    if (hyphen < 0) return null;
    const mc = combined.slice(0, hyphen);
    const loader = combined.slice(hyphen + 1);
    if (!/^\d+\.\d+/.test(mc) || !loader) return null;
    return { mc, loader };
}

/**
 * NeoForge (1.20.2+) versions encode the MC version: "20.4.190" -> "1.20.4",
 * "21.1.57" -> "1.21.1". Best-effort; the installer URL for modern NeoForge
 * keys off the loader version anyway, so this is mostly cosmetic.
 */
function deriveNeoforgeMcVersion(loaderVersion: string): string {
    const parts = loaderVersion.split('.');
    if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        const minor = parts[1] === '0' ? '' : `.${parts[1]}`;
        return `1.${parts[0]}${minor}`;
    }
    return 'unknown';
}

export type { ModLoaderKind };
