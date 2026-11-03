import type { HcBlock } from '../types.js';

const TONES: Record<string, { bg: string; border: string; accent: string; ink: string }> = {
  violet: { bg: '#f7f4ff', border: '#e4dcff', accent: '#7c3aed', ink: '#312e45' },
  amber: { bg: '#fff9eb', border: '#f5e3b8', accent: '#b7791f', ink: '#453a27' },
  green: { bg: '#f1fbf4', border: '#ccebd5', accent: '#178a4b', ink: '#243a2c' },
  blue: { bg: '#f2f8ff', border: '#d4e7fb', accent: '#2563eb', ink: '#253347' },
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function data(block: HcBlock): { title: string; body: string; tone: string } {
  const value = block.data || {};
  return {
    title: String(value.title ?? 'Key insight'),
    body: String(value.body ?? 'A small callout for notes, decisions or warnings.'),
    tone: TONES[String(value.tone)] ? String(value.tone) : 'violet',
  };
}

export const calloutPlugin = {
  type: 'callout',
  label: 'Callout',
  hint: 'A highlighted note or decision',
  defaultSize: { w: 360, h: 170 },
  defaultData: () => ({ title: 'Key insight', body: 'A small callout for notes, decisions or warnings.', tone: 'violet' }),
  fields: [
    { key: 'title', label: 'Title', kind: 'text' as const },
    { key: 'body', label: 'Body', kind: 'textarea' as const },
    { key: 'tone', label: 'Tone', kind: 'select' as const, options: [
      { value: 'violet', label: 'Violet' },
      { value: 'amber', label: 'Amber' },
      { value: 'green', label: 'Green' },
      { value: 'blue', label: 'Blue' },
    ] },
  ],
  renderHtml(block: HcBlock): string {
    const value = data(block);
    const tone = TONES[value.tone] || TONES.violet!;
    return '<div style="box-sizing:border-box;height:100%;padding:18px 20px;border:1px solid ' + tone.border + ';border-left:4px solid ' + tone.accent + ';border-radius:14px;background:' + tone.bg + ';color:' + tone.ink + ';font-family:Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden">' +
      '<div style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.25">' + escapeHtml(value.title) + '</div>' +
      '<div style="white-space:pre-wrap;font-size:13px;line-height:1.55;opacity:.86">' + escapeHtml(value.body) + '</div>' +
      '</div>';
  },
};
