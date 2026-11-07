import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
function xmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
export function plainTextFromDocx(filePath: string) {
  const zip = new AdmZip(filePath);
  const document = zip.getEntry('word/document.xml')?.getData().toString('utf8') ?? '';
  return document
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function plainTextFromXlsx(filePath: string) {
  const zip = new AdmZip(filePath);
  const shared = (zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') ?? '')
    .split(/<si\b[^>]*>/).slice(1)
    .map((item) => item.split('</si>')[0].replace(/<[^>]+>/g, ''));
  const decode = (value: string) => value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const sheets = zip.getEntries()
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName));
  const out: string[] = [];
  for (const sheet of sheets) {
    if (sheets.length > 1) out.push(`# ${sheet.entryName.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '')}`);
    const xml = sheet.getData().toString('utf8');
    for (const row of xml.split(/<row\b[^>]*>/).slice(1)) {
      const cells: string[] = [];
      for (const cell of row.split('</c>').slice(0, -1)) {
        const type = cell.match(/\st="([^"]+)"/)?.[1] ?? '';
        const raw = cell.match(/<(?:v|t)[^>]*>([\s\S]*?)<\/(?:v|t)>/)?.[1] ?? '';
        cells.push(decode(type === 's' ? (shared[Number(raw)] ?? '') : raw.replace(/<[^>]+>/g, '')));
      }
      if (cells.some((value) => value !== '')) out.push(cells.join(','));
    }
  }
  return out.join('\n').trim();
}

export function plainTextFromPptx(filePath: string) {
  const zip = new AdmZip(filePath);
  return zip.getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
    .sort((left, right) => Number(left.entryName.match(/(\d+)/)?.[1] ?? 0) - Number(right.entryName.match(/(\d+)/)?.[1] ?? 0))
    .map((entry, index) => {
      const text = entry.getData().toString('utf8')
        .replace(/<a:p\b[^>]*>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
      return `## Slide ${index + 1}\n${text}`;
    })
    .join('\n\n')
    .trim();
}

export function writeSimpleXlsx(filePath: string, content: string) {
  const splitRow = (line: string) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = !quoted;
      } else if (character === ',' && !quoted) {
        cells.push(cell);
        cell = '';
      } else cell += character;
    }
    cells.push(cell);
    return cells;
  };
  const columnName = (index: number) => {
    let name = '';
    let value = index;
    do {
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return name;
  };
  const rows = content.replace(/\r\n?/g, '\n').split('\n').filter((line, index, all) => line.trim() || index < all.length - 1);
  const sheet = rows.map((line, rowIndex) => {
    const cells = splitRow(line).map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      const trimmed = value.trim();
      if (trimmed === '') return '';

      return /^-?\d+(?:\.\d+)?$/.test(trimmed)
        ? `<c r="${reference}"><v>${trimmed}</v></c>`
        : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>',
    'utf8'
  ));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>',
    'utf8'
  ));
  zip.addFile('xl/workbook.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'utf8'
  ));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>',
    'utf8'
  ));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${sheet}</sheetData></worksheet>`,
    'utf8'
  ));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  zip.writeZip(filePath);
}

export function writeSimpleDocx(filePath: string, content: string) {
  const paragraphs = content.replace(/\r\n/g, '\n').split(/\n/);
  const documentBody = paragraphs.map((paragraph) => {
    const heading = paragraph.match(/^(#{1,3})\s+(.+)$/);
    const text = heading?.[2] ?? paragraph;
    const paragraphStyle = heading
      ? `<w:pPr><w:pStyle w:val="Heading${Math.min(heading[1].length, 3)}"/></w:pPr>`
      : '';
    return `<w:p>${paragraphStyle}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>'
  ));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'
  ));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${documentBody}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body>`
    + '</w:document>'
  ));
  zip.addFile('word/styles.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
    + '</w:styles>'
  ));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  zip.writeZip(filePath);
}
