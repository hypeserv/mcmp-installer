import path from 'node:path';
import axios from 'axios';
import { log } from './util/logger.js';
import { ModProgress } from './util/modProgress.js';
import { LoaderInfo, ModLoaderKind } from './getForgeOrFabricVersion.js';
import { curseForgeFileUrl, downloadVerified, emptyReport, ManifestModsReport } from './downloadManifestMods.js';
import { CfFileInfo, CfFileRef, CfLookup, cfKey, lookupCurseForgeFiles } from './cfFiles.js';

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
    /** The manifest lists server-side jars under mods/, so an empty mods/ means the install failed. */
    expectsMods: boolean;
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
    lookup: CfLookup | null
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
    const serverFiles = version.files.filter(f => !f.clientonly);
    const clientOnly = version.files.filter(f => f.clientonly).map(f => f.name);
    const report = emptyReport('ftb', serverFiles.length);
    report.clientOnlyRemoved = clientOnly;

    // Files without a URL come from CurseForge: look them all up before any download.
    const cfRef = (f: FtbFile): CfFileRef | null =>
        !f.url && f.curseforge?.project && f.curseforge?.file
            ? { projectId: Number(f.curseforge.project), fileId: Number(f.curseforge.file) }
            : null;
    const cfRefs = serverFiles.map(cfRef).filter((r): r is CfFileRef => r !== null);
    if (cfRefs.length) log.info(`Looking up ${cfRefs.length} CurseForge files...`);
    const cf = await lookupCurseForgeFiles(cfRefs, lookup);
    const missingRequired: string[] = [];
    const files = serverFiles.filter(f => {
        const ref = cfRef(f);
        if (!ref || cf.files.has(cfKey(ref))) return true;
        if (f.optional) {
            report.skipped.push({ ...ref, fileName: f.name, type: 'missing (optional)' });
            log.warn(`Optional file ${f.name} no longer exists on CurseForge, skipped.`);
        } else {
            missingRequired.push(`${f.name} (${cfKey(ref)})`);
        }
        return false;
    });
    if (missingRequired.length) {
        throw new Error(`${missingRequired.length} FTB files no longer exist on CurseForge: ${missingRequired.join(', ')}`);
    }
    report.total = files.length;
    const expectsMods = files.some(f => isModJar(f));

    log.info(`Downloading ${files.length} files (${clientOnly.length} client-only skipped)...`);
    const progress = new ModProgress(files.length, 'Files', 1);

    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < files.length) {
            const file = files[next++];
            try {
                await installFtbFile(file, rootAbs, cf.files);
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
    return { loader, mcVersion, mods: report, expectsMods };
}

async function installFtbFile(file: FtbFile, rootAbs: string, cfFiles: Map<string, CfFileInfo>): Promise<void> {
    // path and name come from upstream: refuse anything outside the server root.
    const dir = path.resolve(rootAbs, file.path || '.');
    const dest = path.resolve(dir, file.name);
    if (!file.name || !isInside(rootAbs, dir) || !isInside(rootAbs, dest) || dest === rootAbs || path.dirname(dest) !== dir) {
        throw new Error(`refusing path outside the server root: ${file.path}/${file.name}`);
    }

    let url = file.url;
    if (!url && file.curseforge?.project && file.curseforge?.file) {
        const info = cfFiles.get(cfKey({ projectId: Number(file.curseforge.project), fileId: Number(file.curseforge.file) }));
        if (info) url = curseForgeFileUrl(info);
    }
    if (!url) throw new Error('no download URL');
    await downloadVerified(url, dir, file.name, { size: file.size, sha1: file.sha1 });
}

function isModJar(f: FtbFile): boolean {
    const dir = (f.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return dir === 'mods' && f.name.toLowerCase().endsWith('.jar');
}

function isInside(root: string, p: string): boolean {
    return p === root || p.startsWith(root + path.sep);
}
