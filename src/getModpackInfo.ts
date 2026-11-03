import { resolveModpack, ResolvedDownloadKind } from './resolveModpack.js';

/** `curse` is kept as an alias of `curseforge`. */
export type Provider = 'curseforge' | 'curse' | 'modrinth' | 'ftb' | 'technic' | 'direct';
export type CanonicalProvider = Exclude<Provider, 'curse'>;

export const PROVIDERS: readonly Provider[] = [
    'curseforge',
    'curse',
    'modrinth',
    'ftb',
    'technic',
    'direct'
];

export function normalizeProvider(provider: Provider): CanonicalProvider {
    return provider === 'curse' ? 'curseforge' : provider;
}

export interface ModpackSource {
    name: string;
    downloadUrl: string;
    /** Absent for `direct`. */
    kind?: ResolvedDownloadKind;
    versionId: string | null;
    mcVersion: string | null;
    loader: string | null;
}

export async function getModpackSource(
    provider: CanonicalProvider,
    modpackId: string,
    modpackVersion: string | false,
    resolverUrl: string,
    resolverToken: string | null = null
): Promise<ModpackSource> {
    switch (provider) {
        case 'direct':
            return {
                name: 'Direct_Download',
                downloadUrl: modpackId,
                versionId: null,
                mcVersion: null,
                loader: null
            };
        case 'curseforge':
        case 'modrinth': {
            const r = await resolveModpack(resolverUrl, provider, modpackId, modpackVersion, resolverToken);
            return {
                name: r.name,
                downloadUrl: r.download.url,
                kind: r.download.kind,
                versionId: r.versionId,
                mcVersion: r.mcVersion,
                loader: r.loader
            };
        }
        case 'ftb':
        case 'technic':
            throw new Error(
                `Provider "${provider}" is not supported yet. ` +
                'Use --wget-mode with a direct serverpack URL instead.'
            );
    }
}
