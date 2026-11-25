import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hcanvasSettingsPath, readHcanvasSettings, updateHcanvasSettings } from '../src/hcanvas/dataRoot.js';
import { applyRuntimeOverrides, detectRuntime, findRuntimeExecutable, probeRuntime, runtimeCommand, runtimeEnvironment } from '../src/hcanvas/runtimes.js';

const roots: string[] = [];
const previousConfig = process.env.HCANVAS_CONFIG_HOME;
const previousHome = process.env.HCANVAS_HOME;

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-settings-'));
  roots.push(root);
  process.env.HCANVAS_CONFIG_HOME = root;
  delete process.env.HCANVAS_HOME;
});

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.HCANVAS_CONFIG_HOME;
  else process.env.HCANVAS_CONFIG_HOME = previousConfig;
  if (previousHome === undefined) delete process.env.HCANVAS_HOME;
  else process.env.HCANVAS_HOME = previousHome;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Hcanvas settings persistence', () => {
  it('merges runtime, notebook and update settings atomically', async () => {
    await updateHcanvasSettings({ language: 'zh', runtimes: { python: '/opt/python', octave: '/opt/octave' } });
    const next = await updateHcanvasSettings({ runtimes: { cpp: '/opt/g++' }, notebook: { defaultKernel: 'cpp', outputCacheBytes: 1024 }, updates: { autoCheck: true, channel: 'preview' } });
    expect(next.language).toBe('zh');
    expect(next.runtimes).toEqual({ python: '/opt/python', octave: '/opt/octave', cpp: '/opt/g++' });
    expect(next.notebook).toEqual({ defaultKernel: 'cpp', outputCacheBytes: 1024 });
    expect(next.updates).toEqual({ autoCheck: true, channel: 'preview' });
    const saved = JSON.parse(await readFile(hcanvasSettingsPath(), 'utf8')) as typeof next;
    expect(saved).toEqual(next);
  });

  it('clears a runtime path with an empty string and ignores invalid values', async () => {
    await updateHcanvasSettings({ runtimes: { python: '/opt/python', octave: '/opt/octave' } });
    const next = await updateHcanvasSettings({ runtimes: { python: '', octave: 42 as never } });
    expect(next.runtimes).toEqual({ octave: '/opt/octave' });
    expect(await readHcanvasSettings()).toMatchObject({ runtimes: { octave: '/opt/octave' } });
  });

  it('keeps dataRoot and language when updating other sections', async () => {
    await updateHcanvasSettings({ dataRoot: path.join(os.tmpdir(), 'hcanvas-data'), language: 'en' });
    const next = await updateHcanvasSettings({ notebook: { defaultKernel: 'python' } });
    expect(next.dataRoot).toBe(path.resolve(path.join(os.tmpdir(), 'hcanvas-data')));
    expect(next.language).toBe('en');
  });
});

describe('runtime resolution', () => {
  it('finds an executable on PATH and against an absolute path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-runtime-'));
    roots.push(root);
    const executable = path.join(root, process.platform === 'win32' ? 'fake-tool.cmd' : 'fake-tool');
    await writeFile(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    const env = { ...process.env, PATH: root + path.delimiter + (process.env.PATH || '') };
    expect(findRuntimeExecutable('fake-tool', process.platform, env)).toBe(executable);
    expect(findRuntimeExecutable(executable, process.platform, env)).toBe(path.resolve(executable));
  });

  it('probes the current Node binary as a configured command', () => {
    const probe = probeRuntime('cpp', process.execPath);
    expect(probe.ok).toBe(true);
    expect(probe.path).toBe(path.resolve(process.execPath));
    expect(probe.version).toBeTruthy();
  });

  it('reports an actionable error for a missing configured executable', () => {
    const probe = probeRuntime('python', path.join(os.tmpdir(), 'missing-python-binary'));
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('not found');
  });

  it('uses configured commands and passes compiler/Octave environment overrides', () => {
    const settings = { runtimes: { python: '/custom/python', cpp: '/custom/g++', octave: '/custom/octave' } };
    expect(runtimeCommand('python', settings)).toBe('/custom/python');
    expect(runtimeCommand('cpp', {})).toBe('g++');
    expect(runtimeEnvironment(settings)).toEqual({ CXX: '/custom/g++', OCTAVE_BIN: '/custom/octave' });
  });

  it('applies interpreter and compiler overrides to sidecar declarations', () => {
    const result = applyRuntimeOverrides(['python', '-u', 'kernel.py'], { MANIFEST_VALUE: 'kept' }, { runtimes: { python: '/custom/python', cpp: '/custom/g++', octave: '/custom/octave' } });
    expect(result.command).toEqual(['/custom/python', '-u', 'kernel.py']);
    expect(result.env).toEqual({ MANIFEST_VALUE: 'kept', CXX: '/custom/g++', OCTAVE_BIN: '/custom/octave' });
    const untouched = applyRuntimeOverrides(['node', 'sidecar.mjs'], undefined, {});
    expect(untouched.command).toEqual(['node', 'sidecar.mjs']);
    expect(untouched.env).toBeUndefined();
  });

  it('detects a configured runtime without falling back to PATH', () => {
    const probe = detectRuntime('cpp', { runtimes: { cpp: process.execPath } });
    expect(probe.ok).toBe(true);
    expect(probe.source).toBe('configured');
    const missing = detectRuntime('python', { runtimes: { python: path.join(os.tmpdir(), 'missing-python-binary') } });
    expect(missing.ok).toBe(false);
    expect(missing.source).toBe('configured');
  });
});
