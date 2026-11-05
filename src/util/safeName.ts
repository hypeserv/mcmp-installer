/**
 * Folder name for an extracted pack. ASCII only: Java in the install
 * container (no UTF-8 locale) can't open paths like "Prominence™_II", which
 * made the Fabric installer fail.
 */
export function safeFolderName(name: string): string {
    const ascii = name
        .normalize('NFKD') // ™ -> TM, é -> e + accent
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._]+|[._]+$/g, '');
    return ascii || 'modpack';
}

/** Env for java child processes: UTF-8 file names even without a system locale. */
export function javaEnv(): NodeJS.ProcessEnv {
    return { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}
