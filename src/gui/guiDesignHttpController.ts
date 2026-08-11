import { DesignDocumentService, type DesignMigrationAction } from '../design/index.js';
import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiDesignHttpControllerOptions {
  createService(): DesignDocumentService;
}

function isMigrationAction(value: unknown): value is DesignMigrationAction {
  return value === 'migrate-legacy' || value === 'keep-design'
    || value === 'replace-with-legacy' || value === 'merge-history';
}

function errorStatus(error: unknown): number {
  return error instanceof SyntaxError ? 400 : 409;
}

export function registerGuiDesignHttpController(
  router: GuiHttpRouter,
  options: GuiDesignHttpControllerOptions,
): void {
  router.route('GET', '/api/design', async (_req, res) => {
    const service = options.createService();
    json(res, 200, { ...(await service.read()), templates: service.templates.list() });
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

  router.route('POST', '/api/design/render', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.content !== 'string') return json(res, 400, { error: 'content must be a string' });
      json(res, 200, options.createService().render(body.content));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/migrate', async (req, res) => {
    try {
      const body = await readJson(req);
      if (!isMigrationAction(body.action)) return json(res, 400, { error: 'Invalid migration action' });
      json(res, 200, { ok: true, document: await options.createService().migrate(body.action) });
    } catch (error) {
      json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/export/html', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.content !== 'string') return json(res, 400, { error: 'content must be a string' });
      const exported = options.createService().transfers.exportHtml(body.content);
      json(res, 200, {
        fileName: exported.fileName,
        mediaType: exported.mediaType,
        checksum: exported.checksum,
        contentBase64: exported.bytes.toString('base64'),
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.route('POST', '/api/design/import/preview', async (req, res) => {
    try {
      const body = await readJson(req);
      if (typeof body.contentBase64 !== 'string' || typeof body.fileName !== 'string') {
        return json(res, 400, { error: 'fileName and contentBase64 are required' });
      }
      const bytes = Buffer.from(body.contentBase64, 'base64');
      if (bytes.length > 10 * 1024 * 1024) return json(res, 413, { error: 'Design import exceeds 10 MiB' });
      json(res, 200, options.createService().transfers.preview(bytes, body.fileName));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // One-release read compatibility. New writes must use the revision-aware Design endpoint.
  router.route('GET', '/api/project-doc', async (_req, res) => {
    const document = await options.createService().read();
    json(res, 200, { content: document.content, path: document.designPath, deprecated: true });
  });
}
