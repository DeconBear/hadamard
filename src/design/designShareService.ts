import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import type { JsonObject } from '../storage-v2/types.js';
import type { DesignArtifactRepository } from './designArtifactRepository.js';
import type { DesignImportExportService, DesignTransferDocument } from './designImportExportService.js';

export type DesignShareFormat = 'html' | 'pdf' | 'package';

export interface DesignShareSnapshot {
  snapshotId: string;
  documentId: string;
  revision: string;
  exportedAt: string;
  expiresAt: string;
  revokedAt?: string;
  tokenHash: string;
  permission: 'design.snapshot.read';
  artifacts: Record<DesignShareFormat, { id: string; checksum: string; mediaType: string; fileName: string }>;
}

interface DesignShareLedger {
  version: 1;
  snapshots: DesignShareSnapshot[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenMatches(token: string, expectedHex: string): boolean {
  const actual = Buffer.from(hash(token), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DesignShareService {
  constructor(
    private readonly ledgerPath: string,
    private readonly artifacts: DesignArtifactRepository,
    private readonly transfers: DesignImportExportService,
  ) {}

  private async load(): Promise<DesignShareLedger> {
    try {
      const value = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as DesignShareLedger;
      return value.version === 1 && Array.isArray(value.snapshots) ? value : { version: 1, snapshots: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 1, snapshots: [] };
    }
  }

  private async save(ledger: DesignShareLedger): Promise<void> {
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await writeJsonAtomic(this.ledgerPath, ledger);
  }

  async create(
    document: DesignTransferDocument,
    revision: string,
    expiresInHours = 72,
    now = new Date(),
    sourceBaseUrl?: string,
  ): Promise<{ token: string; snapshot: Omit<DesignShareSnapshot, 'tokenHash'> }> {
    const boundedHours = Math.max(1, Math.min(24 * 30, Math.floor(expiresInHours)));
    const token = randomBytes(32).toString('base64url');
    const html = this.transfers.exportHtml(document, now);
    const pdf = this.transfers.exportPdf(document, {
      exportedAt: now,
      ...(sourceBaseUrl ? { sourceUrl: `${sourceBaseUrl.replace(/\/$/u, '')}/design-share/${token}` } : {}),
    });
    const designPackage = this.transfers.exportPackage(document, now);
    const common: JsonObject = {
      kind: 'design-share-snapshot', documentId: document.configuration.documentId,
      revision, exportedAt: now.toISOString(), immutable: true,
    };
    const [htmlArtifact, pdfArtifact, packageArtifact] = await Promise.all([
      this.artifacts.putImmutable(html.mediaType, html.bytes, { ...common, format: 'html' }),
      this.artifacts.putImmutable(pdf.mediaType, pdf.bytes, { ...common, format: 'pdf' }),
      this.artifacts.putImmutable(designPackage.mediaType, designPackage.bytes, { ...common, format: 'package' }),
    ]);
    const exportedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + boundedHours * 60 * 60 * 1000).toISOString();
    const artifactRefs: DesignShareSnapshot['artifacts'] = {
      html: { id: htmlArtifact.id, checksum: htmlArtifact.checksum, mediaType: html.mediaType, fileName: html.fileName },
      pdf: { id: pdfArtifact.id, checksum: pdfArtifact.checksum, mediaType: pdf.mediaType, fileName: pdf.fileName },
      package: {
        id: packageArtifact.id, checksum: packageArtifact.checksum,
        mediaType: designPackage.mediaType, fileName: designPackage.fileName,
      },
    };
    const snapshotId = hash(JSON.stringify({ documentId: document.configuration.documentId, revision, exportedAt, artifactRefs }));
    const snapshot: DesignShareSnapshot = {
      snapshotId, documentId: document.configuration.documentId, revision, exportedAt, expiresAt,
      tokenHash: hash(token), permission: 'design.snapshot.read', artifacts: artifactRefs,
    };
    const ledger = await this.load();
    ledger.snapshots.push(snapshot);
    await this.save(ledger);
    const { tokenHash: _tokenHash, ...publicSnapshot } = snapshot;
    return { token, snapshot: publicSnapshot };
  }

  async resolve(token: string, now = new Date()): Promise<Omit<DesignShareSnapshot, 'tokenHash'>> {
    const snapshot = (await this.load()).snapshots.find(candidate => tokenMatches(token, candidate.tokenHash));
    if (!snapshot || snapshot.revokedAt || Date.parse(snapshot.expiresAt) <= now.getTime()) {
      throw new Error('Design share token is invalid, expired, or revoked.');
    }
    const { tokenHash: _tokenHash, ...publicSnapshot } = snapshot;
    return publicSnapshot;
  }

  async download(token: string, format: DesignShareFormat, now = new Date()) {
    const snapshot = await this.resolve(token, now);
    const reference = snapshot.artifacts[format];
    const artifact = await this.artifacts.get(reference.id);
    if (!artifact || artifact.checksum !== reference.checksum) throw new Error('Design share artifact is unavailable or corrupted.');
    return { snapshot, reference, bytes: artifact.bytes };
  }

  async revoke(token: string, now = new Date()): Promise<void> {
    const ledger = await this.load();
    const snapshot = ledger.snapshots.find(candidate => tokenMatches(token, candidate.tokenHash));
    if (!snapshot) throw new Error('Design share token was not found.');
    snapshot.revokedAt = now.toISOString();
    await this.save(ledger);
  }
}
