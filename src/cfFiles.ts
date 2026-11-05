import axios from 'axios';

/** Where and how to reach the modpack-magic files endpoint. The token is never logged. */
export interface CfLookup {
    resolverUrl: string;
    token: string | null;
}

export interface CfFileRef {
    projectId: number;
    fileId: number;
}

export type CfFileType = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack' | 'other';

/** One entry of POST /api/v1/games/minecraft/curseforge/files. url is null for restricted files. */
export interface CfFileInfo extends CfFileRef {
    fileName: string;
    size: number | null;
    sha1: string | null;
    url: string | null;
    classId: number | null;
    type: CfFileType;
}

export interface CfLookupResult {
    files: Map<string, CfFileInfo>;
    missing: CfFileRef[];
}

/** modpack-magic rejects more than this per call. */
export const CF_FILES_BATCH = 1000;
const TYPES: readonly CfFileType[] = ['mod', 'resourcepack', 'shader', 'datapack', 'modpack', 'other'];

export const cfKey = (ref: CfFileRef): string => `${ref.projectId}/${ref.fileId}`;

/**
 * Look up CurseForge files through modpack-magic, in chunks of 1000. Run it once
 * before any download so the short-lived installer token can't expire mid-install.
 */
export async function lookupCurseForgeFiles(refs: CfFileRef[], lookup: CfLookup | null): Promise<CfLookupResult> {
    const result: CfLookupResult = { files: new Map(), missing: [] };
    // Send only projectId + fileId: callers pass richer entries, and the endpoint validates its body.
    const unique = [...new Map(refs.map(r => {
        const ref: CfFileRef = { projectId: Number(r.projectId), fileId: Number(r.fileId) };
        return [cfKey(ref), ref] as const;
    })).values()];
    if (!unique.length) return result;
    if (!lookup?.resolverUrl || !lookup.token) {
        throw new Error(
            `This pack needs ${unique.length} CurseForge file lookups, but no modpack-magic token is set. ` +
            'Set MODPACK_MAGIC_URL and MODPACK_MAGIC_TOKEN (or --resolver-url / --resolver-token).'
        );
    }

    const url = `${lookup.resolverUrl}/api/v1/games/minecraft/curseforge/files`;
    for (let i = 0; i < unique.length; i += CF_FILES_BATCH) {
        const chunk = unique.slice(i, i + CF_FILES_BATCH);
        const data = await postFiles(url, chunk, lookup.token);
        for (const raw of data.files) {
            const info = parseInfo(raw);
            if (!info) throw new Error(`Unexpected file entry from ${url}: ${JSON.stringify(raw)}`);
            result.files.set(cfKey(info), info);
        }
        for (const m of data.missing) {
            const ref = { projectId: Number((m as CfFileRef).projectId), fileId: Number((m as CfFileRef).fileId) };
            if (!result.files.has(cfKey(ref))) result.missing.push(ref);
        }
        // Anything neither returned nor listed as missing counts as missing.
        for (const ref of chunk) {
            const key = cfKey(ref);
            if (!result.files.has(key) && !result.missing.some(m => cfKey(m) === key)) result.missing.push(ref);
        }
    }
    return result;
}

async function postFiles(url: string, files: CfFileRef[], token: string): Promise<{ files: unknown[]; missing: unknown[] }> {
    let status = 0;
    let body: unknown;
    try {
        const resp = await axios.post<unknown>(url, { files }, {
            headers: { 'user-agent': 'hypeserv-mcmp-installer', authorization: `Bearer ${token}` },
            timeout: 120000,
            validateStatus: () => true
        });
        status = resp.status;
        body = resp.data;
    } catch (err) {
        // Fresh error: the axios error carries the request headers (token).
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`CurseForge file lookup at ${url} failed: ${msg}`);
    }
    if (status === 401 || status === 403) {
        throw new Error(`CurseForge file lookup at ${url} was refused (HTTP ${status}): the modpack-magic token is invalid, expired or lacks scope modpack:files.`);
    }
    const data = body as { files?: unknown; missing?: unknown } | null;
    if (status !== 200 || !data || !Array.isArray(data.files)) {
        throw new Error(`CurseForge file lookup at ${url} failed (HTTP ${status}): ${JSON.stringify(body)?.slice(0, 300)}`);
    }
    return { files: data.files, missing: Array.isArray(data.missing) ? data.missing : [] };
}

function parseInfo(raw: unknown): CfFileInfo | null {
    const r = raw as Partial<Record<keyof CfFileInfo, unknown>> | null;
    const projectId = Number(r?.projectId);
    const fileId = Number(r?.fileId);
    if (!r || !projectId || !fileId || typeof r.fileName !== 'string' || !r.fileName) return null;
    const type = TYPES.includes(r.type as CfFileType) ? (r.type as CfFileType) : 'other';
    return {
        projectId,
        fileId,
        fileName: r.fileName,
        size: typeof r.size === 'number' ? r.size : null,
        sha1: typeof r.sha1 === 'string' && r.sha1 ? r.sha1 : null,
        url: typeof r.url === 'string' && r.url ? r.url : null,
        classId: typeof r.classId === 'number' ? r.classId : null,
        type
    };
}
