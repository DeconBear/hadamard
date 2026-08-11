import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createDefaultDesignTemplateRegistry,
  createDesignConfiguration,
  decodeZip,
  DesignImportExportService,
  DesignPackageService,
  DesignRenderService,
  encodeZip,
  resolveDesignTheme,
  validateDesignThemeTokens,
} from '../src/design/index.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function replaceAscii(bytes: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const result = Buffer.from(bytes);
  let offset = 0;
  while ((offset = result.indexOf(from, offset, 'utf8')) >= 0) {
    result.write(to, offset, 'utf8');
    offset += to.length;
  }
  return result;
}

describe('Design templates and declarative themes', () => {
  it('ships the eight domain templates with stable unique section ids', () => {
    const templates = createDefaultDesignTemplateRegistry().list();
    expect(templates.map(template => template.id)).toEqual([
      'ai4s.experiment', 'electronics.circuit', 'math.modeling', 'ml.training',
      'software.backend', 'software.frontend', 'software.general', 'software.systems',
    ]);
    for (const template of templates) {
      expect(new Set(template.sections.map(section => section.id)).size).toBe(template.sections.length);
      expect(template.sections.some(section => section.id === 'goal')).toBe(true);
    }
  });

  it('clamps theme tokens and rejects CSS and active logo payloads', () => {
    const base = resolveDesignTheme('clean-light').tokens;
    const safe = validateDesignThemeTokens({
      accentColor: 'red; background:url(https://evil.test)',
      fontFamily: 'serif;}body{display:none',
      pageWidth: 99_999,
      logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=',
    }, base);
    expect(safe.accentColor).toBe(base.accentColor);
    expect(safe.fontFamily).toBe(base.fontFamily);
    expect(safe.pageWidth).toBe(1440);
    expect(safe.logoDataUrl).toBeUndefined();
  });

  it('renders stable section ids in configured order and omits hidden sections', () => {
    const markdown = '<!-- hadamard-section:goal -->\n## Goal\n\nFirst.\n\n'
      + '<!-- hadamard-section:scope -->\n## Scope\n\nSecond.\n\n'
      + '<!-- hadamard-section:risks -->\n## Risks\n\nThird.\n';
    const rendered = new DesignRenderService().render(markdown, {}, {
      order: ['scope', 'goal', 'risks'], hidden: ['risks'],
    });
    expect(rendered.bodyHtml.indexOf('Scope')).toBeLessThan(rendered.bodyHtml.indexOf('Goal'));
    expect(rendered.bodyHtml).not.toContain('Risks');
    expect(rendered.bodyHtml).not.toContain('hadamard-section');
  });
});

describe('Hadamard Design package', () => {
  it('round-trips Markdown, config, provenance, and validated assets', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const configuration = createDesignConfiguration('electronics.circuit');
    configuration.assets = [{ path: 'assets/board.png', mediaType: 'image/png', sha256: sha256(png), size: png.length }];
    const service = new DesignPackageService('test-version');
    const exported = service.export('# Circuit\n\nValidated.', configuration, [
      { path: 'assets/board.png', mediaType: 'image/png', bytes: png },
    ], new Date('2026-08-11T00:00:00.000Z'));
    expect(exported.bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    const preview = service.preview(exported.bytes);
    expect(preview.markdown).toContain('# Circuit');
    expect(preview.configuration.documentId).not.toBe(configuration.documentId);
    expect(preview.configuration.originDocumentId).toBe(configuration.documentId);
    expect(preview.manifest.generator.version).toBe('test-version');
    expect(preview.assets).toHaveLength(1);
    expect(preview.assets[0]?.bytes).toEqual(png);
  });

  it('rejects checksum tampering, zip-slip, bombs, SVG, and incomplete asset coverage', () => {
    const service = new DesignPackageService('test');
    const exported = service.export('# Safe', createDesignConfiguration());
    const tampered = Buffer.from(exported.bytes);
    const firstDataOffset = 30 + tampered.readUInt16LE(26) + tampered.readUInt16LE(28);
    tampered[firstDataOffset + 1] = tampered[firstDataOffset + 1]! ^ 1;
    expect(() => service.preview(tampered)).toThrow();

    const safeZip = encodeZip([{ name: 'safe/evil.txt', data: Buffer.from('x') }]);
    expect(() => decodeZip(replaceAscii(safeZip, 'safe/evil.txt', '../x/evil.txt'))).toThrow(/Unsafe ZIP entry/u);
    const bomb = encodeZip([{ name: 'assets/repeat.bin', data: Buffer.alloc(200_000, 65) }]);
    expect(() => decodeZip(bomb)).toThrow(/compression ratio/u);

    const svg = Buffer.from('<svg><script>alert(1)</script></svg>');
    const svgConfig = createDesignConfiguration();
    svgConfig.assets = [{ path: 'assets/logo.svg', mediaType: 'image/svg+xml', sha256: sha256(svg), size: svg.length }];
    expect(() => service.export('# Unsafe', svgConfig, [
      { path: 'assets/logo.svg', mediaType: 'image/svg+xml', bytes: svg },
    ])).toThrow(/media type/u);

    const missing = createDesignConfiguration();
    missing.assets = [{ path: 'assets/missing.png', mediaType: 'image/png', sha256: '0'.repeat(64), size: 1 }];
    expect(() => service.export('# Missing', missing)).toThrow(/asset list/u);
  });
});

describe('Design HTML and PDF exports', () => {
  it('recovers validated editable data from HTML and emits a metadata-bearing PDF', () => {
    const transfers = new DesignImportExportService(undefined, 'test-version');
    const configuration = createDesignConfiguration('math.modeling');
    const document = { markdown: '# Model\n\nEquation validation.', configuration };
    const html = transfers.exportHtml(document, new Date('2026-08-11T00:00:00.000Z'));
    expect(html.bytes.toString('utf8')).not.toMatch(/<script(?! type="application\/vnd\.hadamard\.design\+json")/iu);
    expect(html.bytes.toString('utf8')).not.toMatch(/https?:\/\//iu);
    const restored = transfers.preview(html.bytes, html.fileName);
    expect(restored).toMatchObject({ kind: 'hadamard-html', editable: true, markdown: document.markdown });
    expect(restored.configuration?.documentId).toBe(configuration.documentId);

    const pdf = transfers.exportPdf(document, {
      title: 'Model Design', author: 'Ada', sourceUrl: 'hadamard://design/model',
      exportedAt: new Date('2026-08-11T00:00:00.000Z'),
    });
    const raw = pdf.bytes.toString('latin1');
    expect(raw.startsWith('%PDF-1.7')).toBe(true);
    expect(raw).toContain('/Title (Model Design)');
    expect(raw).toContain(configuration.documentId);
    expect(raw).toContain('Page 1 of');
    expect(transfers.preview(pdf.bytes, pdf.fileName)).toMatchObject({ kind: 'reference-pdf', editable: false });
  });
});
