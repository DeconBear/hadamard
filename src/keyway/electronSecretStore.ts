import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface KeywaySecretStorePort {
  put(secretRef: string, value: string): Promise<void>;
  resolve(secretRef: string): Promise<string | undefined>;
  has(secretRef: string): Promise<boolean>;
  remove(secretRef: string): Promise<void>;
}

export interface ElectronSafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface ElectronSecretDocument {
  readonly version: 1;
  readonly entries: Record<string, string>;
}

export interface ElectronSecretStoreOptions {
  readonly filePath: string;
  readonly safeStorage: ElectronSafeStoragePort;
}

/**
 * A renderer-free Keyway SecretStore adapter backed by Electron safeStorage.
 * The file contains only safeStorage ciphertext; the renderer receives refs.
 */
export class ElectronSecretStore implements KeywaySecretStorePort {
  private readonly filePath: string;
  private readonly safeStorage: ElectronSafeStoragePort;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ElectronSecretStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.safeStorage = options.safeStorage;
  }

  async put(secretRef: string, value: string): Promise<void> {
    assertSecretRef(secretRef);
    if (!value) throw new TypeError('Secret value must not be empty.');
    this.assertEncryptionAvailable();
    await this.withWrite(async () => {
      const document = await this.load();
      document.entries[secretRef] = this.safeStorage.encryptString(value).toString('base64');
      await this.save(document);
    });
  }

  async resolve(secretRef: string): Promise<string | undefined> {
    assertSecretRef(secretRef);
    const encoded = (await this.load()).entries[secretRef];
    if (!encoded) return undefined;
    this.assertEncryptionAvailable();
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (cause) {
      throw new ElectronSecretStoreError(
        `Secret "${secretRef}" could not be decrypted by Electron safeStorage.`,
        { cause },
      );
    }
  }

  async has(secretRef: string): Promise<boolean> {
    assertSecretRef(secretRef);
    return (await this.load()).entries[secretRef] !== undefined;
  }

  async remove(secretRef: string): Promise<void> {
    assertSecretRef(secretRef);
    await this.withWrite(async () => {
      const document = await this.load();
      if (!(secretRef in document.entries)) return;
      delete document.entries[secretRef];
      await this.save(document);
    });
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new ElectronSecretStoreError('Electron safeStorage encryption is unavailable.');
    }
  }

  private async withWrite(operation: () => Promise<void>): Promise<void> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  private async load(): Promise<ElectronSecretDocument> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} };
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<ElectronSecretDocument>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new ElectronSecretStoreError('Unsupported Electron secret document.');
    }
    return { version: 1, entries: { ...parsed.entries } };
  }

  private async save(document: ElectronSecretDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export class ElectronSecretStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ElectronSecretStoreError';
  }
}

function assertSecretRef(secretRef: string): void {
  if (!/^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(secretRef)) {
    throw new TypeError('Managed secret reference must use the secret:<id> form.');
  }
}
