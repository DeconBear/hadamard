import {
  type DesignEntryMode,
  DesignDocumentService,
  type DesignImportAction,
  type EngineeringProfileTarget,
} from '../design/index.js';
import { bytes, json, readJson, text, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiDesignHttpControllerOptions {
  createService(): DesignDocumentService;
  openFolder?(folderPath: string): void;
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function isImportAction(value: unknown): value is DesignImportAction {
  return value === 'new-copy' || value === 'replace-current' || value === 'merge-sections';
}

function isEngineeringTarget(value: unknown): value is EngineeringProfileTarget {
  return value === 'design' || value === 'agents' || value === 'policy' || value === 'validators';
}

function isDesignEntryMode(value: unknown): value is DesignEntryMode {
  return value === 'html' || value === 'markdown';
}

function designAssetMediaType(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').at(-1) ?? '';
  return ({
    css: 'text/css', gif: 'image/gif', html: 'text/html', jpeg: 'image/jpeg', jpg: 'image/jpeg',
    js: 'text/javascript', json: 'application/json', md: 'text/markdown', png: 'image/png',
    svg: 'image/svg+xml', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
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


export function registerGuiDesignHttpController(
  router: GuiHttpRouter,
  options: GuiDesignHttpControllerOptions,
): void {
  router.route('GET', '/api/design', async (_req, res) => {
    const service = options.createService();
    json(res, 200, {
      ...(await service.read()), workspace: await service.store.workspace.inspect(),
      templates: service.templates.list(), themes: service.themes, profiles: service.profiles,
    });
  });

  router.route('GET', '/api/design/entry', async (_req, res, url) => {
    try {
      const mode = url.searchParams.get('mode');
      if (!isDesignEntryMode(mode)) return json(res, 400, { error: 'mode must be html or markdown' });
      json(res, 200, await options.createService().store.workspace.readEntry(mode));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/open-folder', async (_req, res) => {
    try {
      const workspace = options.createService().store.workspace;
      const folderPath = await workspace.ensureRoot();
      options.openFolder?.(folderPath);
      json(res, 200, { ok: true, path: folderPath });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/refresh', async (req, res) => {
    try {
      const body = await readJson(req);
      if (!isDesignEntryMode(body.mode)) return json(res, 400, { error: 'mode must be html or markdown' });
      json(res, 200, await options.createService().store.workspace.refreshEntry(body.mode));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/entry', async (req, res) => {
    try {
      const body = await readJson(req);
      if (!isDesignEntryMode(body.mode) || typeof body.content !== 'string') {
        return json(res, 400, { error: 'mode and content are required' });
      }
      const workspace = options.createService().store.workspace;
      const saved = body.mode === 'html'
        ? await workspace.writeHtml(body.content, typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined)
        : await workspace.writeMarkdown(body.content, typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined);
      json(res, 200, { ok: true, entry: saved });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('GET', '/api/design/asset', async (_req, res, url) => {
    try {
      const relativePath = url.searchParams.get('path');
      if (!relativePath) return json(res, 400, { error: 'path is required' });
      const workspace = options.createService().store.workspace;
      const body = await workspace.readAsset(relativePath);
      bytes(res, 200, body, designAssetMediaType(relativePath));
    } catch (error) {
      text(res, 404, error instanceof Error ? error.message : String(error));
    }
  });

  router.route('GET', '/api/design/preview', async (_req, res) => {
    try {
      const workspace = options.createService().store.workspace;
      const entry = await workspace.readEntry('html');
      if (!entry.exists) return text(res, 404, 'design.html does not exist');
      const source = entry.content
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(source);
    } catch (error) {
      text(res, 400, error instanceof Error ? error.message : String(error));
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

}
