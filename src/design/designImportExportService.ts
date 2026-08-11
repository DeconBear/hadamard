import { createHash } from 'node:crypto';

import { DesignRenderService } from './designRenderService.js';

export type DesignImportKind = 'markdown' | 'hadamard-html' | 'reference-html' | 'reference-pdf';

export interface DesignImportPreview {
  kind: DesignImportKind;
  editable: boolean;
  markdown?: string;
  checksum: string;
  warnings: string[];
}
export interface DesignHtmlExport {
  mediaType: 'text/html';
  fileName: 'DESIGN.html';
  bytes: Buffer;
  checksum: string;
}

const EMBEDDED_PATTERN = /<script\s+type=["']application\/vnd\.hadamard\.design\+json["']\s*>([A-Za-z0-9_-]+)<\/script>/iu;

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Byte-oriented import/export boundary. It never evaluates imported HTML. */
export class DesignImportExportService {
  constructor(private readonly renderer = new DesignRenderService()) {}

  exportHtml(source: string): DesignHtmlExport {
    const rendered = this.renderer.render(source);
    const payload = Buffer.from(JSON.stringify({ version: 1, markdown: source, checksum: rendered.checksum }))
      .toString('base64url');
    const html = rendered.html.replace(
      '</body>',
      `<script type="application/vnd.hadamard.design+json">${payload}</script></body>`,
    );
    const bytes = Buffer.from(html, 'utf8');
    return { mediaType: 'text/html', fileName: 'DESIGN.html', bytes, checksum: checksum(bytes) };
  }

  preview(bytes: Buffer, fileName: string): DesignImportPreview {
    const digest = checksum(bytes);
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.md')) {
      return { kind: 'markdown', editable: true, markdown: bytes.toString('utf8'), checksum: digest, warnings: [] };
    }
    if (lowerName.endsWith('.pdf') || bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      return {
        kind: 'reference-pdf', editable: false, checksum: digest,
        warnings: ['PDF is imported as a read-only reference; use a Design package to continue editing.'],
      };
    }
    const raw = bytes.toString('utf8');
    const embedded = raw.match(EMBEDDED_PATTERN)?.[1];
    if (!embedded) {
      return {
        kind: 'reference-html', editable: false, checksum: digest,
        warnings: ['Third-party HTML is treated as an untrusted read-only reference.'],
      };
    }
    try {
      const data = JSON.parse(Buffer.from(embedded, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (data.version !== 1 || typeof data.markdown !== 'string' || typeof data.checksum !== 'string') {
        throw new Error('invalid embedded Design payload');
      }
      const markdownChecksum = createHash('sha256').update(data.markdown).digest('hex');
      if (markdownChecksum !== data.checksum) throw new Error('embedded Design checksum mismatch');
      return { kind: 'hadamard-html', editable: true, markdown: data.markdown, checksum: digest, warnings: [] };
    } catch (error) {
      return {
        kind: 'reference-html', editable: false, checksum: digest,
        warnings: [`Embedded Design data was rejected: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
}
