import fs from 'fs-extra';

export type ModLoaderKind = 'fabric' | 'forge' | 'neoforge';

export interface LoaderInfo {
    kind: ModLoaderKind;
    mcVersion: string;
    loaderVersion: string;
}

interface CurseModLoader {
    id?: string;
    primary?: boolean;
}

interface CurseManifest {
    minecraft?: {
        version?: string;
        modLoaders?: CurseModLoader[];
    };
}

/**
 * Parse Curseforge / serverpack-creator manifest.json and return loader info.
 *
 * Curse manifest mod loader ids look like:
 *   - "forge-47.2.0"
 *   - "neoforge-20.4.190"
 *   - "fabric-0.15.3"
 */
export async function getLoaderFromManifest(
    manifestPath: string
): Promise<LoaderInfo | null> {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw) as CurseManifest;

    const modloaders = data?.minecraft?.modLoaders || [];
    const minecraftVersion = data?.minecraft?.version;
    if (!minecraftVersion) return null;

    for (const ml of modloaders) {
        if (!ml.primary) continue;
        const id = ml.id || '';
        const lower = id.toLowerCase();

        // Order matters: check neoforge before forge so the "forge"
        // substring in "neoforge" doesn't misclassify.
        if (lower.startsWith('neoforge-')) {
            return {
                kind: 'neoforge',
                mcVersion: minecraftVersion,
                loaderVersion: id.slice('neoforge-'.length)
            };
        }
        if (lower.startsWith('forge-')) {
            return {
                kind: 'forge',
                mcVersion: minecraftVersion,
                loaderVersion: id.slice('forge-'.length)
            };
        }
        if (lower.startsWith('fabric-')) {
            return {
                kind: 'fabric',
                mcVersion: minecraftVersion,
                loaderVersion: id.slice('fabric-'.length)
            };
        }
    }
    return null;
}
