import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import axios from 'axios';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';
import { ModProgress } from './util/modProgress.js';
import { LoaderInfo, ModLoaderKind } from './getForgeOrFabricVersion.js';
import { curseForgeFileUrl, fetchModFileInfo, ManifestModsReport } from './downloadManifestMods.js';

interface FtbFile {
    name: string;
    path: string;
    url?: string;
    sha1?: string;
    size?: number;
    clientonly?: boolean;
    serveronly?: boolean;
    optional?: boolean;
    curseforge?: { project?: string | number; file?: string | number };
}

interface FtbTarget {
    name: string;
    version: string;
    type: 'game' | 'modloader' | 'runtime' | string;
}

export interface FtbVersion {
    status?: string;
    parent?: number;
    name?: string;
    targets?: FtbTarget[];
    files?: FtbFile[];
    specs?: { minimum?: number; recommended?: number };
}

export interface FtbInstallResult {
    loader: LoaderInfo | null;
    mcVersion: string | null;
    mods: ManifestModsReport;
}

const CONCURRENCY = 8;
const LOADERS: Record<string, ModLoaderKind> = { forge: 'forge', neoforge: 'neoforge', fabric: 'fabric' };

/** Loader + MC version from an FTB version's targets. */
export function ftbLoader(version: FtbVersion): { loader: LoaderInfo | null; mcVersion: string | null } {
    const targets = version.targets ?? [];
    const mcVersion = targets.find(t => t.type === 'game' && t.name === 'minecraft')?.version ?? null;
    const ml = targets.find(t => t.type === 'modloader');
    if (!ml || !mcVersion) return { loader: null, mcVersion };
    const kind = LOADERS[ml.name.toLowerCase()];
    if (!kind) throw new Error(`FTB pack uses the ${ml.name} loader, which is not supported yet.`);
    return { loader: { kind, mcVersion, loaderVersion: ml.version }, mcVersion };
}

/**
 * Install an FTB pack version from its version JSON (resolve kind
 * "ftb-manifest"): download every server-side file to <path>/<name>, check
 * size and sha1, and return the loader to install. Client-only files are skipped.
 */
export async function installFtbManifest(
    manifestUrl: string,
    root: string,
    apiKey: string | false
): Promise<FtbInstallResult> {
    const resp = await axios.get<FtbVersion>(manifestUrl, { timeout: 60000, validateStatus: () => true });
    const version = resp.data;
    if (resp.status !== 200 || version?.status !== 'success' || !Array.isArray(version.files)) {
        throw new Error(`FTB version manifest not available (HTTP ${resp.status}): ${manifestUrl}`);
    }
    const { loader, mcVersion } = ftbLoader(version);
    const javaTarget = version.targets?.find(t => t.type === 'runtime');
    log.info(
        `FTB ${version.name ?? ''}: MC ${mcVersion ?? '?'}, ${loader ? `${loader.kind} ${loader.loaderVersion}` : 'no loader'}` +
        (javaTarget ? `, Java ${javaTarget.version}` : '') +
        (version.specs?.recommended ? `, recommended RAM ${version.specs.recommended} MB` : '')
    );

    const rootAbs = path.resolve(root);
    const files = version.files.filter(f => !f.clientonly);
    const clientOnly = version.files.filter(f => f.clientonly).map(f => f.name);
    const report: ManifestModsReport = {
        source: 'ftb', total: files.length, installed: 0, restricted: [], failed: [], clientOnlyRemoved: clientOnly
    };
    log.info(`Downloading ${files.length} files (${clientOnly.length} client-only skipped)...`);
    const progress = new ModProgress(files.length, 'Files', 1);

    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < files.length) {
            const file = files[next++];
            try {
                await installFtbFile(file, rootAbs, apiKey);
                report.installed++;
                progress.ok(file.name);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                const cf = file.curseforge;
                report.failed.push({
                    projectId: Number(cf?.project ?? 0),
                    fileId: Number(cf?.file ?? 0),
                    fileName: file.name,
                    reason
                });
                progress.fail(file.name, reason);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    progress.finish();
    return { loader, mcVersion, mods: report };
}

async function installFtbFile(file: FtbFile, rootAbs: string, apiKey: string | false): Promise<void> {
    // path and name come from upstream: refuse anything outside the server root.
    const dir = path.resolve(rootAbs, file.path || '.');
    const dest = path.resolve(dir, file.name);
    if (!file.name || !isInside(rootAbs, dir) || !isInside(rootAbs, dest) || dest === rootAbs || path.dirname(dest) !== dir) {
        throw new Error(`refusing path outside the server root: ${file.path}/${file.name}`);
    }

    let url = file.url;
    if (!url && file.curseforge?.project && file.curseforge?.file) {
        const projectId = Number(file.curseforge.project);
        const fileId = Number(file.curseforge.file);
        const info = await fetchModFileInfo(projectId, fileId, apiKey);
        if (!info) throw new Error(`no file info for CurseForge ${projectId}/${fileId}`);
        url = curseForgeFileUrl(info, fileId, info.fileName || file.name);
    }
    if (!url) throw new Error('no download URL');

    for (let attempt = 1; attempt <= 2; attempt++) {
        await download(url, { dir, fileName: file.name, quiet: true });
        const problem = await verify(dest, file);
        if (!problem) return;
        await fs.remove(dest);
        if (attempt === 2) throw new Error(problem);
    }
}

async function verify(file: string, meta: FtbFile): Promise<string | null> {
    const stat = await fs.stat(file);
    if (meta.size && stat.size !== meta.size) return `size mismatch (${stat.size} != ${meta.size})`;
    if (meta.sha1) {
        const hash = crypto.createHash('sha1');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
        const sha1 = hash.digest('hex');
        if (sha1.toLowerCase() !== meta.sha1.toLowerCase()) return `sha1 mismatch (${sha1} != ${meta.sha1})`;
    }
    return null;
}

function isInside(root: string, p: string): boolean {
    return p === root || p.startsWith(root + path.sep);
}
