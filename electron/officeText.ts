import { StringDecoder } from 'node:string_decoder';
import { visitZip } from './streamingArchive';
import path from 'node:path';

const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function officeText(file: string, limit = 250_000, offset = 0) {
  const extension = path.extname(file).toLowerCase();
  const parts = new Map<string, string>();
  await visitZip(file, async (entry, zip) => {
    if (!(entry.fileName === 'word/document.xml' || entry.fileName === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.fileName) || /^ppt\/slides\/slide\d+\.xml$/i.test(entry.fileName))) return;
    let text = '';
    const decoder = new StringDecoder('utf8');
    for await (const chunk of await zip.openReadStreamPromise(entry)) text += decoder.write(chunk);
    text += decoder.end();
    parts.set(entry.fileName, text);
  });
  if (extension === '.docx') return decode((parts.get('word/document.xml') ?? '').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')).trim().slice(offset, offset + limit);
  if (extension === '.pptx') return [...parts].filter(([name]) => name.startsWith('ppt/')).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, xml], index) => `## Slide ${index + 1}\n${decode(xml.replace(/<a:p\b[^>]*>/g, '\n').replace(/<[^>]+>/g, '')).trim()}`).join('\n\n').slice(offset, offset + limit);
  const shared = (parts.get('xl/sharedStrings.xml') ?? '').split(/<si\b[^>]*>/).slice(1).map(value => value.split('</si>')[0].replace(/<[^>]+>/g, ''));
  const out: string[] = [];
  const sheets = [...parts].filter(([name]) => name.startsWith('xl/worksheets')).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, xml] of sheets) {
    if (sheets.length > 1) out.push(`# ${path.basename(name, '.xml')}`);
    for (const row of xml.split(/<row\b[^>]*>/).slice(1)) {
      const cells = row.split('</c>').slice(0, -1).map(cell => {
        const type = cell.match(/\st="([^"]+)"/)?.[1];
        const raw = cell.match(/<(?:v|t)[^>]*>([\s\S]*?)<\/(?:v|t)>/)?.[1] ?? '';
        return decode(type === 's' ? shared[Number(raw)] ?? '' : raw.replace(/<[^>]+>/g, ''));
      });
      if (cells.some(Boolean)) out.push(cells.join(','));
    }
  }
  return out.join('\n').trim().slice(offset, offset + limit);
}
