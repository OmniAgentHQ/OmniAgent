import { heavyTask, inHeavyTask } from './heavyTask';
import fs from 'node:fs';

type Extraction = {
  text: string;
  pages: number;
  totalCharacters: number;
  pagesWithText: number;
  scanned: boolean;
};

type TextItem = { str?: string; transform?: number[]; hasEOL?: boolean };

let cachedLibrary: Promise<{ getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> } }> | null = null;

type PdfDocument = {
  numPages: number;
  getPage(index: number): Promise<{ getTextContent(): Promise<{ items: TextItem[] }> }>;
  destroy(): Promise<void>;
};

function library() {
  if (!cachedLibrary) {
    cachedLibrary = import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<{
      getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> };
    }>;
  }
  return cachedLibrary;
}

function linesFromItems(items: TextItem[]) {
  const rows = new Map<number, Array<{ x: number; text: string }>>();
  for (const item of items) {
    const value = String(item.str ?? '');
    if (!value.trim()) continue;
    const transform = item.transform ?? [];
    const y = Math.round(Number(transform[5] ?? 0));
    const x = Number(transform[4] ?? 0);
    const key = Math.round(y / 3) * 3;
    const row = rows.get(key) ?? [];
    row.push({ x, text: value });
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([, row]) => row.sort((left, right) => left.x - right.x).map((cell) => cell.text).join(''))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function extractPdfText(filePath: string, window?: { offset: number; limit: number }, signal?: AbortSignal): Promise<Extraction> {
  if (!inHeavyTask()) return heavyTask<Extraction>('pdf', [filePath, window], signal);
  if (!fs.existsSync(filePath)) throw new Error(`That PDF does not exist: ${filePath}`);
  const bytes = await fs.promises.readFile(filePath);
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new Error(`${filePath} is not a PDF file.`);
  }
  const { getDocument } = await library();
  const document = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0
  }).promise;

  const pages: string[] = [];
  let pagesWithText = 0;
  let characters = 0;
  try {
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = linesFromItems(content.items);
      if (text.trim()) {
        const part = (pagesWithText ? '\n\n' : '') + text;
        pagesWithText++;
        if (window) {
          const start = Math.max(0, window.offset - characters);
          const end = Math.max(0, Math.min(part.length, window.offset + window.limit - characters));
          if (end > start) pages.push(part.slice(start, end));
        } else pages.push(part);
        characters += part.length;
      }
      if ('cleanup' in page) (page as any).cleanup();
    }
  } finally {
    await document.destroy().catch(() => undefined);
  }

  return {
    text: window ? pages.join('') : pages.join('').replace(/\n{3,}/g, '\n\n').trim(),
    totalCharacters: characters,
    pages: document.numPages,
    pagesWithText,
    scanned: document.numPages > 0 && pagesWithText === 0
  };
}

export async function pdfTextOrGuidance(filePath: string, limit = 250_000, signal?: AbortSignal, offset = 0) {
  const result = await extractPdfText(filePath, { offset, limit }, signal);
  if (result.scanned) {
    throw new Error(
      `${filePath} has ${result.pages} page(s) but no text layer, so it is a scan or image-only PDF. Open it with open_page and read it on screen, or ask the user for a text version.`
    );
  }
  const header = `PDF: ${result.pages} page(s), text found on ${result.pagesWithText}.`;
  const more = offset + limit < result.totalCharacters ? `\n[More text: call read_file with offset ${offset + limit}.]` : '';
  return `${header}\n\n${result.text}${more}`;
}
