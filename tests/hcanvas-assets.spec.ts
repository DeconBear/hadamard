import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HcAssetService } from '../src/hcanvas/assets.js';

const temps: string[] = [];
async function tempDir(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-assets-')); temps.push(dir); return dir; }
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('HcAssetService', () => {
  it('stores, lists, serves and removes workspace assets', async () => {
    const workspace = await tempDir();
    const service = new HcAssetService(workspace);
    await service.init();
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const asset = await service.save({ name: 'logo.png', mime: 'image/png', data: png });
    expect(asset.mime).toBe('image/png');
    expect(service.list().map(item => item.id)).toContain(asset.id);
    const served = await service.serve(asset.id);
    expect(served.type).toBe('image/png');
    await service.remove(asset.id);
    expect(service.list()).toHaveLength(0);
  });

  it('persists the index across service instances', async () => {
    const workspace = await tempDir();
    const first = new HcAssetService(workspace);
    await first.init();
    const asset = await first.save({ name: 'doc.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4') });
    const second = new HcAssetService(workspace);
    await second.init();
    expect(second.list()[0]?.id).toBe(asset.id);
  });
});
