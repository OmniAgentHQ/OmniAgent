import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

export async function editTextFile(file: string, needle: string, replacement: string, all: boolean, temporaryPath?: string) {
  if (!needle) throw new Error('The text to replace cannot be empty.');
  const temporary = temporaryPath ?? `${file}.${crypto.randomUUID()}.partial`;
  const stat = await fsp.stat(file);
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: stat.mode });
  const completion = finished(output);
  void completion.catch(() => undefined);
  let tail = '';
  let occurrences = 0;
  const write = async (text: string) => { if (text && !output.write(text)) await once(output, 'drain'); };
  try {
    for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
      tail += chunk;
      let index: number;
      while ((index = tail.indexOf(needle)) !== -1) {
        occurrences++;
        if (!all && occurrences > 1) throw new Error('The text occurs more than once. Include more context or set replace_all to true.');
        await write(tail.slice(0, index) + replacement);
        tail = tail.slice(index + needle.length);
      }
      const safe = Math.max(0, tail.length - needle.length + 1);
      await write(tail.slice(0, safe)); tail = tail.slice(safe);
    }
    if (!occurrences) throw new Error('The exact text was not found. Read the file and copy the text including whitespace.');
    await write(tail); output.end(); await completion;
    await fsp.rename(temporary, file);
    return { edited: file, replacements: occurrences, bytesBefore: stat.size, bytesAfter: (await fsp.stat(file)).size, verified: true };
  } finally { output.destroy(); await completion.catch(() => undefined); await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function searchFiles(root: string, pattern: string, glob: boolean) {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.git', 'Trash']);
  const collect = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= 5000) return;
    const directoryHandle = await fsp.opendir(directory).catch(() => undefined);
    if (!directoryHandle) return;
    for await (const entry of directoryHandle) {
      if (files.length >= 5000) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) await collect(full, depth + 1); }
      else if (entry.isFile()) files.push(full);
    }
  };
  await collect(root, 0);
  if (glob) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]').replace(/\u0001/g, '.*');
    const matcher = new RegExp(`(?:^|[/\\\\])${escaped}$`, 'i');
    const matches = files.filter(file => matcher.test(file) || matcher.test(path.relative(root, file).split(path.sep).join('/')));
    return { pattern, root, matchCount: matches.length, matches: matches.slice(0, 300) };
  }
  let matcher: RegExp;
  try { matcher = new RegExp(pattern, 'i'); } catch { matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    if (matches.length >= 200) break;
    if ((await fsp.stat(file)).size > 2_000_000) continue;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let line = 0;
    try {
      for await (const text of lines) {
        line++;
        if (text.includes('\0')) break;
        if (matcher.test(text)) matches.push({ file, line, text: text.trim().slice(0, 300) });
        if (matches.length >= 200) break;
      }
    } finally { lines.close(); input.destroy(); }
  }
  return { pattern, root, matchCount: matches.length, matches };
}
