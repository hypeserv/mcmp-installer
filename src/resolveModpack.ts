import axios, { AxiosError } from 'axios';

/** Used when neither --resolver-url nor MODPACK_MAGIC_URL is set. */
export const DEFAULT_RESOLVER_URL = 'https://modpack-magic.hypeserv.com';

export type ResolvedDownloadKind = 'serverpack' | 'client-manifest' | 'mrpack' | 'ftb-manifest';

/** Response of modpack-magic GET /api/v1/games/minecraft/:provider/modpacks/:id/resolve */
export interface ResolvedModpack {
    versionId: string;
    name: string;
    mcVersion: string | null;
    loader: string | null;
    releaseType: string | null;
    download: {
        url: string;
        kind: ResolvedDownloadKind;
    };
}

const KINDS: readonly ResolvedDownloadKind[] = ['serverpack', 'client-manifest', 'mrpack', 'ftb-manifest'];

export function getResolverUrl(flag: string | false | undefined): string {
    const raw = flag || process.env.MODPACK_MAGIC_URL || DEFAULT_RESOLVER_URL;
    return raw.replace(/\/+$/, '');
}

/** Bearer token for modpack-magic, or null when auth is off. Never log it. */
export function getResolverToken(flag: string | false | undefined): string | null {
    const raw = (flag || process.env.MODPACK_MAGIC_TOKEN || '').trim();
    return raw || null;
}

/**
 * Ask modpack-magic which file to install for a modpack.
 * version: a provider version/file id, or false for the latest release.
 */
export async function resolveModpack(
    resolverUrl: string,
    provider: 'curseforge' | 'modrinth' | 'ftb',
    modpackId: string,
    version: string | false,
    token: string | null = null
): Promise<ResolvedModpack> {
    const url =
        `${resolverUrl}/api/v1/games/minecraft/${provider}/modpacks/` +
        `${encodeURIComponent(modpackId)}/resolve`;

    let data: unknown;
    try {
        const resp = await axios.get<unknown>(url, {
            params: { version: version || 'latest' },
            headers: {
                'user-agent': 'hypeserv-mcmp-installer',
                ...(token ? { authorization: `Bearer ${token}` } : {})
            },
            timeout: 60000
        });
        data = resp.data;
    } catch (err) {
        // Build a fresh Error: the axios error carries config.headers (with the
        // token), and it must never reach the CLI's stack/err printer.
        throw new Error(describeResolveError(err, provider, modpackId, version));
    }

    const r = data as Partial<ResolvedModpack> | null;
    if (
        !r ||
        typeof r.versionId !== 'string' ||
        typeof r.download?.url !== 'string' ||
        !r.download.url ||
        !KINDS.includes(r.download.kind as ResolvedDownloadKind)
    ) {
        throw new Error(`Unexpected resolve response from ${url}: ${JSON.stringify(data)}`);
    }

    return {
        versionId: r.versionId,
        name: r.name || `${provider}_${modpackId}`,
        mcVersion: r.mcVersion ?? null,
        loader: r.loader ?? null,
        releaseType: r.releaseType ?? null,
        download: { url: r.download.url, kind: r.download.kind as ResolvedDownloadKind }
    };
}

function describeResolveError(
    err: unknown,
    provider: string,
    modpackId: string,
    version: string | false
): string {
    const what = `${provider} modpack ${modpackId} (version ${version || 'latest'})`;
    if (!(err instanceof AxiosError)) {
        return `Resolving ${what} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const status = err.response?.status;
    const body = err.response?.data ? JSON.stringify(err.response.data) : '';
    switch (status) {
        case 401:
            return 'modpack-magic rejected the token (missing/expired) — the panel mints a new one ' +
                'on every reinstall, retry the install from the panel.';
        case 403:
            return `modpack-magic token not valid for this modpack: ${what}.`;
        case 404:
            return `Modpack not found: ${what}. ${body}`;
        case 409:
            return `No server-compatible file for ${what}. ${body}`;
        case 502:
            return `Resolver could not reach ${provider} for ${what}. Try again later. ${body}`;
        case undefined:
            return `Resolver unreachable (${err.code || err.message}) at ${err.config?.url}. ` +
                'Set --resolver-url or MODPACK_MAGIC_URL.';
        default:
            return `Resolving ${what} failed with HTTP ${status}. ${body}`;
    }
}
