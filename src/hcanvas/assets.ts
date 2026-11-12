import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export interface HcAsset {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  file: string;
}

export interface HcAssetView extends HcAsset {
  url: string;
}

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export class HcAssetService {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly tokenPath: string;
  private assetToken = '';
  private assets: HcAsset[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.root = path.join(workspace, 'assets');
    this.indexPath = path.join(this.root, 'index.json');
    this.tokenPath = path.join(this.root, '.token');
  }

  get urlToken(): string { return this.assetToken; }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try { this.assetToken = (await readFile(this.tokenPath, 'utf8')).trim(); } catch { this.assetToken = ''; }
    if (!this.assetToken) {
      this.assetToken = randomBytes(18).toString('hex');
      await writeFile(this.tokenPath, this.assetToken, 'utf8');
    }
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as { assets?: HcAsset[] };
      this.assets = Array.isArray(parsed.assets) ? parsed.assets.filter(asset => asset && typeof asset.id === 'string') : [];
    } catch { this.assets = []; }
    const existing = await readdir(this.root).catch(() => []);
    const files = new Set(existing);
    this.assets = this.assets.filter(asset => files.has(asset.file));
  }

  list(): HcAsset[] {
    return this.assets.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async save(input: { name: string; mime?: string; data: Buffer }): Promise<HcAsset> {
    if (!Buffer.isBuffer(input.data) || !input.data.length) throw new Error('Asset is empty');
    if (input.data.length > MAX_ASSET_BYTES) throw new Error('Asset is too large (max 32 MB)');
    const base = path.basename(input.name || 'asset').replace(SAFE_NAME, '-').replace(/^-+|-+$/g, '') || 'asset';
    const ext = path.extname(base).toLowerCase();
    const mime = input.mime || MIME_BY_EXT[ext] || 'application/octet-stream';
    const id = 'asset_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const file = id + (ext || '.bin');
    await writeFile(path.join(this.root, file), input.data);
    const asset: HcAsset = { id, name: base, mime, size: input.data.length, createdAt: new Date().toISOString(), file };
    this.assets.push(asset);
    await this.persist();
    return asset;
  }

  async duplicate(id: string): Promise<HcAsset> {
    const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new Error('Asset not found');
    const data = await readFile(path.join(this.root, asset.file));
    return this.save({ name: 'Copy of ' + asset.name, mime: asset.mime, data });
  }

  async remove(id: string): Promise<void> {
    const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new Error('Asset not found');
    this.assets = this.assets.filter(item => item.id !== id);
    await rm(path.join(this.root, asset.file), { force: true });
    await this.persist();
  }

  async serve(id: string): Promise<{ stream: ReturnType<typeof createReadStream>; type: string; size: number }> {
    const asset = this.assets.find(item => item.id === id);
    if (!asset) throw new Error('Asset not found');
    const file = path.join(this.root, asset.file);
    const info = await stat(file);
    return { stream: createReadStream(file), type: asset.mime, size: info.size };
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => writeFile(this.indexPath, JSON.stringify({ assets: this.assets }, null, 2), 'utf8'));
    return this.writeQueue;
  }
}
