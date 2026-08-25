import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ElectronSecretStore,
  ElectronSecretStoreError,
  type ElectronSafeStoragePort,
  type KeywaySecretStorePort,
} from '../src/keyway/electronSecretStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(
  safeStorage: ElectronSafeStoragePort = fakeSafeStorage(),
): { store: ElectronSecretStore; filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'hadamard-keyway-secrets-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'electron-secrets.json');
  return { store: new ElectronSecretStore({ filePath, safeStorage }), filePath };
}

describe('ElectronSecretStore', () => {
  it('structurally implements the Keyway SecretStore port', () => {
    const { store } = createStore();
    const port: KeywaySecretStorePort = store;
    expect(port).toBe(store);
  });

  it('persists only safeStorage ciphertext and round-trips values', async () => {
    const { store, filePath } = createStore();
    await store.put('secret:ark-primary', 'credential-canary-value');
    expect(await store.resolve('secret:ark-primary')).toBe('credential-canary-value');
    expect(await store.has('secret:ark-primary')).toBe(true);
    expect(readFileSync(filePath, 'utf8')).not.toContain('credential-canary-value');
    await store.remove('secret:ark-primary');
    expect(await store.resolve('secret:ark-primary')).toBeUndefined();
  });

  it('serializes concurrent mutations without losing entries', async () => {
    const { store } = createStore();
    await Promise.all([
      store.put('secret:first', 'first-value'),
      store.put('secret:second', 'second-value'),
    ]);
    expect(await store.resolve('secret:first')).toBe('first-value');
    expect(await store.resolve('secret:second')).toBe('second-value');
  });

  it('fails closed when Electron encryption is unavailable', async () => {
    const { store } = createStore(fakeSafeStorage(false));
    await expect(store.put('secret:ark-primary', 'credential-canary-value'))
      .rejects.toBeInstanceOf(ElectronSecretStoreError);
  });

  it('wraps safeStorage decryption failures without returning ciphertext', async () => {
    const safeStorage = fakeSafeStorage();
    const { store, filePath } = createStore(safeStorage);
    await store.put('secret:ark-primary', 'credential-canary-value');
    const failing = new ElectronSecretStore({
      filePath,
      safeStorage: { ...safeStorage, decryptString: () => { throw new Error('wrong OS key'); } },
    });
    await expect(failing.resolve('secret:ark-primary'))
      .rejects.toBeInstanceOf(ElectronSecretStoreError);
  });
});

function fakeSafeStorage(available = true): ElectronSafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: value => {
      const encoded = value.toString().replace(/^encrypted:/u, '');
      return Buffer.from(encoded, 'base64').toString();
    },
  };
}
