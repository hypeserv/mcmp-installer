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
    const extractDir = path.join(
        thisDir,
        output || modpackName.replace(/[:,\s]/g, '_')
    );

    const archive = path.join(thisDir, zipName);
    log.info(`Unpacking ${archive} -> ${extractDir}`);
    await fs.ensureDir(extractDir);

    const zip = new AdmZip(archive);
    zip.extractAllTo(extractDir, true);

    log.info('Extraction done, deleting zip');
    await fs.remove(archive);
    return path.basename(extractDir);
}
