import crypto from 'node:crypto';
import fs from 'fs-extra';

/** Problem with a downloaded file (size or sha1 mismatch), or null when it matches. */
export async function verifyFile(file: string, expect: { size?: number | null; sha1?: string | null }): Promise<string | null> {
    const stat = await fs.stat(file);
    if (expect.size && stat.size !== expect.size) return `size mismatch (${stat.size} != ${expect.size})`;
    if (expect.sha1) {
        const hash = crypto.createHash('sha1');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
        const sha1 = hash.digest('hex');
        if (sha1.toLowerCase() !== expect.sha1.toLowerCase()) return `sha1 mismatch (${sha1} != ${expect.sha1})`;
    }
    return null;
}
