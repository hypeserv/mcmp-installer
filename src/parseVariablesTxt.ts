import fs from 'fs-extra';
import { LoaderInfo, ModLoaderKind } from './getForgeOrFabricVersion.js';

/**
 * Parsed key/value pairs from a serverpack-creator / ServerStarter style
 * variables.txt. Keys are preserved as-written plus normalized aliases.
 */
export interface ServerpackVariables {
    mcVersion?: string;
    modloader?: string;
    modloaderVersion?: string;
    [key: string]: string | undefined;
}

/**
 * Parse KEY=VALUE pairs. Supports quoted values (single or double),
 * comment lines starting with '#', and blank lines.
 */
export async function parseVariablesTxt(filePath: string): Promise<ServerpackVariables> {
    const raw = await fs.readFile(filePath, 'utf8');
    const out: ServerpackVariables = {};

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;

        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        out[key] = value;
    }

    out.mcVersion =
        out.MINECRAFT_VERSION ||
        out.minecraftVersion ||
        out.MC_VERSION ||
        out.mcVersion;
    out.modloader =
        out.MODLOADER || out.MOD_LOADER || out.modloader;
    out.modloaderVersion =
        out.MODLOADER_VERSION ||
        out.MOD_LOADER_VERSION ||
        out.modloaderVersion;

    return out;
}

/**
 * Map a parsed variables.txt to a LoaderInfo, if enough fields are present.
 */
export function variablesToLoaderInfo(vars: ServerpackVariables): LoaderInfo | null {
    const { mcVersion, modloader, modloaderVersion } = vars;
    if (!mcVersion || !modloader || !modloaderVersion) return null;

    const normalized = modloader.toLowerCase();
    let kind: ModLoaderKind | null = null;

    if (normalized === 'forge') kind = 'forge';
    else if (normalized === 'neoforge') kind = 'neoforge';
    else if (
        normalized === 'fabric' ||
        normalized === 'legacyfabric' ||
        normalized === 'quilt'
    ) {
        // Quilt is fabric-compatible at runtime; the Quilt installer is a
        // separate jar, but Fabric installer is good enough as a fallback.
        kind = 'fabric';
    }

    if (!kind) return null;
    return { kind, mcVersion, loaderVersion: modloaderVersion };
}
