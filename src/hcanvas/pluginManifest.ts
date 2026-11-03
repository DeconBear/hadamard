export const HC_PLUGIN_SCHEMA = 'hcanvas-plugin/1';

export type HcPluginFieldKind = 'text' | 'textarea' | 'color' | 'select' | 'number';

export interface HcPluginField {
  key: string;
  label: string;
  kind: HcPluginFieldKind;
  options?: Array<{ value: string; label: string }>;
}

export interface HcDeclarativeBlock {
  type: string;
  label: string;
  hint?: string;
  defaultSize?: { w: number; h: number };
  defaultData?: Record<string, unknown>;
  fields?: HcPluginField[];
  render: string;
}

export interface HcPluginManifest {
  schema: string;
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  blocks: HcDeclarativeBlock[];
}

function fail(message: string): never {
  throw new Error(message);
}

function str(value: unknown, name: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim()) fail(name + ' must be a non-empty string');
  const text = value.trim();
  if (text.length > max) fail(name + ' is too long');
  return text;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(name + ' must be a positive number');
  return number;
}

function validateField(input: unknown, index: number): HcPluginField {
  if (!input || typeof input !== 'object') fail('fields[' + index + '] must be an object');
  const raw = input as Record<string, unknown>;
  const key = str(raw.key, 'fields[' + index + '].key', 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) fail('fields[' + index + '].key has invalid characters');
  const kind = raw.kind;
  if (kind !== 'text' && kind !== 'textarea' && kind !== 'color' && kind !== 'select' && kind !== 'number') fail('fields[' + index + '].kind is not supported');
  const field: HcPluginField = { key, label: str(raw.label, 'fields[' + index + '].label'), kind };
  if (Array.isArray(raw.options)) {
    field.options = raw.options.slice(0, 40).map((option, optionIndex) => {
      if (!option || typeof option !== 'object') fail('fields[' + index + '].options[' + optionIndex + '] is invalid');
      const value = str((option as Record<string, unknown>).value, 'option value', 80);
      return { value, label: str((option as Record<string, unknown>).label, 'option label', 80) };
    });
  }
  return field;
}

export function validatePluginManifest(input: unknown): HcPluginManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('manifest must be an object');
  const raw = input as Record<string, unknown>;
  if (raw.schema !== undefined && raw.schema !== HC_PLUGIN_SCHEMA) fail('unsupported schema: ' + String(raw.schema));
  if (raw.apiVersion !== undefined && raw.apiVersion !== HC_PLUGIN_SCHEMA) fail('unsupported apiVersion: ' + String(raw.apiVersion));
  const id = str(raw.id, 'id', 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('id must be lowercase letters, numbers and dashes');
  if (!Array.isArray(raw.blocks) || !raw.blocks.length) fail('blocks must be a non-empty array');
  if (raw.blocks.length > 20) fail('too many blocks');
  const blocks = raw.blocks.map((block, index) => {
    if (!block || typeof block !== 'object') fail('blocks[' + index + '] must be an object');
    const item = block as Record<string, unknown>;
    const type = str(item.type, 'blocks[' + index + '].type', 64);
    if (!/^[a-z][a-z0-9-]*$/.test(type)) fail('blocks[' + index + '].type must be lowercase letters, numbers and dashes');
    const render = str(item.render, 'blocks[' + index + '].render', 20000);
    if (/<script\b/i.test(render) || /<iframe\b/i.test(render) || /\son[a-z]+\s*=/i.test(render) || /javascript\s*:/i.test(render)) {
      fail('blocks[' + index + '].render contains disallowed active content');
    }
    const defaultData = item.defaultData;
    if (defaultData !== undefined && (!defaultData || typeof defaultData !== 'object' || Array.isArray(defaultData))) fail('blocks[' + index + '].defaultData must be an object');
    const size = item.defaultSize as Record<string, unknown> | undefined;
    const defaultSize = size && typeof size === 'object' ? { w: optionalNumber(size.w, 'defaultSize.w') || 320, h: optionalNumber(size.h, 'defaultSize.h') || 200 } : undefined;
    return {
      type,
      label: str(item.label, 'blocks[' + index + '].label'),
      hint: item.hint === undefined ? undefined : str(item.hint, 'blocks[' + index + '].hint', 240),
      defaultSize,
      defaultData: defaultData ? defaultData as Record<string, unknown> : {},
      fields: Array.isArray(item.fields) ? item.fields.map(validateField) : [],
      render,
    } satisfies HcDeclarativeBlock;
  });
  return {
    schema: HC_PLUGIN_SCHEMA,
    id,
    name: raw.name === undefined ? id : str(raw.name, 'name', 120),
    version: raw.version === undefined ? '0.0.0' : str(raw.version, 'version', 40),
    apiVersion: HC_PLUGIN_SCHEMA,
    blocks,
  };
}

export function renderDeclarativeTemplate(template: string, data: Record<string, unknown>): string {
  const escape = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (_match, key: string) => escape(data[key]));
}
