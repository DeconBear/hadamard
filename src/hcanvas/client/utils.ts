export function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function genId(prefix: string): string {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function toHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) return '#' + [match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, '0')).join('');
  return '#1d232e';
}
