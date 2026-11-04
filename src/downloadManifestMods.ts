import fs from 'fs-extra';
import axios from 'axios';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';
import { ModProgress } from './util/modProgress.js';
import { removeClientOnlyMods } from './clientOnlyMods.js';
import path from 'node:path';

interface ManifestModEntry {
    projectID?: number | string;
    projectId?: number | string;
    fileID?: number | string;
    fileId?: number | string;
}

interface Manifest {
    files?: ManifestModEntry[];
}

/** File URL derived from the file id, for files the mod API returns without one. */
export function fallbackFileUrl(fileId: number, fileName: string): string {
    const base = process.env.MCI_FILE_FALLBACK_BASE || 'https://edge.forgecdn.net';
    return `${base}/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

export interface HypesrvFileInfo {
    id?: number;
    downloadUrl?: string;
    displayName?: string;
    fileName?: string;
}

interface HypesrvResponse {
    data?: HypesrvFileInfo;
}

/** File info from the HypeServ mod API (CurseForge mirror). */
export async function fetchModFileInfo(
    projectId: number,
    fileId: number,
    apiKey: string | false
): Promise<HypesrvFileInfo | undefined> {
    const apiBase = process.env.MCI_MOD_API_BASE || 'https://api.hypeserv.com';
    const url = `${apiBase}/v3/modpack/fileUrl/${projectId}/${fileId}`;
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const resp = await axios.get<HypesrvResponse>(url, { timeout: 60000, headers });
    return resp.data?.data;
}

/** Download URL for a CurseForge file: the API's URL, else the fallback. */
export function curseForgeFileUrl(info: HypesrvFileInfo, fileId: number, fileName: string): string {
    return info.downloadUrl || fallbackFileUrl(Number(info.id ?? fileId), fileName);
}

export interface ManifestModRef {
    projectId: number;
    fileId: number;
    fileName: string | null;
}

/** What the manifest step did; written to .hypeserv/modpack.json for the panel. */
export interface ManifestModsReport {
    source: 'manifest' | 'ftb';
    total: number;
    installed: number;
    /** Author disabled third-party distribution; `installed` = fetched via fallback. */
    restricted: (ManifestModRef & { installed: boolean })[];
    failed: (ManifestModRef & { reason: string })[];
    clientOnlyRemoved: string[];
}

export async function downloadManifestMods(
    manifestPath: string,
    apiKey: string | false
): Promise<ManifestModsReport> {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw) as Manifest;

    const entries = (data.files || []).filter(m => (m.projectID ?? m.projectId) && (m.fileID ?? m.fileId));
    log.info(`Downloading ${entries.length} mods from manifest.json via the HypeServ mod API...`);
    const progress = new ModProgress(entries.length);
    const downloaded = new Set<string>();
    const report: ManifestModsReport = {
        source: 'manifest', total: entries.length, installed: 0, restricted: [], failed: [], clientOnlyRemoved: []
    };
    for (const mod of entries) {
        const modId = mod.projectID ?? mod.projectId;
        const fileId = mod.fileID ?? mod.fileId;
        const label = `${modId}/${fileId}`;
        const ref: ManifestModRef = { projectId: Number(modId), fileId: Number(fileId), fileName: null };
        let restricted = false;
        try {
            const info = await fetchModFileInfo(Number(modId), Number(fileId), apiKey);
            if (!info?.fileName && !info?.downloadUrl) {
                report.failed.push({ ...ref, reason: 'no file info from the mod API' });
                progress.fail(label, 'no file info from the mod API');
                continue;
            }
            const name = info.fileName || path.basename(new URL(info.downloadUrl!).pathname);
            ref.fileName = name;
            if (!name.toLowerCase().endsWith('.jar')) {
                // Resource / shader packs: client-side only, and not mods.
                progress.skip(`${name} (not a mod)`);
                continue;
            }
            restricted = !info.downloadUrl;
            const fileUrl = curseForgeFileUrl(info, Number(fileId), name);
            await download(fileUrl, { fileName: name, quiet: true });
            downloaded.add(name);
            if (restricted) report.restricted.push({ ...ref, installed: true });
            progress.ok(name);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (restricted) report.restricted.push({ ...ref, installed: false });
            report.failed.push({ ...ref, reason });
            progress.fail(ref.fileName || label, reason);
        }
    }
    progress.finish();

    // Client manifests list client-only mods too (e.g. Legendary Tooltips),
    // which crash a dedicated server. Remove them unless another mod needs them.
    const removed = await removeClientOnlyMods(process.cwd(), downloaded);
    if (removed.length) log.info(`Removed ${removed.length} client-only mods: ${removed.join(', ')}`);

    report.clientOnlyRemoved = removed;
    report.installed = downloaded.size - removed.length;
    if (report.restricted.length) {
        const missing = report.restricted.filter(r => !r.installed).length;
        log.warn(
            `Pack contains ${report.restricted.length} mods whose authors disabled third-party distribution` +
            (missing ? ` (${missing} could not be installed)` : '') + '.'
        );
    }
    return report;
}
