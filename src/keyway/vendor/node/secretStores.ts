import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SecretStore } from '../core/index.js';

interface EncryptedEntry {
  readonly algorithm: 'aes-256-gcm';
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface EncryptedSecretDocument {
  readonly version: 1;
  readonly entries: Record<string, EncryptedEntry>;
}

export class SecretStoreDecryptionError extends Error {
  constructor(secretRef: string, options?: ErrorOptions) {
    super(`Secret "${secretRef}" could not be decrypted.`, options);
    this.name = 'SecretStoreDecryptionError';
  }
}

export class EnvironmentSecretStore implements SecretStore {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly prefix = 'env:',
  ) {}

  async put(secretRef: string, _value: string): Promise<void> {
    throw new TypeError(`Environment secret "${secretRef}" is read-only.`);
  }

  async resolve(secretRef: string): Promise<string | undefined> {
    const name = this.variableName(secretRef);
    const value = this.environment[name]?.trim();
    return value || undefined;
  }

  async has(secretRef: string): Promise<boolean> {
    return (await this.resolve(secretRef)) !== undefined;
  }

  async remove(secretRef: string): Promise<void> {
    throw new TypeError(`Environment secret "${secretRef}" is read-only.`);
  }

  private variableName(secretRef: string): string {
    if (!secretRef.startsWith(this.prefix)) {
      throw new TypeError(`Environment secret reference must start with "${this.prefix}".`);
    }
    const name = secretRef.slice(this.prefix.length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new TypeError(`Invalid environment variable name in secret reference "${secretRef}".`);
    }
    return name;
  }
}

export interface EncryptedFileSecretStoreOptions {
  readonly filePath: string;
  readonly masterKey: Uint8Array;
}

export class EncryptedFileSecretStore implements SecretStore {
  private readonly filePath: string;
  private readonly masterKey: Buffer;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: EncryptedFileSecretStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.masterKey = Buffer.from(options.masterKey);
    if (this.masterKey.byteLength !== 32) {
      throw new RangeError('AES-256-GCM masterKey must contain exactly 32 bytes.');
    }
  }

  async put(secretRef: string, value: string): Promise<void> {
    assertManagedSecretRef(secretRef);
    if (!value) throw new TypeError('Secret value must not be empty.');
    await this.withWrite(async () => {
      const document = await this.load();
      document.entries[secretRef] = encrypt(value, this.masterKey);
      await this.save(document);
    });
  }

  async resolve(secretRef: string): Promise<string | undefined> {
    assertManagedSecretRef(secretRef);
    const entry = (await this.load()).entries[secretRef];
    if (!entry) return undefined;
    try {
      return decrypt(entry, this.masterKey);
    } catch (cause) {
      throw new SecretStoreDecryptionError(secretRef, { cause });
    }
  }

  async has(secretRef: string): Promise<boolean> {
    assertManagedSecretRef(secretRef);
    return (await this.load()).entries[secretRef] !== undefined;
  }

  async remove(secretRef: string): Promise<void> {
    assertManagedSecretRef(secretRef);
    await this.withWrite(async () => {
      const document = await this.load();
      if (!(secretRef in document.entries)) return;
      delete document.entries[secretRef];
      await this.save(document);
    });
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

  private async load(): Promise<EncryptedSecretDocument> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} };
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<EncryptedSecretDocument>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new TypeError('Unsupported encrypted secret document.');
    }
    return { version: 1, entries: { ...parsed.entries } };
  }

  private async save(document: EncryptedSecretDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
  }
}

export class CompositeSecretStore implements SecretStore {
  constructor(
    private readonly managed: SecretStore,
    private readonly environment = new EnvironmentSecretStore(),
  ) {}

  put(secretRef: string, value: string): Promise<void> {
    return this.storeFor(secretRef).put(secretRef, value);
  }

  resolve(secretRef: string): Promise<string | undefined> {
    return this.storeFor(secretRef).resolve(secretRef);
  }

  has(secretRef: string): Promise<boolean> {
    return this.storeFor(secretRef).has(secretRef);
  }

  remove(secretRef: string): Promise<void> {
    return this.storeFor(secretRef).remove(secretRef);
  }

  private storeFor(secretRef: string): SecretStore {
    return secretRef.startsWith('env:') ? this.environment : this.managed;
  }
}

export function decodeMasterKey(value: string): Uint8Array {
  const normalized = value.trim();
  const bytes = /^[a-f0-9]{64}$/iu.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');
  if (bytes.byteLength !== 32) {
    throw new RangeError('Master key must decode to exactly 32 bytes (hex or base64).');
  }
  return bytes;
}

function assertManagedSecretRef(secretRef: string): void {
  if (!/^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(secretRef)) {
    throw new TypeError('Managed secret reference must use the secret:<id> form.');
  }
}

function encrypt(value: string, key: Buffer): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  if (entry.algorithm !== 'aes-256-gcm') throw new TypeError('Unsupported secret encryption algorithm.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
