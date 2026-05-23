import axios from 'axios';
import { log } from './util/logger.js';

export type Provider = 'curse' | 'technic' | 'ftb' | 'modrinth' | 'direct';

export interface ModpackUrls {
    SpecifiedVersion: string;
    LatestReleaseServerpack: string;
    LatestBetaServerpack: string;
    LatestAlphaServerpack: string;
    LatestReleaseNonServerpack: string;
}

export type ModpackUrlResult = [string, ModpackUrls, string];

interface ModrinthVersion {
    id: string;
    version_number: string;
    game_versions?: string[];
    files?: { url?: string }[];
}

interface ModrinthProject {
    title?: string;
    name?: string;
    slug?: string;
}

export async function getModpackMinecraftVersion(
    provider: Provider,
    modpackId: string
): Promise<string | false> {
    try {
        if (provider === 'modrinth') {
            const url = `https://api.modrinth.com/v2/project/${modpackId}/version`;
            const resp = await axios.get<ModrinthVersion[]>(url, {
                headers: {
                    'user-agent':
                        'Mozilla/5.0 (compatible; hypeserv-mcmp-installer)',
                    referer: 'https://api.modrinth.com/'
                },
                timeout: 60000
            });
            return resp.data?.[0]?.game_versions?.[0] || false;
        }
        return false;
    } catch {
        return false;
    }
}

export async function getServerModpackUrl(
    provider: Provider,
    modpackId: string,
    modpackVersion: string | false,
    _operatingSystem: string,
    _architecture: string
): Promise<ModpackUrlResult> {
    if (provider === 'direct') {
        const name = 'Direct_Download';
        const urls: ModpackUrls = {
            SpecifiedVersion: modpackId,
            LatestReleaseServerpack: '',
            LatestBetaServerpack: '',
            LatestAlphaServerpack: '',
            LatestReleaseNonServerpack: ''
        };
        return [name, urls, modpackId];
    }

    if (provider === 'modrinth') {
        const project = (await axios.get<ModrinthProject>(
            `https://api.modrinth.com/v2/project/${modpackId}`,
            { timeout: 60000 }
        )).data;

        const name = project.title || project.name || project.slug || modpackId;
        const versions = (await axios.get<ModrinthVersion[]>(
            `https://api.modrinth.com/v2/project/${modpackId}/version`,
            { timeout: 60000 }
        )).data;

        let chosen: ModrinthVersion | undefined;
        if (modpackVersion) {
            chosen =
                versions.find(v => v.version_number === modpackVersion) ||
                versions.find(v => v.id === modpackVersion);
        }
        if (!chosen) chosen = versions[0];

        const normalDownloadUrl = chosen?.files?.[0]?.url || '';
        const urls: ModpackUrls = {
            SpecifiedVersion: normalDownloadUrl,
            LatestReleaseServerpack: '',
            LatestBetaServerpack: '',
            LatestAlphaServerpack: '',
            LatestReleaseNonServerpack: ''
        };

        return [name, urls, normalDownloadUrl];
    }

    const urls: ModpackUrls = {
        SpecifiedVersion: '',
        LatestReleaseServerpack: '',
        LatestBetaServerpack: '',
        LatestAlphaServerpack: '',
        LatestReleaseNonServerpack: ''
    };

    const name = `${provider}_${modpackId}`;
    const normalDownloadUrl = '';
    // Reference log to keep parity with previous behavior if needed
    void log;
    return [name, urls, normalDownloadUrl];
}
