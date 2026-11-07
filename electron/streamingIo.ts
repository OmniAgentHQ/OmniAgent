import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const abortDelay = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });

export async function hashFile(file: string, signal?: AbortSignal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function readRange(file: string, length: number, offset = 0, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await fsp.open(file, 'r');
  try {
    const data = Buffer.alloc(Math.max(0, Math.floor(length)));
    const { bytesRead } = await handle.read(data, 0, data.length, Math.max(0, Math.floor(offset)));
    signal?.throwIfAborted();
    return data.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function readTextRange(file: string, length: number, offset = 0, signal?: AbortSignal) {
  const buffer = await readRange(file, length + 4, offset, signal);
  let end = Math.min(length, buffer.length);
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end++;
  return { text: buffer.subarray(0, end).toString('utf8'), nextOffset: offset + end };
}

export function readTextPrefix(file: string, length = 250_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(length);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}

export async function readResponse(response: Response, maximumBytes: number, signal?: AbortSignal, prefixOnly = false) {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let count = 0;
  const stream = Readable.fromWeb(response.body as any, { signal });
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    if (count + chunk.length > maximumBytes) {
      if (!prefixOnly) throw new Error(`Response exceeds the ${maximumBytes}-byte text/image processing limit. Download it as a file instead.`);
      chunks.push(chunk.subarray(0, maximumBytes - count));
      count = maximumBytes;
      break;
    }
    count += chunk.length;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, count);
}

export async function saveResponse(response: Response, destination: string, signal?: AbortSignal,
  progress?: (bytes: number, total?: number) => void) {
  signal?.throwIfAborted();
  if (!response.body) throw new Error('The download returned no file content.');
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.partial`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const declared = Number(response.headers.get('content-length') ?? 0);
  let lastReport = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    hash.update(chunk); bytes += chunk.length;
    if (Date.now() - lastReport > 250) { lastReport = Date.now(); progress?.(bytes, declared || undefined); }
    done(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as any), meter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
    if (!bytes) throw new Error('The download returned an empty file.');
    if (declared && !response.headers.get('content-encoding') && declared !== bytes) throw new Error('The download ended before the complete file arrived.');
    signal?.throwIfAborted();
    await fsp.rename(temporary, destination);
    progress?.(bytes, declared || undefined);
    return { bytes, sha256: hash.digest('hex') };
  } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function copyPath(source: string, destination: string, signal?: AbortSignal, errorOnExist = false): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    await fsp.cp(source, destination, { dereference: false, force: !errorOnExist, errorOnExist });
  } else if (stat.isDirectory()) {
    const relative = path.relative(path.resolve(source), path.resolve(destination));
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('A folder cannot be copied into itself.');
    await fsp.mkdir(destination, { recursive: true });
    for await (const entry of await fsp.opendir(source)) await copyPath(path.join(source, entry.name), path.join(destination, entry.name), signal, errorOnExist);
  } else {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.partial`;
    try {
      await pipeline(fs.createReadStream(source), fs.createWriteStream(temporary, { flags: 'wx', mode: stat.mode }), { signal });
      signal?.throwIfAborted();
      if (errorOnExist) { await fsp.link(temporary, destination); await fsp.unlink(temporary); }
      else await fsp.rename(temporary, destination);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
  }
}

export async function removePath(target: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fsp.lstat(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for await (const entry of await fsp.opendir(target)) await removePath(path.join(target, entry.name), signal);
    signal?.throwIfAborted();
    await fsp.rmdir(target);
  } else await fsp.unlink(target);
}
