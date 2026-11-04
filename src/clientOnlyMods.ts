import path from 'node:path';
import fs from 'fs-extra';
import yauzl from 'yauzl';
import { CLIENT_ONLY_PREFIXES, CLIENT_ONLY_PREFIXES_EXTRA, CLIENT_ONLY_WHITELIST } from './data/clientOnlyMods.js';
import { log } from './util/logger.js';

/** Known client-only mod by jar filename (ServerPackCreator's list). */
export function isClientOnlyByName(fileName: string): boolean {
    if (CLIENT_ONLY_WHITELIST.some(w => fileName.startsWith(w))) return false;
    return [...CLIENT_ONLY_PREFIXES, ...CLIENT_ONLY_PREFIXES_EXTRA].some(p => fileName.startsWith(p));
}

export interface JarMeta {
    /** Mod ids this jar provides. */
    ids: string[];
    /** Mod ids this jar needs on a dedicated server. */
    requires: string[];
    /** The jar itself says it is client-only. */
    clientOnlyFlag: boolean;
}

const META_FILES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info'];
const PLATFORM_IDS = new Set(['minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'java', 'quilt_loader']);

/** Read mod ids, server-side required dependencies and the client-only flag from a jar. */
export async function readJarMeta(jarPath: string): Promise<JarMeta> {
    const meta: JarMeta = { ids: [], requires: [], clientOnlyFlag: false };
    const files = await readEntries(jarPath, META_FILES).catch(() => ({} as Record<string, string>));

    for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
        const raw = files[name];
        if (!raw) continue;
        try {
            const j = JSON.parse(raw) as {
                id?: string;
                environment?: string;
                depends?: Record<string, unknown>;
                quilt_loader?: { id?: string; minecraft?: { environment?: string }; depends?: (string | { id: string })[] };
            };
            const id = j.id ?? j.quilt_loader?.id;
            if (id) meta.ids.push(id);
            if ((j.environment ?? j.quilt_loader?.minecraft?.environment) === 'client') meta.clientOnlyFlag = true;
            meta.requires.push(...Object.keys(j.depends ?? {}));
            for (const d of j.quilt_loader?.depends ?? []) meta.requires.push(typeof d === 'string' ? d : d.id);
        } catch {
            // ignore unparsable metadata
        }
    }

    for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
        const raw = files[name];
        if (!raw) continue;
        if (/^\s*clientSideOnly\s*=\s*true\b/m.test(raw)) meta.clientOnlyFlag = true;
        for (const block of tomlBlocks(raw)) {
            if (block.header === 'mods' && block.values.modId) meta.ids.push(block.values.modId);
            if (!block.header.startsWith('dependencies.')) continue;
            const v = block.values;
            const required = v.type ? v.type.toLowerCase() === 'required' : v.mandatory === 'true';
            const side = (v.side || 'BOTH').toUpperCase();
            if (v.modId && required && side !== 'CLIENT') meta.requires.push(v.modId);
        }
    }

    if (files['mcmod.info']) {
        try {
            const j = JSON.parse(files['mcmod.info']) as unknown;
            const list = (Array.isArray(j) ? j : (j as { modList?: unknown[] }).modList ?? []) as {
                modid?: string;
                requiredMods?: string[];
            }[];
            for (const m of list) {
                if (m.modid) meta.ids.push(m.modid);
                for (const r of m.requiredMods ?? []) meta.requires.push(r.split('@')[0]);
            }
        } catch {
            // ignore
        }
    }

    meta.requires = meta.requires.filter(r => !PLATFORM_IDS.has(r));
    return meta;
}

/** Back-compat helper for single-jar checks. */
export async function isClientOnlyByMetadata(jarPath: string): Promise<boolean> {
    return (await readJarMeta(jarPath)).clientOnlyFlag;
}

/**
 * Remove client-only mods from a mods folder of a client-manifest install.
 * Candidates: jars flagged client-only in their metadata, or matching
 * ServerPackCreator's name list. A candidate is kept when another kept mod
 * requires one of its mod ids on the server (e.g. AE2 needs GuideME).
 * Only jars in `onlyThese` (when given) are candidates; all jars count as
 * dependents. Returns the removed file names.
 */
export async function removeClientOnlyMods(modsDir: string, onlyThese?: Set<string>): Promise<string[]> {
    const jars = (await fs.readdir(modsDir)).filter(f => f.endsWith('.jar'));
    const metas = new Map<string, JarMeta>();
    for (const jar of jars) metas.set(jar, await readJarMeta(path.join(modsDir, jar)));

    const candidates = new Set(
        jars.filter(j => (!onlyThese || onlyThese.has(j)) && (metas.get(j)!.clientOnlyFlag || isClientOnlyByName(j)))
    );
    // Fixpoint: a kept candidate's own requirements may protect further candidates.
    let changed = true;
    while (changed) {
        changed = false;
        const needed = new Set<string>();
        for (const jar of jars) {
            if (!candidates.has(jar)) for (const r of metas.get(jar)!.requires) needed.add(r);
        }
        for (const jar of [...candidates]) {
            const hit = metas.get(jar)!.ids.find(id => needed.has(id));
            if (hit) {
                candidates.delete(jar);
                log.info(`Keeping ${jar}: listed as client-only, but another mod requires "${hit}".`);
                changed = true;
            }
        }
    }

    for (const jar of candidates) await fs.remove(path.join(modsDir, jar));
    return [...candidates];
}

interface TomlBlock {
    header: string;
    values: Record<string, string>;
}

/** Minimal TOML reader for mods.toml: [[table]] headers and key = "value" / key = bare pairs. */
function tomlBlocks(raw: string): TomlBlock[] {
    const blocks: TomlBlock[] = [];
    let current: TomlBlock = { header: '', values: {} };
    for (const line of raw.split(/\r?\n/)) {
        const header = /^\s*\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
        if (header) {
            blocks.push(current);
            current = { header: header[1], values: {} };
            continue;
        }
        const kv = /^\s*([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/.exec(line);
        if (kv) current.values[kv[1]] = kv[2] ?? kv[3] ?? kv[4];
    }
    blocks.push(current);
    return blocks;
}

function readEntries(file: string, wanted: string[]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err || !zip) return reject(err);
            const out: Record<string, string> = {};
            zip.on('error', reject);
            zip.on('end', () => resolve(out));
            zip.on('entry', (entry: yauzl.Entry) => {
                if (!wanted.includes(entry.fileName)) return zip.readEntry();
                zip.openReadStream(entry, (e, stream) => {
                    if (e || !stream) return reject(e);
                    const chunks: Buffer[] = [];
                    stream.on('data', (c: Buffer) => chunks.push(c));
                    stream.on('end', () => {
                        out[entry.fileName] = Buffer.concat(chunks).toString('utf8');
                        zip.readEntry();
                    });
                    stream.on('error', reject);
                });
            });
            zip.readEntry();
        });
    });
}
