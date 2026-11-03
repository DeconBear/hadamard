import type { HcShape } from '../types.js';
import { HCANVAS_SHAPES, shapeSvgMarkup } from '../shapes.js';

export interface ShapePickerOptions {
  onChoose(shape: HcShape): void;
}

export interface ShapePicker {
  open(): void;
  hide(): void;
}

export function createShapePicker(options: ShapePickerOptions): ShapePicker {
  let popover: HTMLDivElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const anchor = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-block="shape"]');

  const ensure = (): HTMLDivElement => {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'shape-popover hidden';
    popover.innerHTML = '<div class="shape-popover-head"><strong>Shapes</strong><small>Click a shape, then place it on the canvas</small></div><div class="shape-popover-grid">' +
      HCANVAS_SHAPES.map(shape => {
        const preview = shapeSvgMarkup({ shape: shape.id, style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 10 } });
        return '<button type="button" class="shape-choice" data-shape-choice="' + shape.id + '" title="' + shape.hint.replace(/"/g, '&quot;') + '"><span class="shape-choice-preview">' + preview + '</span><span>' + shape.label + '</span></button>';
      }).join('') + '</div>';
    popover.addEventListener('pointerenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; } });
    popover.addEventListener('pointerleave', scheduleHide);
    popover.querySelectorAll<HTMLButtonElement>('[data-shape-choice]').forEach(button => {
      button.addEventListener('click', () => {
        const shape = button.dataset.shapeChoice as HcShape | undefined;
        if (!shape) return;
        hide();
        options.onChoose(shape);
      });
    });
    document.body.appendChild(popover);
    return popover;
  };

  const hide = (): void => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
    popover?.classList.add('hidden');
  };

  const scheduleHide = (): void => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = undefined; hide(); }, 220);
  };

  const open = (): void => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
    const node = ensure();
    node.classList.remove('hidden');
    const button = anchor();
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(360, Math.max(280, window.innerWidth - 24));
    node.style.width = width + 'px';
    const height = node.offsetHeight || 260;
    let left = rect.right + 10;
    if (left + width > window.innerWidth - 10) left = Math.max(10, rect.left - width - 10);
    const top = Math.max(10, Math.min(rect.top, window.innerHeight - height - 10));
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  };

  const button = anchor();
  button?.addEventListener('pointerenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; } open(); });
  button?.addEventListener('pointerleave', scheduleHide);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !popover || popover.classList.contains('hidden')) return;
    hide();
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!popover || popover.classList.contains('hidden')) return;
    const target = event.target as Node;
    if (popover.contains(target) || target === button) return;
    hide();
  }, true);

  return { open, hide };
}
