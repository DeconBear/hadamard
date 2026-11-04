import type { HcBlock, HcOp } from '../types.js';

export interface ImageCutoutOptions {
  block: HcBlock;
  pageId: string;
  applyOps(ops: HcOp[]): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sampleBackground(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const counts = new Map<string, { count: number; color: [number, number, number] }>();
  const add = (x: number, y: number): void => {
    const index = (y * width + x) * 4;
    if (data[index + 3]! < 16) return;
    const color: [number, number, number] = [data[index]!, data[index + 1]!, data[index + 2]!];
    const key = color.map(channel => Math.round(channel / 16) * 16).join(',');
    const entry = counts.get(key);
    if (entry) entry.count += 1; else counts.set(key, { count: 1, color });
  };
  const edge = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) * 0.02)));
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 80))) {
    for (let y = 0; y < edge; y += 1) { add(x, y); add(x, height - 1 - y); }
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 80))) {
    for (let x = 0; x < edge; x += 1) { add(x, y); add(width - 1 - x, y); }
  }
  let best: { count: number; color: [number, number, number] } | null = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best?.color || [255, 255, 255];
}

export function openImageCutout(options: ImageCutoutOptions): void {
  const block = options.block;
  const backdrop = document.createElement('div');
  backdrop.className = 'hc-cutout-backdrop';
  backdrop.innerHTML = '<div class="hc-cutout-modal"><div class="hc-cutout-head"><div><strong>Remove image background</strong><small>Simple background cutout · works best on solid backgrounds</small></div><button type="button" class="icon-btn" data-hc-cutout-close>×</button></div>' +
    '<div class="hc-cutout-stage"><canvas id="hcCutoutCanvas"></canvas><div class="hc-cutout-loading">Loading image…</div></div>' +
    '<div class="hc-cutout-controls"><div class="hc-cutout-field"><span>Background</span><span class="hc-cutout-bg"></span></div><label class="hc-cutout-field"><span>Tolerance</span><input type="range" id="hcCutoutTolerance" min="0" max="160" value="44"><output id="hcCutoutToleranceValue">44</output></label><label class="hc-cutout-check"><input type="checkbox" id="hcCutoutFeather" checked> Soft edges</label></div>' +
    '<div class="hc-cutout-foot"><button type="button" class="btn" data-hc-cutout-close>Cancel</button><button type="button" class="btn primary" id="hcCutoutApply">Apply cutout</button></div></div>';
  document.body.appendChild(backdrop);
  const canvas = backdrop.querySelector<HTMLCanvasElement>('#hcCutoutCanvas')!;
  const loading = backdrop.querySelector<HTMLElement>('.hc-cutout-loading')!;
  const bgSwatch = backdrop.querySelector<HTMLElement>('.hc-cutout-bg')!;
  const tolerance = backdrop.querySelector<HTMLInputElement>('#hcCutoutTolerance')!;
  const toleranceValue = backdrop.querySelector<HTMLOutputElement>('#hcCutoutToleranceValue')!;
  const feather = backdrop.querySelector<HTMLInputElement>('#hcCutoutFeather')!;
  const applyButton = backdrop.querySelector<HTMLButtonElement>('#hcCutoutApply')!;
  applyButton.disabled = true;
  let source: ImageData | null = null;
  let background: [number, number, number] = [255, 255, 255];
  let closed = false;
  const close = (): void => { if (closed) return; closed = true; backdrop.remove(); };
  backdrop.querySelectorAll<HTMLElement>('[data-hc-cutout-close]').forEach(button => button.addEventListener('click', close));
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  const reset = (): void => {
    if (!source) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    const threshold = Number(tolerance.value) || 0;
    const featherWidth = feather.checked ? 18 : 0;
    for (let index = 0; index < output.data.length; index += 4) {
      const color: [number, number, number] = [output.data[index]!, output.data[index + 1]!, output.data[index + 2]!];
      const delta = distance(color, background);
      if (delta <= threshold) output.data[index + 3] = 0;
      else if (featherWidth && delta < threshold + featherWidth) output.data[index + 3] = Math.round(output.data[index + 3]! * (delta - threshold) / featherWidth);
    }
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.putImageData(output, 0, 0);
  };
  const load = (): void => {
    const image = new Image();
    if (!block.src?.startsWith('data:')) image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (closed) return;
      const max = 1200;
      const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { options.toast('Canvas is not available.', 'error'); close(); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      try { source = ctx.getImageData(0, 0, canvas.width, canvas.height); }
      catch { options.toast('This image is cross-origin protected and cannot be cut out. Upload it locally first.', 'error'); close(); return; }
      background = sampleBackground(source.data, source.width, source.height);
      bgSwatch.style.background = 'rgb(' + background.join(',') + ')';
      loading.remove();
      applyButton.disabled = false;
      reset();
    };
    image.onerror = () => { options.toast('Could not load the image for cutout.', 'error'); close(); };
    image.src = block.src || '';
  };
  tolerance.addEventListener('input', () => { toleranceValue.value = tolerance.value; reset(); });
  feather.addEventListener('change', reset);
  applyButton.addEventListener('click', () => {
    if (!source) return;
    const dataUrl = canvas.toDataURL('image/png');
    void options.applyOps([{ op: 'update_block', pageId: options.pageId, blockId: block.id, patch: { src: dataUrl } }]).then(result => {
      if (result) options.toast('Image background removed', 'success');
      close();
    });
  });
  load();
}
