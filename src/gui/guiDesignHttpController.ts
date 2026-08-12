import {
  DesignDocumentService,
  type DesignImportAction,
  type DesignShareFormat,
  type EngineeringProfileTarget,
} from '../design/index.js';
import { escapeHtml } from '../ui/safeMarkdown.js';
import { json, readJson, text, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiDesignHttpControllerOptions {
  createService(): DesignDocumentService;
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function isImportAction(value: unknown): value is DesignImportAction {
  return value === 'new-copy' || value === 'replace-current' || value === 'merge-sections';
}

function isEngineeringTarget(value: unknown): value is EngineeringProfileTarget {
  return value === 'design' || value === 'agents' || value === 'policy' || value === 'validators';
}

function errorStatus(error: unknown): number {
  return error instanceof SyntaxError ? 400 : 409;
}

function decodeImport(body: Record<string, unknown>): { fileName: string; bytes: Buffer } {
  if (typeof body.contentBase64 !== 'string' || typeof body.fileName !== 'string') {
    throw new SyntaxError('fileName and contentBase64 are required');
  }
  if (body.contentBase64.length > Math.ceil(MAX_IMPORT_BYTES / 3) * 4 + 8
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.contentBase64)) {
    throw new SyntaxError('Design import has invalid or oversized base64 content');
  }
  const imported = Buffer.from(body.contentBase64, 'base64');
  if (imported.length > MAX_IMPORT_BYTES) throw new SyntaxError('Design import exceeds 20 MiB');
  return { fileName: body.fileName, bytes: imported };
}

function encodedExport(exported: { fileName: string; mediaType: string; checksum: string; bytes: Buffer }) {
  return {
    fileName: exported.fileName, mediaType: exported.mediaType, checksum: exported.checksum,
    contentBase64: exported.bytes.toString('base64'),
  };
}

function sharePage(token: string, snapshot: Awaited<ReturnType<DesignDocumentService['shares']['resolve']>>): string {
  const root = `/design-share/${encodeURIComponent(token)}`;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Hadamard Design snapshot</title><style>body{margin:0;background:#f4f7fb;color:#172033;font:16px/1.55 system-ui,sans-serif}'
    + 'main{max-width:760px;margin:8vh auto;padding:40px;background:#fff;border:1px solid #dbe4f0;border-radius:18px;box-shadow:0 20px 60px #1e3a5f18}'
    + 'h1{margin-top:0}code{font-family:ui-monospace,monospace;font-size:13px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}'
    + 'a{padding:10px 14px;border-radius:9px;background:#2563eb;color:#fff;text-decoration:none}a.secondary{background:#e7eef8;color:#172033}</style></head><body><main>'
    + '<p>Hadamard Design · immutable snapshot</p><h1>Project Design snapshot</h1>'
    + `<p>Document <code>${escapeHtml(snapshot.documentId)}</code></p>`
    + `<p>Snapshot checksum <code>${escapeHtml(snapshot.snapshotId)}</code></p>`
    + `<p>Exported ${escapeHtml(snapshot.exportedAt)} · expires ${escapeHtml(snapshot.expiresAt)}</p>`
    + '<div class="actions">'
    + `<a href="${root}/html">Read HTML</a><a class="secondary" href="${root}/pdf">Download PDF</a>`
    + `<a class="secondary" href="${root}/package">Download Design package</a>`
    + `<a class="secondary" href="${root}/package?import=1">Import to Hadamard</a>`
    + '</div></main></body></html>';
}

export function registerGuiDesignHttpController(
  router: GuiHttpRouter,
  options: GuiDesignHttpControllerOptions,
): void {
  router.route('GET', '/api/design', async (_req, res) => {
    const service = options.createService();
    json(res, 200, {
      ...(await service.read()), templates: service.templates.list(), themes: service.themes, profiles: service.profiles,
    });
  });

  router.route('POST', '/api/design/patch', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.content !== 'string') return json(res, 400, { error: 'content must be a string' });
      const service = options.createService();
      const savedPath = await service.patch(
        body.content,
        typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined,
        body.mirror === true,
      );
      json(res, 200, { ok: true, path: savedPath, document: await service.read() });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/config', async (req, res) => {
    try {
      const body = await readJson(req);
      const service = options.createService();
      json(res, 200, {
        ok: true,
        configuration: await service.patchConfiguration({
          ...(typeof body.templateId === 'string' ? { templateId: body.templateId } : {}),
          ...(typeof body.themeId === 'string' ? { themeId: body.themeId } : {}),
          ...(body.themeTokens && typeof body.themeTokens === 'object' ? { themeTokens: body.themeTokens } : {}),
          ...(Array.isArray(body.sectionOrder) ? { sectionOrder: body.sectionOrder.filter(value => typeof value === 'string') } : {}),
          ...(Array.isArray(body.hiddenSections) ? { hiddenSections: body.hiddenSections.filter(value => typeof value === 'string') } : {}),
        }, typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined),
      });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/render', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.content !== 'string') return json(res, 400, { error: 'content must be a string' });
      json(res, 200, await options.createService().render(body.content));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  for (const format of ['html', 'pdf', 'package'] as const) {
    router.route('POST', `/api/design/export/${format}`, async (req, res) => {
      try {
        const body = await readJson(req);
        const service = options.createService();
        const document = await service.transferDocument(typeof body.content === 'string' ? body.content : undefined);
        const exported = format === 'html'
          ? service.transfers.exportHtml(document)
          : format === 'pdf'
            ? service.transfers.exportPdf(document, {
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.author === 'string' ? { author: body.author } : {}),
              ...(typeof body.sourceUrl === 'string' ? { sourceUrl: body.sourceUrl } : {}),
            })
            : service.transfers.exportPackage(document);
        json(res, 200, encodedExport(exported));
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  router.route('POST', '/api/design/import/preview', async (req, res) => {
    try {
      const imported = decodeImport(await readJson(req));
      const { assets: _assets, ...preview } = options.createService().previewImport(imported.bytes, imported.fileName);
      json(res, 200, preview);
    } catch (error) {
      json(res, error instanceof SyntaxError ? 413 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/import/commit', async (req, res) => {
    try {
      const body = await readJson(req);
      if (body.confirmed !== true || !isImportAction(body.action) || typeof body.expectedRevision !== 'string') {
        return json(res, 400, { error: 'confirmed, valid action, and expectedRevision are required' });
      }
      const imported = decodeImport(body);
      const service = options.createService();
      const result = await service.commitImport(imported.bytes, imported.fileName, body.action, body.expectedRevision);
      json(res, 200, { ok: true, result, document: await service.read() });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/import/reference', async (req, res) => {
    try {
      const body = await readJson(req);
      if (body.confirmed !== true) return json(res, 400, { error: 'Reference attachment requires confirmation' });
      const imported = decodeImport(body);
      const artifact = await options.createService().attachReference(imported.bytes, imported.fileName);
      json(res, 200, { ok: true, artifact: { id: artifact.id, checksum: artifact.checksum, mediaType: artifact.mediaType } });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/share', async (req, res) => {
    try {
      const body = await readJson(req);
      const service = options.createService();
      const document = await service.read();
      if (typeof body.expectedRevision === 'string' && body.expectedRevision !== document.revision) {
        throw new Error('DESIGN.md changed before the share snapshot was created.');
      }
      const created = await service.shares.create(
        await service.transferDocument(),
        document.revision,
        typeof body.expiresInHours === 'number' ? body.expiresInHours : 72,
        new Date(),
        req.headers.host ? `http://${req.headers.host}` : undefined,
      );
      json(res, 200, { ...created, url: `/design-share/${created.token}` });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/share/revoke', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.token !== 'string') return json(res, 400, { error: 'token is required' });
      await options.createService().shares.revoke(body.token);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 404, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/engineering-profile/preview', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.profileId !== 'string') return json(res, 400, { error: 'profileId is required' });
      json(res, 200, await options.createService().engineeringProfiles.propose(body.profileId));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/engineering-profile/audit', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.profileId !== 'string') return json(res, 400, { error: 'profileId is required' });
      json(res, 200, await options.createService().engineeringProfiles.audit(body.profileId));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/engineering-profile/apply', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.profileId !== 'string' || typeof body.proposalId !== 'string' || !Array.isArray(body.targets)) {
        return json(res, 400, { error: 'profileId, proposalId, and targets are required' });
      }
      const service = options.createService();
      const proposal = await service.engineeringProfiles.propose(body.profileId);
      if (proposal.proposalId !== body.proposalId) throw new Error('Engineering Profile proposal is stale.');
      const targets = body.targets.filter(isEngineeringTarget);
      const applied = await service.engineeringProfiles.apply(proposal, targets, body.confirmed === true);
      json(res, 200, { ok: true, applied });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('GET', /^\/design-share\/[A-Za-z0-9_-]+$/u, async (_req, res, url) => {
    const tokenValue = url.pathname.split('/').at(-1) ?? '';
    try {
      const snapshot = await options.createService().shares.resolve(tokenValue);
      text(res, 200, sharePage(tokenValue, snapshot), 'text/html');
    } catch (error) {
      text(res, 404, error instanceof Error ? error.message : String(error));
    }
  });

  router.route('GET', /^\/design-share\/[A-Za-z0-9_-]+\/(?:html|pdf|package)$/u, async (_req, res, url) => {
    const [, , tokenValue = '', formatValue = ''] = url.pathname.split('/');
    try {
      const format = formatValue as DesignShareFormat;
      const download = await options.createService().shares.download(tokenValue, format);
      res.writeHead(200, {
        'content-type': download.reference.mediaType,
        'content-length': download.bytes.length,
        'content-disposition': `${format === 'html' ? 'inline' : 'attachment'}; filename="${download.reference.fileName}"`,
        'cache-control': 'private, no-store',
      });
      res.end(download.bytes);
    } catch (error) {
      text(res, 404, error instanceof Error ? error.message : String(error));
    }
  });

}
