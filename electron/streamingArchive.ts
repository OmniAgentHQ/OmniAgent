import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { ZipFile as ZipWriter } from 'yazl';

export async function visitZip(file: string, visit: (entry: Entry, zip: ZipFile) => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const zip = await openPromise(file);
  const abort = () => zip.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const entry of zip.eachEntry()) { signal?.throwIfAborted(); await visit(entry, zip); }
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener('abort', abort); zip.close(); }
}

export async function verifyZipEntry(entry: Entry, zip: ZipFile, output: NodeJS.WritableStream, signal?: AbortSignal) {
  let crc = 0;
  const check = new Transform({ transform(chunk: Buffer, _encoding, done) { crc = crc32(chunk, crc); done(null, chunk); } });
  await pipeline(await zip.openReadStreamPromise(entry), check, output, { signal });
  if ((crc >>> 0) !== (entry.crc32 >>> 0)) throw new Error(`ZIP checksum failed: ${entry.fileName}`);
}

export async function checkZip(file: string, signal?: AbortSignal) {
  let count = 0;
  await visitZip(file, async (entry, zip) => {
    if (entry.fileName.endsWith('/')) return;
    await verifyZipEntry(entry, zip, new Writable({ write(_chunk, _encoding, done) { done(); } }), signal);
    count++;
  }, signal);
  return count;
}

export async function extractZip(archive: string, destination: string, signal?: AbortSignal) {
  await fsp.mkdir(destination, { recursive: true });
  const root = await fsp.realpath(destination);
  const entries: string[] = [];
  let count = 0;
  await visitZip(archive, async (entry, zip) => {
    const target = path.resolve(root, entry.fileName);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP entry escapes its destination.');
    let parent = root;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, part);
      const existing = await fsp.lstat(parent).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new Error('ZIP destination contains a symbolic link.');
      await fsp.mkdir(parent, { recursive: true });
    }
    if (entry.fileName.endsWith('/')) {
      const existing = await fsp.lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new Error('ZIP destination contains a symbolic link.');
      await fsp.mkdir(target, { recursive: true }); return;
    }
    const temporary = `${target}.${crypto.randomUUID()}.partial`;
    try {
      await verifyZipEntry(entry, zip, fs.createWriteStream(temporary, { flags: 'wx' }), signal);
      signal?.throwIfAborted();
      await fsp.rename(temporary, target);
      const mode = (entry.externalFileAttributes >>> 16) & 0o777;
      if (mode && process.platform !== 'win32') await fsp.chmod(target, mode);
      count++;
      if (entries.length < 300) entries.push(entry.fileName);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
  }, signal);
  if (!count) throw new Error('The ZIP archive did not contain any files.');
  return { archive, destination, extractedFiles: entries, fileCount: count, listingTruncated: count > entries.length, verified: true };
}

export async function createZip(source: string, archive: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const writer = new ZipWriter();
  await fsp.mkdir(path.dirname(archive), { recursive: true });
  const temporary = `${archive}.${crypto.randomUUID()}.partial`;
  const output = writer.outputStream as NodeJS.ReadableStream & { destroy(error?: Error): void };
  const fail = (error: Error) => output.destroy(error);
  writer.on('error', fail);
  const write = pipeline(output, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
  void write.catch(() => undefined);
  let count = 0;
  const add = async (file: string, name: string): Promise<void> => {
    signal?.throwIfAborted();
    if (path.resolve(file) === path.resolve(archive) || file === temporary) return;
    const stat = await fsp.lstat(file);
    if (stat.isDirectory()) {
      writer.addEmptyDirectory(name, { mode: stat.mode, mtime: stat.mtime });
      for await (const entry of await fsp.opendir(file)) await add(path.join(file, entry.name), `${name}/${entry.name}`);
    } else {
      writer.addReadStreamLazy(name, { mode: stat.mode, mtime: stat.mtime }, done => {
        if (signal?.aborted) { done(new DOMException('Stopped', 'AbortError'), undefined as any); return; }
        done(null, fs.createReadStream(file, { signal }));
      });
      count++;
    }
  };
  try {
    await add(source, path.basename(source));
    if (!count) throw new Error('There are no files to compress.');
    writer.end();
    await write;
    const checked = await checkZip(temporary, signal);
    if (checked !== count) throw new Error('The ZIP archive did not pass verification.');
    signal?.throwIfAborted();
    await fsp.rename(temporary, archive);
    return { archived: source, archive, fileCount: count, bytes: (await fsp.stat(archive)).size, verified: true };
  } finally {
    output.destroy();
    await write.catch(() => undefined);
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}
