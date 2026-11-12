import type { HcBlock } from '../types.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function data(block: HcBlock): { label: string; value: number; min: number; max: number; accent: string; track: string; ink: string } {
  const value = block.data || {};
  const min = Number.isFinite(Number(value.min)) ? Number(value.min) : 0;
  const max = Number.isFinite(Number(value.max)) ? Number(value.max) : 100;
  const current = Math.max(min, Math.min(max, Number(value.value) || 0));
  return {
    label: String(value.label ?? 'Volume'),
    value: current,
    min,
    max: max > min ? max : min + 100,
    accent: String(value.accent || '#7c3aed'),
    track: String(value.track || '#e9e3f5'),
    ink: String(value.ink || '#1f2430'),
  };
}

export const sliderPlugin = {
  type: 'slider',
  label: 'Slider',
  hint: 'Style-linked range component',
  component: true,
  defaultSize: { w: 360, h: 120 },
  defaultData: () => ({ label: 'Volume', value: 64, min: 0, max: 100, accent: '#7c3aed', track: '#e9e3f5', ink: '#1f2430' }),
  fields: [
    { key: 'label', label: 'Label', kind: 'text' as const },
    { key: 'value', label: 'Value', kind: 'number' as const },
    { key: 'min', label: 'Min', kind: 'number' as const },
    { key: 'max', label: 'Max', kind: 'number' as const },
    { key: 'accent', label: 'Accent', kind: 'color' as const },
    { key: 'track', label: 'Track', kind: 'color' as const },
    { key: 'ink', label: 'Text', kind: 'color' as const },
  ],
  renderHtml(block: HcBlock): string {
    const value = data(block);
    const percent = Math.round((value.value - value.min) / (value.max - value.min || 1) * 100);
    return '<div style="box-sizing:border-box;height:100%;padding:22px 24px;display:flex;flex-direction:column;justify-content:center;gap:14px;background:#ffffff;border:1px solid #e7e0d2;border-radius:14px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:' + escapeHtml(value.ink) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:13px;font-weight:650">' + escapeHtml(value.label) + '</span><span data-hc-slider-value style="font:600 12px/1 var(--mono,ui-monospace)">' + value.value + '</span></div>' +
      '<div data-hc-slider-track data-min="' + value.min + '" data-max="' + value.max + '" data-value="' + value.value + '" data-accent="' + escapeHtml(value.accent) + '" data-track="' + escapeHtml(value.track) + '" style="--slider-accent:' + escapeHtml(value.accent) + ';--slider-track:' + escapeHtml(value.track) + ';position:relative;height:12px;border-radius:999px;background:linear-gradient(to right,' + escapeHtml(value.accent) + ' 0%,' + escapeHtml(value.accent) + ' ' + percent + '%,' + escapeHtml(value.track) + ' ' + percent + '%,' + escapeHtml(value.track) + ' 100%)"><span data-hc-slider-knob style="position:absolute;left:' + percent + '%;top:50%;width:22px;height:22px;border-radius:50%;background:#fff;border:2px solid ' + escapeHtml(value.accent) + ';box-shadow:0 2px 6px rgba(29,35,46,.2);transform:translate(-50%,-50%)"></span><input type="range" data-hc-slider-input min="' + value.min + '" max="' + value.max + '" step="1" value="' + value.value + '" aria-label="' + escapeHtml(value.label) + ' slider" style="position:absolute;left:0;right:0;top:-8px;width:100%;height:28px;margin:0;opacity:0;cursor:pointer;z-index:5;pointer-events:none"></div>' +
      '<div style="display:flex;justify-content:space-between;font:10px/1 var(--mono,ui-monospace);opacity:.55"><span>' + value.min + '</span><span>' + value.max + '</span></div></div>';
  },
};