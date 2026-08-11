import { createHash } from 'node:crypto';

import type { DesignConfiguration } from './designConfiguration.js';

export interface DesignPdfExportOptions {
  title?: string;
  author?: string;
  sourceUrl?: string;
  exportedAt?: Date;
}

export interface DesignPdfExport {
  fileName: 'DESIGN.pdf';
  mediaType: 'application/pdf';
  bytes: Buffer;
  checksum: string;
  metadata: {
    title: string;
    author: string;
    documentId: string;
    template: string;
    exportedAt: string;
    sourceUrl?: string;
  };
}

type PdfLineStyle = 'title' | 'meta' | 'heading' | 'body' | 'blank';
interface PdfLine { text: string; style: PdfLineStyle }

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pdfEscape(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
}

function latinFallback(value: string): string {
  return value.normalize('NFKD').replace(/[^\x20-\x7e]/gu, '?');
}

function wrapped(text: string, width: number, style: PdfLineStyle): PdfLine[] {
  if (!text) return [{ text: '', style: 'blank' }];
  const result: PdfLine[] = [];
  let remaining = latinFallback(text).trimEnd();
  while (remaining.length > width) {
    let end = remaining.lastIndexOf(' ', width);
    if (end < Math.floor(width / 2)) end = width;
    result.push({ text: remaining.slice(0, end), style });
    remaining = remaining.slice(end).trimStart();
  }
  result.push({ text: remaining, style });
  return result;
}

function markdownLines(markdown: string): PdfLine[] {
  const source = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
  return source.split(/\r?\n/u).flatMap(raw => {
    const heading = raw.match(/^#{1,6}\s+(.+)$/u);
    if (heading) return wrapped(heading[1]!, 72, 'heading');
    const cleaned = raw.replace(/[`*_>]/gu, '');
    return wrapped(cleaned, 88, cleaned.trim() ? 'body' : 'blank');
  });
}

function lineHeight(style: PdfLineStyle): number {
  if (style === 'title') return 30;
  if (style === 'heading') return 22;
  if (style === 'blank') return 9;
  return 15;
}

function paginate(lines: readonly PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [[]];
  let y = 790;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const height = lineHeight(line.style);
    let required = height;
    if (line.style === 'heading') {
      for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
        required += lineHeight(lines[lookahead]!.style);
        if (lines[lookahead]!.style !== 'blank') break;
      }
    }
    if (y - required < 58 && pages.at(-1)!.length > 0) {
      pages.push([]);
      y = 790;
    }
    pages.at(-1)!.push(line);
    y -= height;
  }
  return pages;
}

function streamObject(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
}

function buildPdf(objects: string[]): Buffer {
  let output = '%PDF-1.7\n%Hadamard\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'latin1'));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}

function lineCommand(line: PdfLine, y: number): string {
  const font = line.style === 'title' || line.style === 'heading' ? '/F2' : '/F1';
  const size = line.style === 'title' ? 19 : line.style === 'heading' ? 13 : line.style === 'meta' ? 9 : 10;
  const gray = line.style === 'meta' ? '0.38 g' : '0.08 g';
  return `BT ${gray} ${font} ${size} Tf 48 ${y} Td (${pdfEscape(line.text)}) Tj ET`;
}

export class DesignPdfExporter {
  export(
    markdown: string,
    configuration: DesignConfiguration,
    options: DesignPdfExportOptions = {},
  ): DesignPdfExport {
    const title = options.title?.trim() || 'Project Design';
    const author = options.author?.trim() || 'Hadamard user';
    const exportedAt = (options.exportedAt ?? new Date()).toISOString();
    const metadata = {
      title, author, documentId: configuration.documentId, template: configuration.template.id, exportedAt,
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    };
    const bodyLines = markdownLines(markdown);
    if (bodyLines[0]?.style === 'heading' && bodyLines[0].text === latinFallback(title)) {
      bodyLines.shift();
      if ((bodyLines[0] as PdfLine | undefined)?.style === 'blank') bodyLines.shift();
    }
    const lines: PdfLine[] = [
      ...wrapped(title, 60, 'title'),
      { text: `Document ID: ${configuration.documentId}`, style: 'meta' },
      { text: `Template: ${configuration.template.id} v${configuration.template.version}`, style: 'meta' },
      { text: `Exported: ${exportedAt}`, style: 'meta' },
      ...(options.sourceUrl ? wrapped(`Source: ${options.sourceUrl}`, 92, 'meta') : []),
      { text: '', style: 'blank' },
      ...bodyLines,
    ];
    const pages = paginate(lines);
    const pageObjectStart = 5;
    const contentObjectStart = pageObjectStart + pages.length;
    const infoObject = contentObjectStart + pages.length;
    const objects: string[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectStart + index} 0 R`).join(' ')}] /Count ${pages.length} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ];
    for (let index = 0; index < pages.length; index += 1) {
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`);
    }
    for (let index = 0; index < pages.length; index += 1) {
      let y = 790;
      const commands: string[] = [];
      for (const line of pages[index]!) {
        if (line.text) commands.push(lineCommand(line, y));
        y -= lineHeight(line.style);
      }
      commands.push(`BT 0.38 g /F1 9 Tf 48 28 Td (Page ${index + 1} of ${pages.length}) Tj ET`);
      objects.push(streamObject(commands.join('\n')));
    }
    const creationDate = exportedAt.replace(/[-:]/gu, '').replace('T', '').replace(/\.\d{3}Z$/u, 'Z');
    objects.push(`<< /Title (${pdfEscape(latinFallback(title))}) /Author (${pdfEscape(latinFallback(author))}) /Subject (${pdfEscape(`Hadamard Design ${configuration.documentId}`)}) /Keywords (${pdfEscape(configuration.template.id)}) /CreationDate (D:${creationDate}) >>`);
    if (objects.length !== infoObject) throw new Error('PDF object graph is inconsistent.');
    const bytes = buildPdf(objects);
    return { fileName: 'DESIGN.pdf', mediaType: 'application/pdf', bytes, checksum: sha256(bytes), metadata };
  }
}
