import { heavyTask, inHeavyTask } from './heavyTask';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { inspectDocument, inspectImage } from './artifactInspection';

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeOutput(source: string, requested: unknown) {
  const output = requested ? path.resolve(String(requested)) : path.resolve(source);
  if (!['.docx', '.xlsx', '.pptx', '.pdf', '.zip', '.json', '.csv', '.txt', '.md'].includes(path.extname(output).toLowerCase())) {
    throw new Error(`Unsupported document output format: ${path.extname(output) || '(none)'}.`);
  }
  return output;
}

function relationshipXml(id: string, target: string) {
  return `<Relationship Id="${escapeXml(id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(target)}"/>`;
}

function firstImagePath(value: unknown): string | undefined {
  if (typeof value === 'string' && /\.(?:png|jpe?g|gif)$/i.test(value) && fs.existsSync(value)) return path.resolve(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImagePath(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['path', 'imagePath', 'matches', 'entries', 'files']) {
      const found = firstImagePath(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

export function inlineImageMarker(line: string) {
  const match = String(line ?? '').trim().match(/^!\[[^\]]*\]\((.+)\)$/);
  if (!match) return undefined;
  const candidate = match[1].trim().replace(/^["']|["']$/g, '');
  if (!/\.(?:png|jpe?g)$/i.test(candidate)) return undefined;
  return path.resolve(candidate);
}

export function unsupportedInlineImageMarker(line: string) {
  const match = String(line ?? '').trim().match(/^!\[[^\]]*\]\((.+)\)$/);
  if (!match) return undefined;
  const candidate = match[1].trim().replace(/^["']|["']$/g, '');
  if (/\.(?:png|jpe?g)$/i.test(candidate)) return undefined;
  if (!/\.[A-Za-z0-9]{1,5}$/.test(candidate)) return undefined;
  return path.resolve(candidate);
}

function paragraphXml(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return '<w:p/>';
  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
  const text = escapeXml(heading?.[2] ?? bullet?.[1] ?? trimmed);
  const prefix = bullet ? '• ' : '';
  const runProperties = heading
    ? `<w:rPr><w:b/><w:sz w:val="${heading[1].length === 1 ? 34 : heading[1].length === 2 ? 30 : 26}"/></w:rPr>`
    : '';
  return `<w:p><w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(prefix)}${text}</w:t></w:r></w:p>`;
}

const WIN_ANSI_EXTRA = new Set(
  ('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
    + ' ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿'
    + 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß'
    + 'àáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ').split('')
);

function pdfSafeText(value: string) {
  return [...value.normalize('NFC')]
    .map((character) => {
      if (character === '\n') return character;
      if (character >= '\x20' && character <= '\x7E') return character;
      if (WIN_ANSI_EXTRA.has(character)) return character;
      const folded = character.normalize('NFKD').replace(/\p{M}/gu, '');
      const usable = [...folded].every((part) =>
        (part >= '\x20' && part <= '\x7E') || WIN_ANSI_EXTRA.has(part));
      return usable && folded ? folded : '?';
    })
    .join('');
}

function wrappedLines(value: string, maximumCharacters: number) {
  const lines: string[] = [];
  for (const rawLine of String(value).replace(/\r\n?/g, '\n').split('\n')) {
    if (inlineImageMarker(rawLine) || unsupportedInlineImageMarker(rawLine)) {
      lines.push(rawLine.trim());
      continue;
    }
    const words = pdfSafeText(rawLine).trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maximumCharacters) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export class DocumentEngine {
  async execute(operation: string, options: Record<string, unknown>, value?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!inHeavyTask()) return heavyTask<any>('document', [operation, options, value], signal);
    if (operation === 'createDocument') return this.createDocument(options, value);
    if (operation === 'inspect' || operation === 'reopen') {
      const filePath = path.resolve(String(value ?? options.path ?? ''));
      if (!fs.existsSync(filePath)) throw new Error(`Document does not exist: ${filePath}`);
      const inspection = await inspectDocument(filePath);
      if (operation === 'reopen' && !inspection.reopenable) throw new Error(`Document cannot be reopened: ${filePath}`);
      return inspection;
    }
    if (operation === 'save') {
      const source = path.resolve(String(options.source ?? value ?? ''));
      const destination = safeOutput(source, options.destination);
      if (!fs.existsSync(source)) throw new Error(`Document does not exist: ${source}`);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      if (source !== destination) await fsp.copyFile(source, destination);
      return inspectDocument(destination);
    }
    if (operation === 'replaceText') return this.replaceText(options, value);
    if (operation === 'insertImage') return this.insertImage(options, value);
    throw new Error(`Unsupported document operation: ${operation}.`);
  }

  private async createDocument(options: Record<string, unknown>, value?: unknown) {
    const destination = path.resolve(String(options.destination ?? options.path ?? ''));
    const extension = path.extname(destination).toLowerCase();
    if (!['.docx', '.pdf'].includes(extension)) {
      throw new Error('document.createDocument requires a .docx or .pdf destination.');
    }
    const content = String(value ?? options.content ?? '').trim();
    if (!content) throw new Error('document.createDocument requires non-empty document content.');
    const title = String(options.title ?? '').trim();
    if (extension === '.pdf') {
      return this.createPdf(destination, title, content, options.imagePath ?? options.images);
    }
    const body = [
      ...(title ? [`# ${title}`] : []),
      ...content.replace(/\r\n?/g, '\n').split('\n')
    ].map(paragraphXml).join('');
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
      'utf8'
    ));
    zip.addFile('_rels/.rels', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
      'utf8'
    ));
    zip.addFile('word/document.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${body}<w:sectPr/></w:body></w:document>`,
      'utf8'
    ));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    zip.writeZip(destination);
    const imagePath = firstImagePath(options.imagePath ?? options.images);
    if (imagePath) {
      return this.insertImage({
        path: destination,
        destination,
        imagePath,
        altText: String(options.imageAltText ?? path.basename(imagePath)),
        maxWidthInches: options.maxWidthInches ?? 6
      }, imagePath);
    }
    const inspection = await inspectDocument(destination);
    if (!inspection.reopenable) throw new Error('The created DOCX could not be reopened.');
    return { outputPath: destination, ...inspection };
  }

  private async createPdf(destination: string, title: string, content: string, imageValue?: unknown) {
    const document = await PDFDocument.create();
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 54;
    const bodySize = 11;
    const bodyLineHeight = 16;
    let page = document.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    if (title) {
      page.drawText(pdfSafeText(title), {
        x: margin,
        y,
        size: 20,
        font: bold,
        color: rgb(0.13, 0.10, 0.23)
      });
      y -= 34;
    }

    const imagePath = firstImagePath(imageValue);
    if (imagePath) {
      const imageBytes = await fsp.readFile(imagePath);
      const inspection = await inspectImage(imagePath);
      const embedded = inspection.format === 'png'
        ? await document.embedPng(imageBytes)
        : inspection.format === 'jpeg'
          ? await document.embedJpg(imageBytes)
          : undefined;
      if (!embedded) throw new Error(`Unsupported PDF image format: ${inspection.format}.`);
      const availableWidth = pageWidth - (margin * 2);
      const availableHeight = 240;
      const scale = Math.min(availableWidth / embedded.width, availableHeight / embedded.height, 1);
      const width = embedded.width * scale;
      const height = embedded.height * scale;
      page.drawImage(embedded, {
        x: margin + ((availableWidth - width) / 2),
        y: y - height,
        width,
        height
      });
      y -= height + 24;
    }

    for (const line of wrappedLines(content, 88)) {
      if (y < margin + bodyLineHeight) {
        page = document.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      const inlineImage = inlineImageMarker(line);
      if (inlineImage) {
        if (!fs.existsSync(inlineImage)) throw new Error(`The image referenced by the report does not exist: ${inlineImage}`);
        const bytes = await fsp.readFile(inlineImage);
        const format = await (await inspectImage(inlineImage)).format;
        const picture = format === 'png' ? await document.embedPng(bytes)
          : format === 'jpeg' ? await document.embedJpg(bytes)
            : undefined;
        if (!picture) throw new Error(`Unsupported PDF image format: ${format}.`);
        const usableWidth = pageWidth - (margin * 2);
        const scale = Math.min(usableWidth / picture.width, 220 / picture.height, 1);
        const width = picture.width * scale;
        const height = picture.height * scale;
        if (y - height < margin) {
          page = document.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        page.drawImage(picture, { x: margin, y: y - height, width, height });
        y -= height + 14;
        continue;
      }
      const unsupportedImage = unsupportedInlineImageMarker(line);
      if (unsupportedImage) {
        throw new Error(
          `This report places ${path.basename(unsupportedImage)} inline, but a PDF can only embed PNG or JPEG. `
          + 'Save the picture as .png or .jpg and reference that file instead.'
        );
      }
      if (line) {
        const heading = line.match(/^#{1,3}\s+(.+)$/);
        const bullet = line.match(/^[-*+]\s+(.+)$/);
        const text = heading?.[1] ?? (bullet ? `- ${bullet[1]}` : line);
        page.drawText(text, {
          x: margin,
          y,
          size: heading ? 14 : bodySize,
          font: heading ? bold : regular,
          color: rgb(0.10, 0.10, 0.12)
        });
      }
      y -= line ? bodyLineHeight : 8;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, await document.save({ useObjectStreams: false }));
    const inspection = await inspectDocument(destination);
    if (!inspection.reopenable) throw new Error('The created PDF could not be reopened.');
    return { outputPath: destination, ...inspection };
  }

  private async replaceText(options: Record<string, unknown>, value?: unknown) {
    const source = path.resolve(String(options.path ?? options.source ?? ''));
    const output = safeOutput(source, options.destination);
    const find = String(options.find ?? '');
    const replacement = String(value ?? options.replacement ?? '');
    if (!find) throw new Error('document.replaceText requires an exact non-empty find value.');
    if (!fs.existsSync(source)) throw new Error(`Document does not exist: ${source}`);
    const extension = path.extname(source).toLowerCase();
    if (extension === '.docx' || extension === '.xlsx' || extension === '.pptx') {
      const zip = new AdmZip(source);
      const prefixes = extension === '.docx' ? ['word/']
        : extension === '.xlsx' ? ['xl/sharedStrings.xml', 'xl/worksheets/']
          : ['ppt/slides/'];
      let replacementCount = 0;
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.endsWith('.xml') || !prefixes.some((prefix) => entry.entryName.startsWith(prefix))) continue;
        const before = entry.getData().toString('utf8');
        const count = before.split(find).length - 1;
        if (!count) continue;
        replacementCount += count;
        zip.updateFile(entry.entryName, Buffer.from(before.split(find).join(escapeXml(replacement)), 'utf8'));
      }
      if (!replacementCount) throw new Error('The exact document text was not found.');
      await fsp.mkdir(path.dirname(output), { recursive: true });
      zip.writeZip(output);
      return { replacementCount, outputPath: output, ...(await inspectDocument(output)) };
    }
    const before = await fsp.readFile(source, 'utf8');
    const replacementCount = before.split(find).length - 1;
    if (!replacementCount) throw new Error('The exact document text was not found.');
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, before.split(find).join(replacement), 'utf8');
    return { replacementCount, outputPath: output, ...inspectDocument(output) };
  }

  private async insertImage(options: Record<string, unknown>, value?: unknown) {
    const source = path.resolve(String(options.path ?? options.documentPath ?? options.source ?? ''));
    const imagePath = path.resolve(String(value ?? options.imagePath ?? ''));
    const output = safeOutput(source, options.destination);
    if (path.extname(source).toLowerCase() !== '.docx') throw new Error('document.insertImage currently requires a DOCX source.');
    if (!fs.existsSync(source)) throw new Error(`DOCX does not exist: ${source}`);
    if (!fs.existsSync(imagePath)) throw new Error(`Image does not exist: ${imagePath}`);
    const image = await inspectImage(imagePath);
    if (!['png', 'jpeg', 'gif'].includes(image.format)) throw new Error(`Unsupported DOCX image format: ${image.format}.`);

    const before = await inspectDocument(source);
    const zip = new AdmZip(source);
    const documentEntry = zip.getEntry('word/document.xml');
    if (!documentEntry) throw new Error('The DOCX package has no word/document.xml part.');
    const extension = image.format === 'jpeg' ? 'jpg' : image.format;
    const mediaName = `omniagent-${crypto.randomUUID()}.${extension}`;
    const mediaTarget = `media/${mediaName}`;
    zip.addFile(`word/${mediaTarget}`, await fsp.readFile(imagePath));

    const relationshipsPath = 'word/_rels/document.xml.rels';
    const relationshipsEntry = zip.getEntry(relationshipsPath);
    let relationships = relationshipsEntry
      ? relationshipsEntry.getData().toString('utf8')
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const ids = [...relationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
    const relationshipId = `rId${Math.max(0, ...ids) + 1}`;
    relationships = relationships.replace(/<\/Relationships>\s*$/, `${relationshipXml(relationshipId, mediaTarget)}</Relationships>`);
    if (relationshipsEntry) zip.updateFile(relationshipsPath, Buffer.from(relationships, 'utf8'));
    else zip.addFile(relationshipsPath, Buffer.from(relationships, 'utf8'));

    const typesEntry = zip.getEntry('[Content_Types].xml');
    if (!typesEntry) throw new Error('The DOCX package has no [Content_Types].xml part.');
    let contentTypes = typesEntry.getData().toString('utf8');
    const contentType = image.mimeType;
    if (!new RegExp(`<Default\\s+Extension="${extension}"`, 'i').test(contentTypes)) {
      contentTypes = contentTypes.replace(/<\/Types>\s*$/, `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`);
      zip.updateFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
    }

    const maxWidthInches = Math.max(1, Math.min(8, Number(options.maxWidthInches ?? 6)));
    const naturalWidth = Math.max(1, image.width);
    const naturalHeight = Math.max(1, image.height);
    const widthEmu = Math.round(maxWidthInches * 914400);
    const heightEmu = Math.round(widthEmu * (naturalHeight / naturalWidth));
    const drawingId = Math.floor(Math.random() * 1_000_000) + 1;
    const altText = escapeXml(String(options.altText ?? path.basename(imagePath)));
    const paragraph = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${drawingId}" name="${altText}" descr="${altText}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${altText}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    let documentXml = documentEntry.getData().toString('utf8');
    if (/<w:sectPr[\s>]/.test(documentXml)) {
      documentXml = documentXml.replace(/(<w:sectPr[\s>])/, `${paragraph}$1`);
    } else {
      documentXml = documentXml.replace(/<\/w:body>/, `${paragraph}</w:body>`);
    }
    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
    await fsp.mkdir(path.dirname(output), { recursive: true });
    zip.writeZip(output);
    const after = await inspectDocument(output);
    if (!after.reopenable || after.mediaCount !== before.mediaCount + 1) {
      throw new Error('DOCX image insertion did not satisfy its structural postconditions.');
    }
    return {
      outputPath: output,
      imagePath,
      image,
      mediaCountBefore: before.mediaCount,
      mediaCountAfter: after.mediaCount,
      reopenable: after.reopenable,
      bytes: after.bytes,
      sha256: after.sha256
    };
  }
}
