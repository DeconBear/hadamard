export function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function genId(prefix: string): string {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
