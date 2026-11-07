import { writeSimpleDocx, writeSimpleXlsx } from './simpleDocuments';
import path from 'node:path';
import { DocumentEngine } from './documentEngine';
import { inspectDocument } from './artifactInspection';
import { extractPdfText } from './pdfText';
import { officeText } from './officeText';
import { editTextFile, searchFiles } from './textFiles';

process.once('message', async ({ job, args }: { job: string; args: any[] }) => {
  try {
    let result: unknown;
    if (job === 'document') result = await new DocumentEngine().execute(args[0], args[1], args[2]);
    else if (job === 'inspectDocument') result = await inspectDocument(args[0]);
    else if (job === 'pdf') result = await extractPdfText(args[0], args[1]);
    else if (job === 'officeText') result = await officeText(args[0], args[1], args[2]);
    else if (job === 'editText') result = await editTextFile(args[0], args[1], args[2], args[3], args[4]);
    else if (job === 'search') result = await searchFiles(args[0], args[1], args[2]);
    else if (job === 'simpleDocument') result = path.extname(args[0]).toLowerCase() === '.xlsx' ? writeSimpleXlsx(args[0], args[1]) : writeSimpleDocx(args[0], args[1]);
    else if (job === 'regex') result = new RegExp(args[0]).test(args[1]);
    else throw new Error('Unknown file-processing job.');
    process.send?.({ result }, () => process.disconnect());
  } catch (error) {
    process.send?.({ error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }, () => process.disconnect());
  }
});
