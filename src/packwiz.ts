import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import { download } from './downloadFile.js';
import { log } from './util/logger.js';

const BOOTSTRAP_URL =
    'https://github.com/packwiz/packwiz-installer-bootstrap/releases/download/v0.0.3/packwiz-installer-bootstrap.jar';

/**
 * Some server packs (e.g. GregTech Community Pack Modern) ship no mods, only
 * a start script that runs packwiz-installer-bootstrap against a pack.toml
 * URL on first start. The panel never runs those scripts, so find the
 * pack.toml URL and run packwiz at install time instead.
 */
export async function findPackwizPackUrl(dir: string): Promise<string | null> {
    for (const name of await fs.readdir(dir)) {
        if (!name.endsWith('.sh')) continue;
        const script = await fs.readFile(path.join(dir, name), 'utf8');
        if (!script.includes('packwiz-installer')) continue;
        const url = extractPackTomlUrl(script);
        if (url) return url;
    }
    return null;
}

/** Find the pack.toml URL in a shell script, expanding simple VAR="x" assignments. */
export function extractPackTomlUrl(script: string): string | null {
    const vars: Record<string, string> = {};
    for (const m of script.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/gm)) {
        vars[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const expand = (s: string): string =>
        s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => vars[a ?? b] ?? all);

    for (const line of script.split(/\r?\n/)) {
        if (/^\s*#/.test(line) || !line.includes('packwiz-installer')) continue;
        const m = expand(line).match(/(https?:\/\/[^\s"']+pack\.toml)/);
        if (m && !m[1].includes('$')) return m[1];
    }
    // URL kept in a variable that is passed to the installer line.
    for (const value of Object.values(vars)) {
        const m = expand(value).match(/^(https?:\/\/[^\s"']+pack\.toml)$/);
        if (m && !m[1].includes('$')) return m[1];
    }
    return null;
}

export async function runPackwiz(dir: string, packUrl: string): Promise<void> {
    log.info(`Pack ships a packwiz bootstrap, installing mods from ${packUrl}...`);
    const prev = process.cwd();
    process.chdir(dir);
    try {
        const file = await download(BOOTSTRAP_URL);
        if (file !== 'packwiz-installer-bootstrap.jar') {
            await fs.move(path.join(dir, file), path.join(dir, 'packwiz-installer-bootstrap.jar'), { overwrite: true });
        }
    } finally {
        process.chdir(prev);
    }

    const code = await new Promise<number | null>((resolve, reject) => {
        const proc = spawn('java', ['-jar', 'packwiz-installer-bootstrap.jar', '-g', '-s', 'server', packUrl], {
            cwd: dir,
            stdio: 'inherit'
        });
        proc.on('exit', resolve);
        proc.on('error', reject);
    });
    if (code !== 0) {
        // The packs' own start scripts ignore this and start anyway; a single
        // missing config file upstream shouldn't block the install. Only fail
        // when no mods arrived at all.
        const modsDir = path.join(dir, 'mods');
        const mods = (await fs.pathExists(modsDir))
            ? (await fs.readdir(modsDir)).filter(f => f.endsWith('.jar'))
            : [];
        if (mods.length === 0) {
            throw new Error(`packwiz-installer exited with code ${code} for ${packUrl} and installed no mods`);
        }
        log.warn(`packwiz-installer exited with code ${code} (see errors above); ${mods.length} mods installed, continuing.`);
        return;
    }
    log.info('packwiz install finished.');
}
