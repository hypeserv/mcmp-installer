import { resolveModpack, ResolvedDownloadKind } from './resolveModpack.js';

/** `curse` is an alias of `curseforge`, `feed-the-beast` of `ftb`. */
export type Provider = 'curseforge' | 'curse' | 'modrinth' | 'ftb' | 'feed-the-beast' | 'technic' | 'direct';
export type CanonicalProvider = Exclude<Provider, 'curse' | 'feed-the-beast'>;

export const PROVIDERS: readonly Provider[] = [
    'curseforge',
    'curse',
    'modrinth',
    'ftb',
    'feed-the-beast',
    'technic',
    'direct'
];

export function normalizeProvider(provider: Provider): CanonicalProvider {
    if (provider === 'curse') return 'curseforge';
    if (provider === 'feed-the-beast') return 'ftb';
    return provider;
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
        case 'modrinth':
        case 'ftb': {
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
        case 'technic':
            throw new Error(
                `Provider "${provider}" is not supported yet. ` +
                'Use --wget-mode with a direct serverpack URL instead.'
            );
    }
}
