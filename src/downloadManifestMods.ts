import fs from 'fs-extra';
import axios from 'axios';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';

interface ManifestModEntry {
    projectID?: number | string;
    projectId?: number | string;
    fileID?: number | string;
    fileId?: number | string;
}

interface Manifest {
    files?: ManifestModEntry[];
}

interface HypesrvFileInfo {
    downloadUrl?: string;
    displayName?: string;
    fileName?: string;
}

interface HypesrvResponse {
    data?: HypesrvFileInfo;
}

export async function downloadManifestMods(
    manifestPath: string,
    apiKey: string | false
): Promise<void> {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw) as Manifest;

    log.info('Starting download of manifest server mods...');
    for (const mod of data.files || []) {
        const modId = mod.projectID ?? mod.projectId;
        const fileId = mod.fileID ?? mod.fileId;
        if (!modId || !fileId) continue;

        try {
            const url = `https://api.hypeserv.net/v3/modpack/fileUrl/${modId}/${fileId}`;
            log.info(url);
            const headers: Record<string, string> = apiKey
                ? { Authorization: `Bearer ${apiKey}` }
                : {};
            const resp = await axios.get<HypesrvResponse>(url, {
                timeout: 60000,
                headers
            });
            const info = resp.data?.data;
            if (!info?.downloadUrl) {
                log.warn(`No downloadUrl for mod ${modId}/${fileId}`);
                continue;
            }
            log.info(`Downloading ${info.displayName || info.fileName}...`);
            await download(info.downloadUrl);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`Error downloading mod ${modId}/${fileId}: ${message}`);
        }
    }
    log.info('Finished downloading all server mods from modpack manifest.');
}
