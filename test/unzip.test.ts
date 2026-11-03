import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import fs from 'fs-extra';
import yazl from 'yazl';
import { unzip, extractZip } from '../src/unzipModpack.js';

async function tmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'mcmp-unzip-'));
}

function writeZip(file: string, add: (z: yazl.ZipFile) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const z = new yazl.ZipFile();
        add(z);
        z.end();
        z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
    });
}

/**
 * Hand-built single-entry zip (stored). yazl refuses unsafe names, so a
 * zip-slip archive has to be written by hand.
 */
function rawZip(name: string, content: string): Buffer {
    const data = Buffer.from(content);
    const fileName = Buffer.from(name);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);

    const cdOffset = local.length + fileName.length + data.length;
    const cdSize = central.length + fileName.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([local, fileName, data, central, fileName, end]);
}

test('extracts files and dirs, keeps the exec bit, deletes the zip', async () => {
    const dir = await tmpDir();
    await writeZip(path.join(dir, 'pack.zip'), z => {
        z.addEmptyDirectory('ServerFiles/config/');
        z.addBuffer(Buffer.from('jar'), 'ServerFiles/mods/a.jar');
        z.addBuffer(Buffer.from('#!/bin/sh\n'), 'ServerFiles/startserver.sh', { mode: 0o100755 });
    });

    const folder = await unzip('pack.zip', 'My Pack', '.zip', dir);

    assert.equal(folder, 'My_Pack');
    const out = path.join(dir, folder);
    assert.equal(await fs.readFile(path.join(out, 'ServerFiles/mods/a.jar'), 'utf8'), 'jar');
    assert.ok((await fs.stat(path.join(out, 'ServerFiles/config'))).isDirectory());
    assert.ok((await fs.stat(path.join(out, 'ServerFiles/startserver.sh'))).mode & 0o100);
    assert.equal((await fs.stat(path.join(out, 'ServerFiles/mods/a.jar'))).mode & 0o111, 0);
    assert.equal(await fs.pathExists(path.join(dir, 'pack.zip')), false);
    await fs.remove(dir);
});

test('uses <name>_extracted when the folder name equals the archive name', async () => {
    const dir = await tmpDir();
    await writeZip(path.join(dir, 'abc123'), z => z.addBuffer(Buffer.from('x'), 'f.txt'));

    const folder = await unzip('abc123', 'abc123', '', dir);

    assert.equal(folder, 'abc123_extracted');
    assert.equal(await fs.readFile(path.join(dir, folder, 'f.txt'), 'utf8'), 'x');
    await fs.remove(dir);
});

for (const evil of ['../evil.txt', 'sub/../../evil.txt', '/tmp/mcmp-evil-abs.txt']) {
    test(`rejects zip-slip entry ${evil}`, async () => {
        const dir = await tmpDir();
        const target = path.join(dir, 'out');
        await fs.ensureDir(target);
        const archive = path.join(dir, 'evil.zip');
        await fs.writeFile(archive, rawZip(evil, 'pwned'));

        await assert.rejects(extractZip(archive, target), /Extracting .* failed/);
        assert.equal(await fs.pathExists(path.join(dir, 'evil.txt')), false);
        assert.equal(await fs.pathExists('/tmp/mcmp-evil-abs.txt'), false);
        await fs.remove(dir);
    });
}

// Highly compressible entry: small archive, large output. A whole-archive or
// whole-entry buffer (the old AdmZip path) would push RSS up by the entry size.
const LARGE_MB = Number(process.env.LARGE_ZIP_MB || 512);
test(`extracts a ${LARGE_MB} MB entry with bounded memory`, async () => {
    const dir = await tmpDir();
    const archive = path.join(dir, 'big.zip');
    const chunk = Buffer.alloc(1024 * 1024);
    await writeZip(archive, z => {
        z.addReadStream(
            Readable.from((function* () {
                for (let i = 0; i < LARGE_MB; i++) yield chunk;
            })()),
            'big/world.bin'
        );
    });

    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    try {
        await extractZip(archive, path.join(dir, 'out'));
    } finally {
        clearInterval(timer);
    }

    const size = (await fs.stat(path.join(dir, 'out/big/world.bin'))).size;
    assert.equal(size, LARGE_MB * 1024 * 1024);
    const growthMb = (peak - base) / 1024 / 1024;
    assert.ok(growthMb < 150, `RSS grew by ${growthMb.toFixed(0)} MB`);
    await fs.remove(dir);
});
