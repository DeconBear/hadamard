import { createHash } from 'node:crypto';

import {
  validatePluginManifest,
  validateRenderer,
  type HcPluginRendererDefinition,
} from '../pluginManifest.js';
import {
  HcExtensionError,
  HCANVAS_EXTENSION_SCHEMA,
  type HcExtensionBlockContribution,
  type HcExtensionCanvasContribution,
  type HcExtensionCapabilities,
  type HcExtensionCheckResult,
  type HcExtensionCommandContribution,
  type HcExtensionCommandExec,
  type HcExtensionConfigurationProperty,
  type HcExtensionContributes,
  type HcExtensionFormatContribution,
  type HcExtensionKernelContribution,
  type HcExtensionKeybindingContribution,
  type HcExtensionManifest,
  type HcExtensionMenuContribution,
  type HcExtensionMenuLocation,
  type HcExtensionProblemMatcher,
  type HcExtensionSidecarContribution,
  type HcExtensionSidecarLimits,
  type HcExtensionTerminalContribution,
  type HcExtensionToolContribution,
  type HcExtensionViewContribution,
  type HcExtensionViewSlot,
  type HcExtensionViewerContribution,
  type HcExtensionViewerSurface,
  type HcManifestIssue,
} from './manifestTypes.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VIEWER_SURFACES: readonly HcExtensionViewerSurface[] = ['file', 'block', 'tab', 'panel', 'page'];
const VIEW_SLOTS: readonly HcExtensionViewSlot[] = ['workspace-tab', 'panel-left', 'panel-right', 'panel-bottom', 'overlay'];
const MENU_LOCATIONS: readonly HcExtensionMenuLocation[] = ['palette', 'view/title', 'toolbar', 'editor/title', 'block/context'];
const UI_CAPABILITIES = ['view:tab', 'view:panel', 'view:block', 'page:format', 'overlay'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new HcExtensionError('invalid_manifest', path ? path + ': ' + message : message, path);
}

function text(value: unknown, path: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
  const trimmed = value.trim();
  if (trimmed.length > max) fail(path, 'must be at most ' + max + ' characters');
  return trimmed;
}

function optionalText(value: unknown, path: string, max = 120): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, path, max);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, 'must be an object');
  return value;
}

function arrayValue(value: unknown, path: string, max = 100): unknown[] {
  if (value === undefined) fail(path, 'is required');
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > max) fail(path, 'must have at most ' + max + ' entries');
  return value;
}

function booleanValue(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function positiveInteger(value: unknown, path: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(path, 'must be an integer between ' + min + ' and ' + max);
  return number;
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(path, 'must be one of ' + allowed.join(', '));
  return value as T;
}

function relativePath(value: unknown, path: string, max = 500, allowDot = false): string {
  const raw = text(value, path, max).replace(/\\/g, '/');
  if (allowDot && raw === '.') return raw;
  if (raw.startsWith('/')) fail(path, 'must be a relative path');
  if (/^[A-Za-z]:/.test(raw)) fail(path, 'must be a relative path');
  if (raw.includes('\0')) fail(path, 'contains a null byte');
  const segments = raw.split('/');
  if (segments.includes('..')) fail(path, 'must not contain ".." segments');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail(path, 'contains an invalid percent-encoded escape');
  }
  if (decoded.startsWith('/') || decoded.split('/').includes('..') || decoded.includes('\0')) fail(path, 'must not escape the extension folder');
  return raw;
}

function argvValue(value: unknown, path: string): string[] {
  const list = arrayValue(value, path, 32);
  if (!list.length) fail(path, 'must contain at least one argv element');
  return list.map((item, index) => text(item, path + '[' + index + ']', 500));
}

function stringList(value: unknown, path: string, max: number, itemMax = 64): string[] {
  const list = arrayValue(value, path, max);
  return list.map((item, index) => text(item, path + '[' + index + ']', itemMax));
}

function envValue(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const box = objectValue(value, path);
  const entries = Object.entries(box);
  if (entries.length > 32) fail(path, 'must have at most 32 entries');
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) fail(path + '.' + key, 'is not a valid environment variable name');
    if (/^(HADAMARD|HCANVAS)_/.test(key)) fail(path + '.' + key, 'reserved host environment variable prefix');
    if (typeof item !== 'string') fail(path + '.' + key, 'must be a string');
    if (item.length > 2000) fail(path + '.' + key, 'is too long');
    out[key] = item;
  }
  return out;
}

function viaV1<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function viewerSurfaces(value: unknown, path: string, fallback: HcExtensionViewerSurface[]): HcExtensionViewerSurface[] {
  if (value === undefined) return [...fallback];
  const list = stringList(value, path, 5, 16);
  const seen = new Set<HcExtensionViewerSurface>();
  for (const [index, item] of list.entries()) {
    if (!(VIEWER_SURFACES as readonly string[]).includes(item)) fail(path + '[' + index + ']', 'must be one of ' + VIEWER_SURFACES.join(', '));
    seen.add(item as HcExtensionViewerSurface);
  }
  return [...seen];
}

function normalizeCanvas(raw: unknown): HcExtensionCanvasContribution {
  const box = raw === undefined ? {} : objectValue(raw, 'contributes.canvas');
  const blocksRaw = box.blocks === undefined ? undefined : arrayValue(box.blocks, 'contributes.canvas.blocks', 50);
  let blocks: HcExtensionBlockContribution[] = [];
  if (blocksRaw && blocksRaw.length) {
    const validated = viaV1('contributes.canvas.blocks', () => validatePluginManifest({ id: 'canvas-extension', blocks: blocksRaw }).blocks);
    blocks = validated.map((block, index) => {
      const viewerRaw = isObject(blocksRaw[index]) ? (blocksRaw[index] as Record<string, unknown>).viewer : undefined;
      const contribution: HcExtensionBlockContribution = { ...block };
      if (viewerRaw !== undefined) contribution.viewer = text(viewerRaw, 'contributes.canvas.blocks[' + index + '].viewer', 64);
      return contribution;
    });
  }
  const shapesRaw = box.shapes === undefined ? undefined : arrayValue(box.shapes, 'contributes.canvas.shapes', 50);
  const shapes = shapesRaw && shapesRaw.length
    ? viaV1('contributes.canvas.shapes', () => validatePluginManifest({ id: 'canvas-extension', shapes: shapesRaw }).shapes)
    : [];
  const presetsRaw = box.pagePresets === undefined ? undefined : arrayValue(box.pagePresets, 'contributes.canvas.pagePresets', 30);
  const pagePresets = presetsRaw && presetsRaw.length
    ? viaV1('contributes.canvas.pagePresets', () => validatePluginManifest({ id: 'canvas-extension', pagePresets: presetsRaw }).pagePresets)
    : [];
  let script: { script: string; runtime: 'sandbox' } | undefined;
  if (box.script !== undefined) {
    if (typeof box.script === 'string') script = { script: text(box.script, 'contributes.canvas.script', 200000), runtime: 'sandbox' };
    else {
      const scriptBox = objectValue(box.script, 'contributes.canvas.script');
      const runtime = enumValue(scriptBox.runtime, 'contributes.canvas.script.runtime', ['sandbox'] as const, 'sandbox');
      script = { script: text(scriptBox.script, 'contributes.canvas.script.script', 200000), runtime };
    }
  }
  return { blocks, shapes, pagePresets, ...(script ? { script } : {}) };
}

function normalizeRenderers(raw: unknown): HcPluginRendererDefinition[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.renderers', 20);
  return list.map((item, index) => viaV1('contributes.renderers[' + index + ']', () => validateRenderer(item, index)));
}

function normalizeFormats(raw: unknown): HcExtensionFormatContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.formats', 100);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.formats[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate format id "' + id + '"', path + '.id');
    seen.add(id);
    const extensionsRaw = box.extensions === undefined ? [] : stringList(box.extensions, path + '.extensions', 50, 80);
    const extensions: string[] = [];
    for (const [extensionIndex, extension] of extensionsRaw.entries()) {
      if (!EXTENSION_PATTERN.test(extension)) fail(path + '.extensions[' + extensionIndex + ']', 'must look like ".ext"');
      extensions.push(extension.toLowerCase());
    }
    const mimeRaw = box.mime === undefined ? [] : stringList(box.mime, path + '.mime', 20, 120);
    for (const [mimeIndex, mime] of mimeRaw.entries()) {
      if (!MIME_PATTERN.test(mime)) fail(path + '.mime[' + mimeIndex + ']', 'must be a valid MIME type');
    }
    if (!extensions.length && !mimeRaw.length) fail(path, 'needs at least one extension or MIME type');
    return {
      id,
      label: optionalText(box.label, path + '.label', 120) || id,
      extensions: [...new Set(extensions)],
      ...(mimeRaw.length ? { mime: [...new Set(mimeRaw)] } : {}),
      viewer: text(box.viewer, path + '.viewer', 64),
      surfaces: viewerSurfaces(box.surfaces, path + '.surfaces', ['file']),
      priority: enumValue(box.priority, path + '.priority', ['default', 'option'] as const, 'default'),
    };
  });
}

function normalizeViewers(raw: unknown, builtin: boolean): HcExtensionViewerContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.viewers', 50);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.viewers[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate viewer id "' + id + '"', path + '.id');
    seen.add(id);
    const type = enumValue(box.type, path + '.type', ['iframe', 'builtin'] as const);
    if (type === 'builtin' && !builtin) fail(path + '.type', 'builtin viewers are only allowed in bundled extensions');
    if (type === 'iframe' && box.builtinId !== undefined) fail(path + '.builtinId', 'is only valid for builtin viewers');
    let entry: string | undefined;
    if (type === 'iframe') entry = relativePath(box.entry, path + '.entry', 500);
    const resources = box.resources === undefined ? undefined : stringList(box.resources, path + '.resources', 20, 300)
      .map((resource, resourceIndex) => relativePath(resource, path + '.resources[' + resourceIndex + ']', 300));
    return {
      id,
      label: optionalText(box.label, path + '.label', 120) || id,
      type,
      ...(entry ? { entry } : {}),
      ...(type === 'builtin' ? { builtinId: optionalText(box.builtinId, path + '.builtinId', 64) || id } : {}),
      ...(resources ? { resources } : {}),
      surfaces: viewerSurfaces(box.surfaces, path + '.surfaces', ['file']),
      singleton: booleanValue(box.singleton, path + '.singleton', true),
    };
  });
}

function normalizeViews(raw: unknown): HcExtensionViewContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.views', 50);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.views[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate view id "' + id + '"', path + '.id');
    seen.add(id);
    return {
      id,
      title: text(box.title, path + '.title', 120),
      slot: enumValue(box.slot, path + '.slot', VIEW_SLOTS),
      viewer: text(box.viewer, path + '.viewer', 64),
      when: optionalText(box.when, path + '.when', 500),
      icon: optionalText(box.icon, path + '.icon', 120),
      singleton: booleanValue(box.singleton, path + '.singleton', true),
    };
  });
}

function normalizeCommandExec(raw: unknown, path: string): HcExtensionCommandExec {
  const box = objectValue(raw, path);
  const kind = enumValue(box.kind, path + '.kind', ['builtin', 'sidecar', 'tool', 'view', 'openExternal'] as const);
  if (kind === 'builtin') return { kind, builtinId: text(box.builtinId, path + '.builtinId', 128) };
  if (kind === 'sidecar') {
    if (box.params !== undefined && box.params !== null && typeof box.params !== 'object') fail(path + '.params', 'must be an object when provided');
    return {
      kind,
      sidecar: text(box.sidecar, path + '.sidecar', 64),
      method: text(box.method, path + '.method', 120),
      ...(box.params !== undefined ? { params: box.params } : {}),
    };
  }
  if (kind === 'tool') return { kind, toolId: text(box.toolId, path + '.toolId', 64) };
  if (kind === 'view') return { kind, viewId: text(box.viewId, path + '.viewId', 64) };
  const url = text(box.url, path + '.url', 500);
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail(path + '.url', 'must be an absolute http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(path + '.url', 'must use http or https');
  return { kind, url };
}

function normalizeCommands(raw: unknown): HcExtensionCommandContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.commands', 200);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.commands[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 128);
    if (!COMMAND_ID_PATTERN.test(id)) fail(path + '.id', 'must be a valid command id');
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate command id "' + id + '"', path + '.id');
    seen.add(id);
    return {
      id,
      title: text(box.title, path + '.title', 160),
      category: optionalText(box.category, path + '.category', 80),
      icon: optionalText(box.icon, path + '.icon', 120),
      when: optionalText(box.when, path + '.when', 500),
      ...(box.exec !== undefined ? { exec: normalizeCommandExec(box.exec, path + '.exec') } : {}),
    };
  });
}

function normalizeMenus(raw: unknown): HcExtensionMenuContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.menus', 100);
  return list.map((item, index) => {
    const path = 'contributes.menus[' + index + ']';
    const box = objectValue(item, path);
    const menu: HcExtensionMenuContribution = {
      command: text(box.command, path + '.command', 128),
      menu: enumValue(box.menu, path + '.menu', MENU_LOCATIONS),
      when: optionalText(box.when, path + '.when', 500),
      group: optionalText(box.group, path + '.group', 80),
    };
    if (box.order !== undefined) {
      const order = Number(box.order);
      if (!Number.isFinite(order)) fail(path + '.order', 'must be a number');
      menu.order = order;
    }
    return menu;
  });
}

function keybindingKey(value: unknown, path: string): string {
  const key = text(value, path, 120);
  const parts = key.split('+');
  if (parts.length > 5) fail(path, 'has too many modifiers');
  const final = parts[parts.length - 1] || '';
  if (!/^(?:[A-Za-z][A-Za-z0-9]*|F\d{1,2}|[^\sA-Za-z0-9])$/.test(final)) fail(path, 'has an invalid key name');
  const modifiers = parts.slice(0, -1);
  const allowed = ['Ctrl', 'Cmd', 'CmdOrCtrl', 'Alt', 'Shift', 'Meta'];
  const seen = new Set<string>();
  for (const modifier of modifiers) {
    if (!allowed.includes(modifier)) fail(path, 'has an unknown modifier "' + modifier + '"');
    if (seen.has(modifier)) fail(path, 'has a duplicate modifier "' + modifier + '"');
    seen.add(modifier);
  }
  return key;
}

function normalizeKeybindings(raw: unknown): HcExtensionKeybindingContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.keybindings', 200);
  return list.map((item, index) => {
    const path = 'contributes.keybindings[' + index + ']';
    const box = objectValue(item, path);
    return {
      command: text(box.command, path + '.command', 128),
      key: keybindingKey(box.key, path + '.key'),
      when: optionalText(box.when, path + '.when', 500),
    };
  });
}

function normalizeSidecars(raw: unknown): HcExtensionSidecarContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.sidecars', 20);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.sidecars[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate sidecar id "' + id + '"', path + '.id');
    seen.add(id);
    const requestsRaw = box.requests === undefined ? [] : arrayValue(box.requests, path + '.requests', 32);
    const requests = requestsRaw.map((request, requestIndex) => {
      const requestPath = path + '.requests[' + requestIndex + ']';
      const requestBox = objectValue(request, requestPath);
      return {
        method: text(requestBox.method, requestPath + '.method', 120),
        ...(requestBox.timeoutMs !== undefined ? { timeoutMs: positiveInteger(requestBox.timeoutMs, requestPath + '.timeoutMs', 1000, 3600000) } : {}),
        progress: booleanValue(requestBox.progress, requestPath + '.progress', false),
      };
    });
    let limits: HcExtensionSidecarLimits | undefined;
    if (box.limits !== undefined) {
      const limitsBox = objectValue(box.limits, path + '.limits');
      limits = {};
      if (limitsBox.maxStdoutBytes !== undefined) limits.maxStdoutBytes = positiveInteger(limitsBox.maxStdoutBytes, path + '.limits.maxStdoutBytes', 1024, 33554432);
      if (limitsBox.maxArtifactBytes !== undefined) limits.maxArtifactBytes = positiveInteger(limitsBox.maxArtifactBytes, path + '.limits.maxArtifactBytes', 1024, 1073741824);
    }
    return {
      id,
      label: optionalText(box.label, path + '.label', 120) || id,
      command: argvValue(box.command, path + '.command'),
      cwd: enumValue(box.cwd, path + '.cwd', ['workspace', 'extension'] as const, 'extension'),
      ...(box.env !== undefined ? { env: envValue(box.env, path + '.env') } : {}),
      role: enumValue(box.role, path + '.role', ['service', 'kernel'] as const, 'service'),
      protocol: enumValue(box.protocol, path + '.protocol', ['jsonrpc-stdio'] as const, 'jsonrpc-stdio'),
      requests,
      ...(box.idleTimeoutMs !== undefined ? { idleTimeoutMs: positiveInteger(box.idleTimeoutMs, path + '.idleTimeoutMs', 30000, 86400000) } : {}),
      outputChannel: optionalText(box.outputChannel, path + '.outputChannel', 80),
      ...(limits ? { limits } : {}),
    };
  });
}

function normalizeKernels(raw: unknown): HcExtensionKernelContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.kernels', 20);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.kernels[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate kernel id "' + id + '"', path + '.id');
    seen.add(id);
    const features = box.features === undefined ? [] : stringList(box.features, path + '.features', 10, 32);
    for (const [featureIndex, feature] of features.entries()) {
      if (!['execute', 'interrupt', 'complete', 'inspect', 'variables'].includes(feature)) fail(path + '.features[' + featureIndex + ']', 'is not a supported kernel feature');
    }
    return {
      id,
      label: optionalText(box.label, path + '.label', 120) || id,
      language: text(box.language, path + '.language', 64),
      sidecar: text(box.sidecar, path + '.sidecar', 64),
      features: [...new Set(features)],
      defaultFor: box.defaultFor === undefined ? [] : stringList(box.defaultFor, path + '.defaultFor', 20, 64),
    };
  });
}

function normalizeProblemMatcher(raw: unknown, path: string): HcExtensionProblemMatcher | undefined {
  if (raw === undefined) return undefined;
  const box = objectValue(raw, path);
  const regex = text(box.regex, path + '.regex', 1000);
  try { new RegExp(regex); } catch { fail(path + '.regex', 'is not a valid regular expression'); }
  const matcher: HcExtensionProblemMatcher = { regex };
  for (const key of ['file', 'line', 'column', 'severity', 'message'] as const) {
    if (box[key] !== undefined) matcher[key] = positiveInteger(box[key], path + '.' + key, 1, 99);
  }
  return matcher;
}

function normalizeTools(raw: unknown): HcExtensionToolContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.tools', 50);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.tools[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate tool id "' + id + '"', path + '.id');
    seen.add(id);
    return {
      id,
      label: text(box.label, path + '.label', 160),
      command: argvValue(box.command, path + '.command'),
      cwd: enumValue(box.cwd, path + '.cwd', ['workspace', 'extension'] as const, 'workspace'),
      ...(box.env !== undefined ? { env: envValue(box.env, path + '.env') } : {}),
      output: enumValue(box.output, path + '.output', ['output', 'terminal'] as const, 'output'),
      ...(box.problemMatcher !== undefined ? { problemMatcher: normalizeProblemMatcher(box.problemMatcher, path + '.problemMatcher') } : {}),
    };
  });
}

function normalizeTerminals(raw: unknown): HcExtensionTerminalContribution[] {
  if (raw === undefined) return [];
  const list = arrayValue(raw, 'contributes.terminals', 20);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const path = 'contributes.terminals[' + index + ']';
    const box = objectValue(item, path);
    const id = text(box.id, path + '.id', 64);
    if (!CONTRIBUTION_ID_PATTERN.test(id)) fail(path + '.id', 'must match ' + CONTRIBUTION_ID_PATTERN);
    if (seen.has(id)) throw new HcExtensionError('duplicate_id', 'Duplicate terminal id "' + id + '"', path + '.id');
    seen.add(id);
    return {
      id,
      label: optionalText(box.label, path + '.label', 120) || id,
      command: argvValue(box.command, path + '.command'),
      cwd: enumValue(box.cwd, path + '.cwd', ['workspace', 'extension'] as const, 'workspace'),
      ...(box.env !== undefined ? { env: envValue(box.env, path + '.env') } : {}),
    };
  });
}

function normalizeConfiguration(raw: unknown): Record<string, HcExtensionConfigurationProperty> {
  if (raw === undefined) return {};
  const box = objectValue(raw, 'contributes.configuration');
  const entries = Object.entries(box);
  if (entries.length > 50) fail('contributes.configuration', 'must have at most 50 keys');
  const out: Record<string, HcExtensionConfigurationProperty> = {};
  for (const [key, value] of entries) {
    const path = 'contributes.configuration.' + key;
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) fail('contributes.configuration', 'has an invalid key "' + key + '"');
    const propertyBox = objectValue(value, path);
    const type = enumValue(propertyBox.type, path + '.type', ['string', 'number', 'boolean', 'select'] as const);
    const property: HcExtensionConfigurationProperty = {
      type,
      scope: enumValue(propertyBox.scope, path + '.scope', ['window', 'workspace', 'user'] as const, 'workspace'),
      description: optionalText(propertyBox.description, path + '.description', 500),
    };
    if (propertyBox.enum !== undefined) {
      if (type !== 'select') fail(path + '.enum', 'is only valid for select properties');
      property.enum = stringList(propertyBox.enum, path + '.enum', 100, 200);
      if (!property.enum.length) fail(path + '.enum', 'must not be empty');
    }
    if (type === 'select' && !property.enum) fail(path + '.enum', 'is required for select properties');
    if (propertyBox.default !== undefined) {
      const defaultValue = propertyBox.default;
      if (type === 'string' && typeof defaultValue !== 'string') fail(path + '.default', 'must be a string');
      if (type === 'number' && !Number.isFinite(Number(defaultValue))) fail(path + '.default', 'must be a number');
      if (type === 'boolean' && typeof defaultValue !== 'boolean') fail(path + '.default', 'must be a boolean');
      if (type === 'select' && (typeof defaultValue !== 'string' || !property.enum!.includes(defaultValue))) fail(path + '.default', 'must be one of the enum values');
      property.default = defaultValue as string | number | boolean;
    }
    out[key] = property;
  }
  return out;
}

function normalizeContributes(raw: unknown, builtin: boolean): HcExtensionContributes {
  const box = raw === undefined ? fail('contributes', 'is required') : objectValue(raw, 'contributes');
  return {
    canvas: normalizeCanvas(box.canvas),
    renderers: normalizeRenderers(box.renderers),
    formats: normalizeFormats(box.formats),
    viewers: normalizeViewers(box.viewers, builtin),
    views: normalizeViews(box.views),
    commands: normalizeCommands(box.commands),
    menus: normalizeMenus(box.menus),
    keybindings: normalizeKeybindings(box.keybindings),
    sidecars: normalizeSidecars(box.sidecars),
    kernels: normalizeKernels(box.kernels),
    tools: normalizeTools(box.tools),
    terminals: normalizeTerminals(box.terminals),
    configuration: normalizeConfiguration(box.configuration),
  };
}

function crossCheckContributes(contributes: HcExtensionContributes): void {
  const viewerIds = new Set(contributes.viewers.map(viewer => viewer.id));
  const viewIds = new Set(contributes.views.map(view => view.id));
  const commandIds = new Set(contributes.commands.map(command => command.id));
  const sidecarIds = new Set(contributes.sidecars.map(sidecar => sidecar.id));
  const toolIds = new Set(contributes.tools.map(tool => tool.id));
  contributes.formats.forEach((format, index) => {
    if (!viewerIds.has(format.viewer)) throw new HcExtensionError('unknown_reference', 'contributes.formats[' + index + '].viewer references unknown viewer "' + format.viewer + '"', 'contributes.formats[' + index + '].viewer');
  });
  contributes.views.forEach((view, index) => {
    if (!viewerIds.has(view.viewer)) throw new HcExtensionError('unknown_reference', 'contributes.views[' + index + '].viewer references unknown viewer "' + view.viewer + '"', 'contributes.views[' + index + '].viewer');
  });
  contributes.canvas.blocks.forEach((block, index) => {
    if (block.viewer !== undefined && !viewerIds.has(block.viewer)) throw new HcExtensionError('unknown_reference', 'contributes.canvas.blocks[' + index + '].viewer references unknown viewer "' + block.viewer + '"', 'contributes.canvas.blocks[' + index + '].viewer');
  });
  contributes.menus.forEach((menu, index) => {
    if (!commandIds.has(menu.command)) throw new HcExtensionError('unknown_reference', 'contributes.menus[' + index + '].command references unknown command "' + menu.command + '"', 'contributes.menus[' + index + '].command');
  });
  contributes.keybindings.forEach((keybinding, index) => {
    if (!commandIds.has(keybinding.command)) throw new HcExtensionError('unknown_reference', 'contributes.keybindings[' + index + '].command references unknown command "' + keybinding.command + '"', 'contributes.keybindings[' + index + '].command');
  });
  contributes.kernels.forEach((kernel, index) => {
    if (!sidecarIds.has(kernel.sidecar)) throw new HcExtensionError('unknown_reference', 'contributes.kernels[' + index + '].sidecar references unknown sidecar "' + kernel.sidecar + '"', 'contributes.kernels[' + index + '].sidecar');
  });
  contributes.commands.forEach((command, index) => {
    const exec = command.exec;
    if (!exec) return;
    const path = 'contributes.commands[' + index + '].exec';
    if (exec.kind === 'sidecar' && !sidecarIds.has(exec.sidecar!)) throw new HcExtensionError('unknown_reference', path + ' references unknown sidecar "' + exec.sidecar + '"', path);
    if (exec.kind === 'tool' && !toolIds.has(exec.toolId!)) throw new HcExtensionError('unknown_reference', path + ' references unknown tool "' + exec.toolId + '"', path);
    if (exec.kind === 'view' && !viewIds.has(exec.viewId!)) throw new HcExtensionError('unknown_reference', path + ' references unknown view "' + exec.viewId + '"', path);
  });
}

function normalizeWorkspacePaths(raw: unknown, path: string): string[] {
  const list = stringList(raw, path, 20, 200);
  return list.map((item, index) => relativePath(item, path + '[' + index + ']', 200, true));
}

function normalizeNetwork(raw: unknown, path: string, warnings: HcManifestIssue[]): string[] {
  const entries = stringList(raw, path, 20, 300);
  for (const [index, entry] of entries.entries()) {
    let parsed: URL;
    try { parsed = new URL(entry.replace('*.', 'wildcard.')); } catch { fail(path + '[' + index + ']', 'must be an absolute URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(path + '[' + index + ']', 'must use http or https');
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)) {
      warnings.push({ path: path + '[' + index + ']', message: 'declares a local/private network endpoint; consent must call it out as a local service', severity: 'warning' });
    }
  }
  return [...new Set(entries)].sort();
}

function normalizeCapabilities(raw: unknown, contributes: HcExtensionContributes, warnings: HcManifestIssue[]): HcExtensionCapabilities {
  const box = raw === undefined ? fail('capabilities', 'is required (use {} when declaring no capabilities)') : objectValue(raw, 'capabilities');
  const capabilities: HcExtensionCapabilities = {};
  if (box.document !== undefined) {
    const documentBox = objectValue(box.document, 'capabilities.document');
    capabilities.document = {
      ...(documentBox.read !== undefined ? { read: booleanValue(documentBox.read, 'capabilities.document.read', false) } : {}),
      ...(documentBox.write !== undefined ? { write: booleanValue(documentBox.write, 'capabilities.document.write', false) } : {}),
    };
  }
  if (box.workspace !== undefined) {
    const workspaceBox = objectValue(box.workspace, 'capabilities.workspace');
    capabilities.workspace = {
      ...(workspaceBox.read !== undefined ? { read: normalizeWorkspacePaths(workspaceBox.read, 'capabilities.workspace.read') } : {}),
      ...(workspaceBox.write !== undefined ? { write: normalizeWorkspacePaths(workspaceBox.write, 'capabilities.workspace.write') } : {}),
    };
  }
  if (box.network !== undefined) capabilities.network = normalizeNetwork(box.network, 'capabilities.network', warnings);
  if (box.process !== undefined) {
    const processBox = objectValue(box.process, 'capabilities.process');
    capabilities.process = {
      sidecars: processBox.sidecars === undefined ? [] : [...new Set(stringList(processBox.sidecars, 'capabilities.process.sidecars', 20, 64))].sort(),
      tools: processBox.tools === undefined ? [] : [...new Set(stringList(processBox.tools, 'capabilities.process.tools', 20, 64))].sort(),
      terminals: processBox.terminals === undefined ? [] : [...new Set(stringList(processBox.terminals, 'capabilities.process.terminals', 20, 64))].sort(),
    };
  }
  if (box.ui !== undefined) {
    const ui = stringList(box.ui, 'capabilities.ui', 10, 32);
    for (const [index, item] of ui.entries()) {
      if (!(UI_CAPABILITIES as readonly string[]).includes(item)) fail('capabilities.ui[' + index + ']', 'must be one of ' + UI_CAPABILITIES.join(', '));
    }
    capabilities.ui = [...new Set(ui)].sort();
  }
  if (box.clipboard !== undefined) capabilities.clipboard = booleanValue(box.clipboard, 'capabilities.clipboard', false);
  const processCapability = capabilities.process ?? { sidecars: [], tools: [], terminals: [] };
  const checkProcess = (kind: 'sidecars' | 'tools' | 'terminals', declared: string[], actual: string[]): void => {
    for (const id of actual) {
      if (!declared.includes(id)) throw new HcExtensionError('invalid_manifest', 'contributes.' + kind + ' "' + id + '" requires capabilities.process.' + kind, 'capabilities.process.' + kind);
    }
    for (const id of declared) {
      if (!actual.includes(id)) throw new HcExtensionError('unknown_reference', 'capabilities.process.' + kind + ' references unknown ' + kind.slice(0, -1) + ' "' + id + '"', 'capabilities.process.' + kind);
    }
  };
  checkProcess('sidecars', processCapability.sidecars ?? [], contributes.sidecars.map(sidecar => sidecar.id));
  checkProcess('tools', processCapability.tools ?? [], contributes.tools.map(tool => tool.id));
  checkProcess('terminals', processCapability.terminals ?? [], contributes.terminals.map(terminal => terminal.id));
  return capabilities;
}

function normalizeActivation(raw: unknown, contributes: HcExtensionContributes): string[] {
  if (raw === undefined) return [];
  const list = stringList(raw, 'activation', 50, 200);
  const seen = new Set<string>();
  const commandIds = new Set(contributes.commands.map(command => command.id));
  const viewIds = new Set(contributes.views.map(view => view.id));
  const formatIds = new Set(contributes.formats.map(format => format.id));
  const kernelIds = new Set(contributes.kernels.map(kernel => kernel.id));
  const sidecarIds = new Set(contributes.sidecars.map(sidecar => sidecar.id));
  for (const [index, event] of list.entries()) {
    if (seen.has(event)) continue;
    seen.add(event);
    const path = 'activation[' + index + ']';
    if (event === 'onTrust') continue;
    const match = /^(onCommand|onView|onFormat|onKernel|onSidecar|onFilePattern):(.+)$/.exec(event);
    if (!match) fail(path, 'is not a supported activation event');
    const kind = match[1];
    const target = match[2]!;
    if (kind === 'onCommand' && !commandIds.has(target)) throw new HcExtensionError('unknown_reference', path + ' references unknown command "' + target + '"', path);
    if (kind === 'onView' && !viewIds.has(target)) throw new HcExtensionError('unknown_reference', path + ' references unknown view "' + target + '"', path);
    if (kind === 'onFormat' && !formatIds.has(target)) throw new HcExtensionError('unknown_reference', path + ' references unknown format "' + target + '"', path);
    if (kind === 'onKernel' && !kernelIds.has(target)) throw new HcExtensionError('unknown_reference', path + ' references unknown kernel "' + target + '"', path);
    if (kind === 'onSidecar' && !sidecarIds.has(target)) throw new HcExtensionError('unknown_reference', path + ' references unknown sidecar "' + target + '"', path);
    if (kind === 'onFilePattern' && (target.includes('..') || target.startsWith('/'))) fail(path, 'contains an unsafe file pattern');
  }
  return [...seen];
}

function contributionCount(contributes: HcExtensionContributes): number {
  return contributes.canvas.blocks.length + contributes.canvas.shapes.length + contributes.canvas.pagePresets.length +
    (contributes.canvas.script ? 1 : 0) + contributes.renderers.length + contributes.formats.length + contributes.viewers.length +
    contributes.views.length + contributes.commands.length + contributes.menus.length + contributes.keybindings.length +
    contributes.sidecars.length + contributes.kernels.length + contributes.tools.length + contributes.terminals.length +
    Object.keys(contributes.configuration).length;
}

function normalizeManifest(input: unknown, warnings: HcManifestIssue[]): HcExtensionManifest {
  if (!isObject(input)) fail('', 'manifest must be an object');
  const raw = input;
  if (raw.schema !== HCANVAS_EXTENSION_SCHEMA) fail('schema', 'must be "' + HCANVAS_EXTENSION_SCHEMA + '"');
  const id = text(raw.id, 'id', 64);
  if (!ID_PATTERN.test(id)) fail('id', 'must match ' + ID_PATTERN);
  const name = text(raw.name, 'name', 120);
  const version = text(raw.version, 'version', 64);
  if (!SEMVER_PATTERN.test(version)) fail('version', 'must be a semver version such as 1.2.3');
  const description = optionalText(raw.description, 'description', 500);
  const author = optionalText(raw.author, 'author', 120);
  const license = optionalText(raw.license, 'license', 80);
  const homepage = optionalText(raw.homepage, 'homepage', 300);
  if (homepage !== undefined) {
    let parsed: URL;
    try { parsed = new URL(homepage); } catch { fail('homepage', 'must be an absolute http(s) URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('homepage', 'must use http or https');
  }
  if (!isObject(raw.engines)) fail('engines', 'must be an object such as { "hcanvas": ">=0.1.0" }');
  const engineRange = text(raw.engines.hcanvas, 'engines.hcanvas', 64);
  if (!isEngineRangeShape(engineRange)) fail('engines.hcanvas', 'must be a semver range such as ">=0.1.0" or "^0.1.0"');
  const builtin = booleanValue(raw.builtin, 'builtin', false);
  const contributes = normalizeContributes(raw.contributes, builtin);
  crossCheckContributes(contributes);
  const capabilities = normalizeCapabilities(raw.capabilities, contributes, warnings);
  const activation = normalizeActivation(raw.activation, contributes);
  let dev: HcExtensionManifest['dev'];
  if (raw.dev !== undefined) {
    const devBox = objectValue(raw.dev, 'dev');
    dev = { ...(devBox.hotReload !== undefined ? { hotReload: booleanValue(devBox.hotReload, 'dev.hotReload', false) } : {}) };
  }
  const signature = optionalText(raw.signature, 'signature', 500);
  if (contributionCount(contributes) === 0) warnings.push({ path: 'contributes', message: 'declares no contributions', severity: 'warning' });
  const usesUi = contributes.viewers.length + contributes.views.length + contributes.menus.length + contributes.keybindings.length > 0;
  if (usesUi && !(capabilities.ui && capabilities.ui.length)) warnings.push({ path: 'capabilities.ui', message: 'UI contributions are declared without the ui capability', severity: 'warning' });
  if (capabilities.ui && capabilities.ui.length && !usesUi) warnings.push({ path: 'capabilities.ui', message: 'declares ui capability but no UI contributions', severity: 'warning' });
  return {
    schema: HCANVAS_EXTENSION_SCHEMA,
    id,
    name,
    version,
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    engines: { hcanvas: engineRange },
    activation,
    capabilities,
    contributes,
    builtin,
    ...(dev ? { dev } : {}),
    ...(signature !== undefined ? { signature } : {}),
  };
}

/** Validate and normalize a v2 extension manifest. Throws HcExtensionError on failure. */
export function validateExtensionManifest(input: unknown): HcExtensionManifest {
  return normalizeManifest(input, []);
}

/** Non-throwing validation with readable issues; used by POST /api/extensions/validate. */
export function checkExtensionManifest(input: unknown): HcExtensionCheckResult {
  const warnings: HcManifestIssue[] = [];
  try {
    const manifest = normalizeManifest(input, warnings);
    return { ok: true, manifest, errors: [], warnings };
  } catch (error) {
    if (error instanceof HcExtensionError) {
      return { ok: false, errors: [{ path: error.path, message: error.message, severity: 'error' }], warnings };
    }
    return { ok: false, errors: [{ path: '', message: error instanceof Error ? error.message : String(error), severity: 'error' }], warnings };
  }
}

/** True when the manifest uses process capabilities (sidecars/tools/terminals/kernels). */
export function manifestRequiresProcess(manifest: HcExtensionManifest): boolean {
  const processCapability = manifest.capabilities.process;
  if (processCapability && ((processCapability.sidecars?.length ?? 0) > 0 || (processCapability.tools?.length ?? 0) > 0 || (processCapability.terminals?.length ?? 0) > 0)) return true;
  const contributes = manifest.contributes;
  return contributes.sidecars.length > 0 || contributes.tools.length > 0 || contributes.terminals.length > 0 || contributes.kernels.length > 0;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) out[key] = sortValue(item);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON string with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Canonical capabilities digest recorded in grant records. A changed digest means
 * the user must re-consent after an extension update (SPEC-3.1 rule 5).
 */
export function capabilitiesHash(capabilities: HcExtensionCapabilities): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(capabilities), 'utf8').digest('hex');
}

/** Loose semver-range shape check (major/minor/patch components only). */
export function isEngineRangeShape(range: string): boolean {
  if (range === '*' || range === 'x' || range === 'X') return true;
  return range.split('||').some(alternative => {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return false;
    return terms.every(term => /^(?:[\^~]|>=|<=|>|<|=)?\s*v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(term));
  });
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function satisfiesTerm(version: ParsedVersion, term: string): boolean | undefined {
  if (term === '*' || term === 'x' || term === 'X') return true;
  const match = /^(?:([\^~]|>=|<=|>|<|=))?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(term);
  if (!match) return undefined;
  const operator = match[1] ?? '=';
  const target: ParsedVersion = { major: Number(match[2]), minor: Number(match[3] ?? 0), patch: Number(match[4] ?? 0) };
  const comparison = compareVersions(version, target);
  if (operator === '>=') return comparison >= 0;
  if (operator === '>') return comparison > 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '^') {
    if (target.major > 0) return version.major === target.major && comparison >= 0;
    return version.major === 0 && version.minor === target.minor && comparison >= 0;
  }
  if (operator === '~') {
    if (match[3] !== undefined) return version.major === target.major && version.minor === target.minor && comparison >= 0;
    return version.major === target.major && comparison >= 0;
  }
  return comparison === 0;
}

/**
 * Check whether a concrete version satisfies a manifest engines range.
 * Returns undefined when the range cannot be interpreted (callers should warn, not reject).
 */
export function engineRangeSatisfies(range: string, version: string): boolean | undefined {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return undefined;
  let sawTerm = false;
  for (const alternative of range.split('||')) {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) continue;
    let matches = true;
    for (const term of terms) {
      const result = satisfiesTerm(parsedVersion, term);
      if (result === undefined) return undefined;
      sawTerm = true;
      if (!result) { matches = false; break; }
    }
    if (matches) return true;
  }
  return sawTerm ? false : undefined;
}
