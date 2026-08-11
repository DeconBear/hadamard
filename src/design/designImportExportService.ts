import { createHash } from 'node:crypto';

import {
  createDesignConfiguration,
  normalizeDesignConfiguration,
  type DesignConfiguration,
} from './designConfiguration.js';
import {
  DesignPackageService,
  type DesignPackageExport,
  type DesignPackageManifest,
  type DesignPackagePreview,
  type DesignPackageAsset,
} from './designPackage.js';
import { DesignPdfExporter, type DesignPdfExport, type DesignPdfExportOptions } from './designPdfExporter.js';
import { DesignRenderService } from './designRenderService.js';

export type DesignImportKind =
  | 'markdown'
  | 'hadamard-package'
  | 'hadamard-html'
  | 'reference-html'
  | 'reference-pdf';

export interface DesignImportPreview {
  kind: DesignImportKind;
  editable: boolean;
  markdown?: string;
  configuration?: DesignConfiguration;
  manifest?: DesignPackageManifest;
  checksum: string;
  warnings: string[];
  /** Internal validated bytes; HTTP previews omit this field. */
  assets?: DesignPackageAsset[];
}

export interface DesignHtmlExport {
  mediaType: 'text/html';
  fileName: 'DESIGN.html';
  bytes: Buffer;
  checksum: string;
  manifest: DesignPackageManifest;
}

export interface DesignTransferDocument {
  markdown: string;
  configuration: DesignConfiguration;
  assets?: DesignPackageAsset[];
}

interface EmbeddedHtmlPayload {
  version: 1;
  manifest: DesignPackageManifest;
  markdown: string;
  configuration: DesignConfiguration;
  checksum: string;
}

const EMBEDDED_PATTERN = /<script\s+type=["']application\/vnd\.hadamard\.design\+json["']\s*>([A-Za-z0-9_-]+)<\/script>/iu;

function checksum(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function payloadChecksum(payload: Omit<EmbeddedHtmlPayload, 'checksum'>): string {
  return checksum(JSON.stringify(payload));
}

function defaultDocument(markdown: string): DesignTransferDocument {
  return { markdown, configuration: createDesignConfiguration() };
}

/** Byte-oriented import/export boundary. It never evaluates imported HTML. */
export class DesignImportExportService {
  readonly packages: DesignPackageService;
  readonly pdf: DesignPdfExporter;

  constructor(
    private readonly renderer = new DesignRenderService(),
    generatorVersion = '0.4.15',
    pdf = new DesignPdfExporter(),
  ) {
    this.packages = new DesignPackageService(generatorVersion);
    this.pdf = pdf;
  }

  exportPackage(document: DesignTransferDocument, now = new Date()): DesignPackageExport {
    return this.packages.export(document.markdown, document.configuration, document.assets ?? [], now);
  }

  exportHtml(source: string | DesignTransferDocument, now = new Date()): DesignHtmlExport {
    const document = typeof source === 'string' ? defaultDocument(source) : source;
    const packageExport = this.exportPackage(document, now);
    const rendered = this.renderer.render(
      document.markdown,
      document.configuration.theme.tokens,
      document.configuration.sections,
    );
    const unsigned = {
      version: 1 as const,
      manifest: packageExport.manifest,
      markdown: document.markdown,
      configuration: document.configuration,
    };
    const payload: EmbeddedHtmlPayload = { ...unsigned, checksum: payloadChecksum(unsigned) };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const html = rendered.html.replace(
      '</body>',
      `<script type="application/vnd.hadamard.design+json">${encoded}</script></body>`,
    );
    const bytes = Buffer.from(html, 'utf8');
    return {
      mediaType: 'text/html', fileName: 'DESIGN.html', bytes, checksum: checksum(bytes),
      manifest: packageExport.manifest,
    };
  }

  exportPdf(document: DesignTransferDocument, options: DesignPdfExportOptions = {}): DesignPdfExport {
    return this.pdf.export(document.markdown, document.configuration, options);
  }

  preview(bytes: Buffer, fileName: string): DesignImportPreview {
    const digest = checksum(bytes);
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.hadamard-design.zip') || lowerName.endsWith('.zip')) {
      const preview: DesignPackagePreview = this.packages.preview(bytes);
      return preview;
    }
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
      const data = JSON.parse(Buffer.from(embedded, 'base64url').toString('utf8')) as Partial<EmbeddedHtmlPayload>;
      if (data.version !== 1 || typeof data.markdown !== 'string' || typeof data.checksum !== 'string'
        || !data.configuration || !data.manifest) {
        throw new Error('invalid embedded Design payload');
      }
      const unsigned = {
        version: 1 as const,
        manifest: data.manifest,
        markdown: data.markdown,
        configuration: data.configuration,
      };
      if (payloadChecksum(unsigned) !== data.checksum) throw new Error('embedded Design checksum mismatch');
      const configuration = normalizeDesignConfiguration(data.configuration);
      if (configuration.documentId !== data.manifest.documentId) {
        throw new Error('embedded Design identity mismatch');
      }
      const designResource = data.manifest.resources.find(resource => resource.path === 'DESIGN.md');
      if (!designResource || designResource.sha256 !== checksum(data.markdown)) {
        throw new Error('embedded DESIGN.md resource mismatch');
      }
      return {
        kind: 'hadamard-html', editable: true, markdown: data.markdown, configuration,
        manifest: data.manifest, checksum: digest, warnings: [],
      };
    } catch (error) {
      return {
        kind: 'reference-html', editable: false, checksum: digest,
        warnings: [`Embedded Design data was rejected: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
}
