import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import fs from 'fs-extra';
import yauzl from 'yauzl';
import { log } from './util/logger.js';
import { safeFolderName } from './util/safeName.js';

export async function unzip(
    zipName: string,
    modpackName: string,
    _fileExt: string,
    thisDir: string,
    output: string | false = false
): Promise<string> {
    let extractDir = path.join(
        thisDir,
        output || safeFolderName(modpackName)
    );

    const archive = path.join(thisDir, zipName);

    // When the download URL has no filename/extension (e.g. ends in a bare
    // UUID), the derived folder name collides with the archive filename, so
    // extractDir === archive. ensureDir would then mkdir over the zip file and
    // throw EEXIST. Use a distinct dir in that case.
    if (path.resolve(extractDir) === path.resolve(archive)) {
        extractDir = `${extractDir}_extracted`;
    }

    log.info(`Unpacking ${archive} -> ${extractDir}`);
    await fs.ensureDir(extractDir);
    await extractZip(archive, extractDir);

    log.info('Extraction done, deleting zip');
    await fs.remove(archive);
    return path.basename(extractDir);
}

/**
 * Stream-extract every entry of a zip into targetDir, one entry at a time,
 * so memory use does not depend on archive size (Wings runs the install
 * container with ~1 GB). Rejects entries that would land outside targetDir.
 */
export async function extractZip(archive: string, targetDir: string): Promise<void> {
    const root = path.resolve(targetDir);
    const zip = await openZip(archive);
    let count = 0;

    try {
        await new Promise<void>((resolve, reject) => {
            const fail = (err: unknown): void => {
                zip.close();
                reject(err instanceof Error ? err : new Error(String(err)));
            };

            zip.on('error', fail);
            zip.on('end', () => resolve());
            zip.on('entry', (entry: yauzl.Entry) => {
                handleEntry(zip, entry, root)
                    .then(() => {
                        count++;
                        zip.readEntry();
                    })
                    .catch(fail);
            });
            zip.readEntry();
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Extracting ${archive} failed after ${count} entries: ${msg}`);
    }
    log.info(`Extracted ${count} entries.`);
}

async function handleEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, root: string): Promise<void> {
    const name = entry.fileName.replace(/\\/g, '/');
    const dest = path.resolve(root, name);
    // Zip-slip guard. yauzl already rejects absolute and "../" names, but
    // check again so nothing can write outside the target dir.
    if (dest !== root && !dest.startsWith(root + path.sep)) {
        throw new Error(`Refusing zip entry outside target dir: ${entry.fileName}`);
    }

    if (name.endsWith('/')) {
        await fs.ensureDir(dest);
        return;
    }

    await fs.ensureDir(path.dirname(dest));
    const input = await openEntryStream(zip, entry);
    // Keep the executable bit (start scripts, installer binaries).
    const unixMode = (entry.externalFileAttributes >>> 16) & 0o777;
    const mode = unixMode & 0o111 ? 0o755 : 0o644;
    await pipeline(input, fs.createWriteStream(dest, { mode }));
}

function openZip(archive: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(archive, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err || !zip) reject(err ?? new Error(`Could not open ${archive}`));
            else resolve(zip);
        });
    });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) reject(err ?? new Error(`Could not read ${entry.fileName}`));
            else resolve(stream);
        });
    });
}
