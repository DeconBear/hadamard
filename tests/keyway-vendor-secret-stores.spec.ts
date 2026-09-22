import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CompositeSecretStore,
  decodeMasterKey,
  EncryptedFileSecretStore,
  EnvironmentSecretStore,
  SecretStoreDecryptionError,
} from '../src/keyway/vendor/node/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function encryptedStore(key = randomBytes(32)): { store: EncryptedFileSecretStore; filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'keyway-secrets-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'secrets.json');
  return { store: new EncryptedFileSecretStore({ filePath, masterKey: key }), filePath };
}

describe('EncryptedFileSecretStore', () => {
  it('round-trips secrets without writing plaintext', async () => {
    const { store, filePath } = encryptedStore();
    await store.put('secret:ark-primary', 'credential-canary-value');
    expect(await store.resolve('secret:ark-primary')).toBe('credential-canary-value');
    expect(await store.has('secret:ark-primary')).toBe(true);
    expect(readFileSync(filePath, 'utf8')).not.toContain('credential-canary-value');
    await store.remove('secret:ark-primary');
    expect(await store.resolve('secret:ark-primary')).toBeUndefined();
  });

  it('fails closed when the master key changes', async () => {
    const key = randomBytes(32);
    const { store, filePath } = encryptedStore(key);
    await store.put('secret:ark-primary', 'credential-canary-value');
    const wrong = new EncryptedFileSecretStore({ filePath, masterKey: randomBytes(32) });
    await expect(wrong.resolve('secret:ark-primary')).rejects.toBeInstanceOf(SecretStoreDecryptionError);
  });

  it('serializes concurrent writes', async () => {
    const { store } = encryptedStore();
    await Promise.all([
      store.put('secret:first', 'first-value'),
      store.put('secret:second', 'second-value'),
    ]);
    expect(await store.resolve('secret:first')).toBe('first-value');
    expect(await store.resolve('secret:second')).toBe('second-value');
  });

  it.skipIf(process.platform === 'win32')('tightens POSIX directory and file permissions', async () => {
    const { store, filePath } = encryptedStore();
    chmodSync(path.dirname(filePath), 0o755);
    await store.put('secret:private', 'private-value');
    expect(statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe('environment and composite stores', () => {
  it('resolves env refs without copying them into managed storage', async () => {
    const environment = new EnvironmentSecretStore({ ARK_TEST_KEY: 'from-environment' });
    expect(await environment.resolve('env:ARK_TEST_KEY')).toBe('from-environment');
    await expect(environment.put('env:ARK_TEST_KEY', 'new-value')).rejects.toThrow(/read-only/u);
  });

  it('routes env and managed refs to separate stores', async () => {
    const { store } = encryptedStore();
    const composite = new CompositeSecretStore(
      store,
      new EnvironmentSecretStore({ ARK_TEST_KEY: 'from-environment' }),
    );
    await composite.put('secret:managed', 'managed-value');
    expect(await composite.resolve('secret:managed')).toBe('managed-value');
    expect(await composite.resolve('env:ARK_TEST_KEY')).toBe('from-environment');
  });

  it('decodes both base64 and hex master keys', () => {
    const key = randomBytes(32);
    expect(Buffer.from(decodeMasterKey(key.toString('base64')))).toEqual(key);
    expect(Buffer.from(decodeMasterKey(key.toString('hex')))).toEqual(key);
  });
});
