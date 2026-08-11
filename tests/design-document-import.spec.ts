import { describe, expect, it } from 'vitest';

import { DesignImportExportService } from '../src/design/designImportExportService.js';
import { DesignRenderService } from '../src/design/designRenderService.js';

describe('safe Design rendering and import', () => {
  it('escapes raw HTML and never emits executable or remote content', () => {
    const result = new DesignRenderService().render(
      '# Safe\n\n<script>alert(1)</script>\n\n<img src="https://evil.test/x" onerror="alert(2)">',
    );
    expect(result.bodyHtml).toContain('&lt;script&gt;');
    expect(result.bodyHtml).toContain('&lt;img');
    expect(result.html).not.toMatch(/<script|<iframe|src="https?:/iu);
    expect(result.html).not.toMatch(/<[^>]+\sonerror=/iu);
  });

  it('round-trips a Hadamard HTML export through a non-executing payload', () => {
    const transfers = new DesignImportExportService();
    const source = '# Architecture\n\nHigh cohesion.';
    const exported = transfers.exportHtml(source);
    const preview = transfers.preview(exported.bytes, exported.fileName);
    expect(preview.kind).toBe('hadamard-html');
    expect(preview.editable).toBe(true);
    expect(preview.markdown).toBe(source);
  });

  it('rejects tampered payloads and treats arbitrary HTML/PDF as references', () => {
    const transfers = new DesignImportExportService();
    const exported = transfers.exportHtml('# Original');
    const tampered = Buffer.from(exported.bytes.toString('utf8').replace('# Original', '# Changed'));
    // Visible HTML changes do not alter the embedded source; it remains the only recoverable content.
    expect(transfers.preview(tampered, 'tampered.html').markdown).toBe('# Original');

    const arbitrary = transfers.preview(Buffer.from('<script>steal()</script>'), 'attack.html');
    expect(arbitrary).toMatchObject({ kind: 'reference-html', editable: false });
    const pdf = transfers.preview(Buffer.from('%PDF-1.7 malicious'), 'attack.pdf');
    expect(pdf).toMatchObject({ kind: 'reference-pdf', editable: false });
  });
});
