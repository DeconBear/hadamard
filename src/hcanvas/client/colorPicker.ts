import { getLanguage, translatePhrase } from './i18n.js';

interface Rgb { r: number; g: number; b: number; }
interface Hsv { h: number; s: number; v: number; }


function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function normalizeHex(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) return ('#' + raw.slice(1).split('').map(ch => ch + ch).join('')).toLowerCase();
  return '#000000';
}

function hexToRgb(hex: string): Rgb {
  const value = normalizeHex(hex).slice(1);
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

function rgbToHex(rgb: Rgb): string {
  const part = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
}

function rgbToHsv(rgb: Rgb): Hsv {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

function hsvToRgb(hsv: Hsv): Rgb {
  const c = hsv.v * hsv.s;
  const x = c * (1 - Math.abs((hsv.h / 60) % 2 - 1));
  const m = hsv.v - c;
  let r = 0, g = 0, b = 0;
  if (hsv.h < 60) { r = c; g = x; }
  else if (hsv.h < 120) { r = x; g = c; }
  else if (hsv.h < 180) { g = c; b = x; }
  else if (hsv.h < 240) { g = x; b = c; }
  else if (hsv.h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function hueName(hue: number): { zh: string; en: string } {
  if (hue < 15 || hue >= 345) return { zh: '红色', en: 'Red' };
  if (hue < 45) return { zh: '橙色', en: 'Orange' };
  if (hue < 70) return { zh: '黄色', en: 'Yellow' };
  if (hue < 160) return { zh: '绿色', en: 'Green' };
  if (hue < 195) return { zh: '青色', en: 'Cyan' };
  if (hue < 255) return { zh: '蓝色', en: 'Blue' };
  if (hue < 290) return { zh: '紫色', en: 'Purple' };
  return { zh: '粉色', en: 'Pink' };
}

function colorName(hex: string): string {
  const hsv = rgbToHsv(hexToRgb(hex));
  const zh = getLanguage() === 'zh';
  if (hsv.s < 0.04 && hsv.v > 0.98) return zh ? '白色' : 'White';
  if (hsv.v < 0.12) return zh ? '黑色' : 'Black';
  if (hsv.s < 0.06) return zh ? '灰色' : 'Gray';
  if (hsv.s < 0.12 && hsv.v > 0.55) return zh ? '浅灰色' : 'Light gray';
  const hue = hueName(hsv.h);
  if (hsv.v > 0.92 && hsv.s < 0.55) return zh ? '浅' + hue.zh : 'Light ' + hue.en.toLowerCase();
  if (hsv.v < 0.32) return zh ? '深' + hue.zh : 'Dark ' + hue.en.toLowerCase();
  return zh ? hue.zh : hue.en;
}

function rgbText(rgb: Rgb): string { return 'RGB(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ')'; }

let activePicker: { close(commit?: boolean): void } | null = null;

function openPicker(input: HTMLInputElement, trigger: HTMLButtonElement): void {
  activePicker?.close(false);
  const initial = normalizeHex(input.value);
  let hsv = rgbToHsv(hexToRgb(initial));
  let dirty = false;
  let closed = false;

  const node = document.createElement('div');
  node.className = 'hc-color-picker-popover';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', translatePhrase('Color picker'));
  node.innerHTML = '<div class="hc-color-picker-head"><span class="hc-color-picker-chip" style="background:' + initial + '"></span><input class="hc-color-picker-hex" value="' + initial + '" maxlength="7" spellcheck="false" aria-label="' + translatePhrase('Hex color') + '"><button type="button" class="hc-color-eyedrop" title="' + translatePhrase('Pick color from screen') + '" aria-label="' + translatePhrase('Pick color from screen') + '">' +
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m12.5 3.5 4 4M10.8 5.2l4 4M4 16l.7-3.4L13 4.3a1.4 1.4 0 0 1 2 0l.7.7a1.4 1.4 0 0 1 0 2l-8.3 8.3L4 16Z"/><path d="m5.2 12.5 2.3 2.3"/></svg></button></div>' +
    '<div class="hc-color-picker-area"><i class="hc-color-picker-cursor"></i></div>' +
    '<input class="hc-color-picker-hue" type="range" min="0" max="360" step="1" aria-label="' + translatePhrase('Hue') + '">' +
    '<div class="hc-color-picker-meta"><span class="hc-color-picker-rgb"></span><strong class="hc-color-picker-name"></strong></div>';
  document.body.appendChild(node);

  const chip = node.querySelector<HTMLElement>('.hc-color-picker-chip')!;
  const area = node.querySelector<HTMLElement>('.hc-color-picker-area')!;
  const cursor = node.querySelector<HTMLElement>('.hc-color-picker-cursor')!;
  const hue = node.querySelector<HTMLInputElement>('.hc-color-picker-hue')!;
  const hexInput = node.querySelector<HTMLInputElement>('.hc-color-picker-hex')!;
  const rgbLabel = node.querySelector<HTMLElement>('.hc-color-picker-rgb')!;
  const nameLabel = node.querySelector<HTMLElement>('.hc-color-picker-name')!;
  const row = input.closest('.swatch-row, .field');
  const textSibling = row?.querySelector<HTMLInputElement>('input[type="text"]');

  const paint = (emit: boolean): void => {
    const hex = rgbToHex(hsvToRgb(hsv));
    const rgb = hexToRgb(hex);
    area.style.setProperty('--hc-hue', String(hsv.h));
    cursor.style.left = hsv.s * 100 + '%';
    cursor.style.top = (1 - hsv.v) * 100 + '%';
    chip.style.background = hex;
    hexInput.value = hex;
    rgbLabel.textContent = rgbText(rgb);
    nameLabel.textContent = colorName(hex);
    trigger.style.background = hex;
    trigger.title = hex;
    if (textSibling && textSibling.value !== hex) textSibling.value = hex;
    if (!emit) return;
    dirty = true;
    input.value = hex;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const setFromHex = (value: string, emit: boolean): void => {
    const hex = normalizeHex(value);
    hsv = rgbToHsv(hexToRgb(hex));
    paint(emit);
  };

  const updateFromPointer = (event: PointerEvent): void => {
    const rect = area.getBoundingClientRect();
    hsv.s = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    hsv.v = 1 - clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    paint(true);
  };

  area.addEventListener('pointerdown', event => {
    event.preventDefault();
    area.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  area.addEventListener('pointermove', event => {
    if (!area.hasPointerCapture(event.pointerId)) return;
    updateFromPointer(event);
  });
  area.addEventListener('pointerup', event => { if (area.hasPointerCapture(event.pointerId)) area.releasePointerCapture(event.pointerId); });
  hue.addEventListener('input', () => { hsv.h = Number(hue.value) || 0; paint(true); });
  hexInput.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/i.test(hexInput.value)) setFromHex(hexInput.value, true);
  });
  hexInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); setFromHex(hexInput.value, true); close(true); }
  });
  const eyedropButton = node.querySelector<HTMLButtonElement>('.hc-color-eyedrop');
  const hasEyeDropper = Boolean((window as unknown as { EyeDropper?: unknown }).EyeDropper);
  if (eyedropButton && !hasEyeDropper) eyedropButton.style.display = 'none';
  eyedropButton?.addEventListener('click', () => {
    const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropperCtor) { input.dispatchEvent(new Event('change', { bubbles: true })); close(true); return; }
    const dropper = new EyeDropperCtor();
    void dropper.open().then(result => { setFromHex(result.sRGBHex, true); close(true); }).catch(() => undefined);
  });

  const close = (commit = true): void => {
    if (closed) return;
    closed = true;
    if (commit && dirty) input.dispatchEvent(new Event('change', { bubbles: true }));
    node.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', close, true);
    window.removeEventListener('scroll', close, true);
    activePicker = null;
  };
  const outside = (event: PointerEvent): void => { if (!node.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(true); };
  const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('resize', close, true);
  window.addEventListener('scroll', close, true);

  paint(false);
  const rect = trigger.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - nodeRect.width - 10));
  const top = rect.bottom + 8 + nodeRect.height > window.innerHeight - 8 ? Math.max(8, rect.top - nodeRect.height - 8) : rect.bottom + 8;
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  activePicker = { close };
}

function enhanceInput(input: HTMLInputElement): void {
  if (input.dataset.hcColorPicker === '1' || input.closest('.hc-color-popover')) return;
  input.dataset.hcColorPicker = '1';
  input.classList.add('hc-native-color');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'hc-color-trigger';
  trigger.setAttribute('aria-label', translatePhrase('Choose color'));
  trigger.title = translatePhrase('Choose color');
  const sync = (): void => {
    const color = normalizeHex(input.value);
    trigger.style.background = color;
    trigger.title = color;
  };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  trigger.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openPicker(input, trigger);
  });
  input.after(trigger);
  sync();
}

let installed = false;

/** Enhance every native color input with an inline picker that emits live input events. */
export function installColorPickers(): void {
  if (installed) return;
  installed = true;
  const scan = (root: ParentNode): void => {
    root.querySelectorAll<HTMLInputElement>('input[type="color"]').forEach(enhanceInput);
  };
  scan(document.body);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches('input[type="color"]')) enhanceInput(node as HTMLInputElement);
        else scan(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
