import { hashFile, readRange } from './streamingIo';
import { heavyTask, inHeavyTask } from './heavyTask';
import { visitZip, checkZip } from './streamingArchive';
import fs from 'node:fs';
import path from 'node:path';

export type ImageInspection = {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'unknown';
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

export async function inspectImage(filePath: string, signal?: AbortSignal): Promise<ImageInspection> {
  const buffer = await readRange(filePath, 32, 0, signal);
  const bytes = (await fs.promises.stat(filePath)).size;
  let format: ImageInspection['format'] = 'unknown';
  let mimeType = 'application/octet-stream';
  let width = 0;
  let height = 0;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = 'png';
    mimeType = 'image/png';
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    format = 'jpeg';
    mimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 9 < bytes) {
      const header = await readRange(filePath, 9, offset, signal);
      if (header[0] !== 255) { offset++; continue; }
      const marker = header[1], length = header.readUInt16BE(2);
      if (length < 2 || marker === 0xda || marker === 0xd9) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = header.readUInt16BE(5); width = header.readUInt16BE(7); break;
      }
      offset += length + 2;
    }
  } else if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    format = 'gif';
    mimeType = 'image/gif';
    width = buffer.readUInt16LE(6);
    height = buffer.readUInt16LE(8);
  } else if (buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    format = 'webp';
    mimeType = 'image/webp';
    if (buffer.subarray(12, 16).toString('ascii') === 'VP8X') {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    }
  }
  return {
    format,
    mimeType,
    width,
    height,
    bytes,
    sha256: await hashFile(filePath, signal)
  };
}

export type DocumentInspection = {
  path: string;
  format: string;
  bytes: number;
  sha256: string;
  reopenable: boolean;
  entryCount: number;
  mediaCount: number;
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
};

export async function inspectDocument(filePath: string, signal?: AbortSignal): Promise<DocumentInspection> {
  if (!inHeavyTask()) return heavyTask<DocumentInspection>('inspectDocument', [filePath], signal);
  const absolute = path.resolve(filePath);
  const bytes = (await fs.promises.stat(absolute)).size;
  const extension = path.extname(absolute).toLowerCase();
  const base = {
    path: absolute,
    format: extension.replace('.', '') || 'unknown',
    bytes,
    sha256: await hashFile(absolute, signal),
    reopenable: false,
    entryCount: 0,
    mediaCount: 0
  };
  if (['.docx', '.xlsx', '.pptx', '.zip'].includes(extension)) {
    const names: string[] = [];
    await visitZip(absolute, async entry => { names.push(entry.fileName); }, signal);
    const required = extension === '.docx' ? 'word/document.xml'
      : extension === '.xlsx' ? 'xl/workbook.xml'
        : extension === '.pptx' ? 'ppt/presentation.xml'
          : '';
    const mediaPrefix = extension === '.docx' ? 'word/media/'
      : extension === '.xlsx' ? 'xl/media/'
        : extension === '.pptx' ? 'ppt/media/'
          : '';
    return {
      ...base,
      reopenable: required ? names.includes(required) : (await checkZip(absolute, signal)) >= 0,
      entryCount: names.length,
      mediaCount: mediaPrefix ? names.filter((name) => name.startsWith(mediaPrefix) && !name.endsWith('/')).length : 0,
      ...(extension === '.xlsx' ? { sheetCount: names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).length } : {}),
      ...(extension === '.pptx' ? { slideCount: names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length } : {})
    };
  }
  if (extension === '.pdf') {
    const text = await fs.promises.readFile(absolute, 'latin1');
    return {
      ...base,
      reopenable: text.startsWith('%PDF-') && /%%EOF\s*$/.test(text),
      entryCount: 0,
      mediaCount: (text.match(/\/Subtype\s*\/Image\b/g) ?? []).length,
      pageCount: (text.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length
    };
  }
  if (extension === '.json') {
    JSON.parse(await fs.promises.readFile(absolute, 'utf8'));
    return { ...base, reopenable: true };
  }
  if (extension === '.csv' || extension === '.txt' || extension === '.md') {
    return { ...base, reopenable: true };
  }
  return { ...base, reopenable: bytes > 0 };
}
