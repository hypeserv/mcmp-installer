import path from 'node:path';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import { log } from './util/logger.js';

export async function unzip(
    zipName: string,
    modpackName: string,
    _fileExt: string,
    thisDir: string,
    output: string | false = false
): Promise<string> {
    let extractDir = path.join(
        thisDir,
        output || modpackName.replace(/[:,\s]/g, '_')
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

    const zip = new AdmZip(archive);
    zip.extractAllTo(extractDir, true);

    log.info('Extraction done, deleting zip');
    await fs.remove(archive);
    return path.basename(extractDir);
}
