import fs from 'fs-extra';
import path from 'node:path';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';
import { ModProgress } from './util/modProgress.js';
import { verifyFile } from './util/verifyFile.js';
import { removeClientOnlyMods } from './clientOnlyMods.js';
import { CfFileInfo, CfLookup, cfKey, lookupCurseForgeFiles } from './cfFiles.js';

interface ManifestModEntry {
    projectID?: number | string;
    projectId?: number | string;
    fileID?: number | string;
    fileId?: number | string;
    required?: boolean;
}

interface Manifest {
    files?: ManifestModEntry[];
}

/** File URL derived from the file id, for files the lookup returns without one. */
export function fallbackFileUrl(fileId: number, fileName: string): string {
    const base = process.env.MCI_FILE_FALLBACK_BASE || 'https://edge.forgecdn.net';
    return `${base}/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

/** Download URL for a CurseForge file: the lookup's URL, else the fallback. */
export function curseForgeFileUrl(info: CfFileInfo): string {
    return info.url || fallbackFileUrl(info.fileId, info.fileName);
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
    /** Not installed on purpose: resourcepacks, shaders, other content, optional files that no longer exist. */
    skipped: (ManifestModRef & { type: string })[];
    /** Datapacks placed in <level-name>/datapacks/. */
    datapacks: string[];
}

export function emptyReport(source: ManifestModsReport['source'], total: number): ManifestModsReport {
    return { source, total, installed: 0, restricted: [], failed: [], clientOnlyRemoved: [], skipped: [], datapacks: [] };
}

/**
 * What to do with a pack's manifest.json:
 * - none: it lists no CurseForge files
 * - shipped: mods/ already has jars (a server pack that also ships its manifest), keep them
 * - download: a client pack, fetch the listed files
 */
export async function manifestStep(manifestPath: string, modsDir: string): Promise<'none' | 'shipped' | 'download'> {
    if ((await readEntries(manifestPath)).length === 0) return 'none';
    const jars = (await fs.pathExists(modsDir))
        ? (await fs.readdir(modsDir)).filter(f => f.toLowerCase().endsWith('.jar'))
        : [];
    return jars.length > 0 ? 'shipped' : 'download';
}

async function readEntries(manifestPath: string): Promise<(ManifestModRef & { required: boolean })[]> {
    const data = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
    return (data.files || [])
        .map(m => ({
            projectId: Number(m.projectID ?? m.projectId),
            fileId: Number(m.fileID ?? m.fileId),
            fileName: null,
            required: m.required !== false
        }))
        .filter(m => m.projectId && m.fileId);
}

/** level-name from server.properties (or the pack's overrides copy), default "world". */
export async function readLevelName(serverRoot: string): Promise<string> {
    for (const file of [path.join(serverRoot, 'server.properties'), path.join(serverRoot, 'overrides', 'server.properties')]) {
        if (!(await fs.pathExists(file))) continue;
        const match = (await fs.readFile(file, 'utf8')).match(/^\s*level-name\s*=\s*(.*?)\s*$/m);
        const name = match?.[1].replace(/\\(.)/g, '$1');
        // Only a plain relative folder name; anything else falls back to the default.
        if (name && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..')) return name;
        break;
    }
    return 'world';
}

const CONCURRENCY = 8;

/**
 * Install the files of a CurseForge client manifest. All files are looked up in
 * one modpack-magic batch call first, then mods go to modsDir and datapacks to
 * <level-name>/datapacks/. Resourcepacks and shaders are skipped.
 */
export async function downloadManifestMods(
    manifestPath: string,
    opts: { modsDir: string; serverRoot: string; lookup: CfLookup | null }
): Promise<ManifestModsReport> {
    const entries = await readEntries(manifestPath);
    const report = emptyReport('manifest', entries.length);
    log.info(`Looking up ${entries.length} CurseForge files from manifest.json...`);
    const lookup = await lookupCurseForgeFiles(entries, opts.lookup);

    const missingRequired: string[] = [];
    for (const ref of lookup.missing) {
        const entry = entries.find(e => cfKey(e) === cfKey(ref));
        if (entry && !entry.required) {
            report.skipped.push({ ...ref, fileName: null, type: 'missing (optional)' });
            log.warn(`Optional file ${cfKey(ref)} no longer exists on CurseForge, skipped.`);
        } else {
            missingRequired.push(cfKey(ref));
        }
    }
    if (missingRequired.length) {
        throw new Error(
            `${missingRequired.length} files from manifest.json no longer exist on CurseForge (project/file): ` +
            missingRequired.join(', ')
        );
    }

    const datapacksDir = path.join(opts.serverRoot, await readLevelName(opts.serverRoot), 'datapacks');
    const toInstall: CfFileInfo[] = [];
    for (const entry of entries) {
        const info = lookup.files.get(cfKey(entry));
        if (!info) continue;
        if (info.type === 'mod' || info.type === 'datapack') {
            toInstall.push(info);
        } else {
            report.skipped.push({ projectId: info.projectId, fileId: info.fileId, fileName: info.fileName, type: info.type });
            const msg = `Skipped ${info.fileName} (${info.type})`;
            if (info.type === 'resourcepack' || info.type === 'shader') log.info(`${msg}: not needed on a server.`);
            else log.warn(`${msg}: not a mod or datapack.`);
        }
    }

    const expectedMods = toInstall.filter(f => f.type === 'mod').length;
    log.info(`Downloading ${toInstall.length} files (${expectedMods} mods, ${toInstall.length - expectedMods} datapacks)...`);
    const progress = new ModProgress(toInstall.length);
    const downloaded = new Set<string>();

    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < toInstall.length) {
            const info = toInstall[next++];
            const ref: ManifestModRef = { projectId: info.projectId, fileId: info.fileId, fileName: info.fileName };
            const restricted = !info.url;
            try {
                const name = safeFileName(info.fileName);
                const dir = info.type === 'datapack' ? datapacksDir : opts.modsDir;
                await fs.ensureDir(dir);
                await downloadVerified(curseForgeFileUrl(info), dir, name, info);
                if (info.type === 'datapack') report.datapacks.push(name);
                else downloaded.add(name);
                if (restricted) report.restricted.push({ ...ref, installed: true });
                progress.ok(name);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                if (restricted) report.restricted.push({ ...ref, installed: false });
                report.failed.push({ ...ref, reason });
                progress.fail(info.fileName, reason);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toInstall.length) }, worker));
    progress.finish();

    // Client manifests list client-only mods too (e.g. Legendary Tooltips),
    // which crash a dedicated server. Remove them unless another mod needs them.
    const removed = await removeClientOnlyMods(opts.modsDir, downloaded);
    if (removed.length) log.info(`Removed ${removed.length} client-only mods: ${removed.join(', ')}`);

    report.clientOnlyRemoved = removed;
    report.installed = downloaded.size - removed.length + report.datapacks.length;
    if (report.restricted.length) {
        const missing = report.restricted.filter(r => !r.installed).length;
        log.warn(
            `Pack contains ${report.restricted.length} mods whose authors disabled third-party distribution` +
            (missing ? ` (${missing} could not be installed)` : '') + '.'
        );
    }
    if (expectedMods > 0 && downloaded.size === 0) {
        throw new Error(`None of the ${expectedMods} mods from manifest.json could be downloaded.`);
    }
    return report;
}

/** Download to dir/name and check size + sha1; one retry on a mismatch. */
export async function downloadVerified(
    url: string,
    dir: string,
    name: string,
    expect: { size?: number | null; sha1?: string | null }
): Promise<void> {
    const dest = path.join(dir, name);
    for (let attempt = 1; attempt <= 2; attempt++) {
        await download(url, { dir, fileName: name, quiet: true });
        const problem = await verifyFile(dest, expect);
        if (!problem) return;
        await fs.remove(dest);
        if (attempt === 2) throw new Error(problem);
    }
}

function safeFileName(name: string): string {
    const base = path.basename(name);
    if (!base || base !== name || base === '.' || base === '..') throw new Error(`refusing unsafe file name: ${name}`);
    return base;
}
