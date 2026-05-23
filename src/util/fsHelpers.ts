import fs from 'fs-extra';
import path from 'node:path';

export async function upOneDirectory(rootDir: string, subDir: string): Promise<void> {
    const subPath = path.join(rootDir, subDir);
    const entries = await fs.readdir(subPath);
    for (const entry of entries) {
        const from = path.join(subPath, entry);
        const to = path.join(rootDir, entry);
        await fs.move(from, to, { overwrite: true });
    }
}

export async function deleteDirectory(dir: string): Promise<void> {
    await fs.remove(dir);
}

export async function deleteTreeDirectory(dir: string): Promise<void> {
    await fs.remove(dir);
}
