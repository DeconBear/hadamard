import { HTML_INSERT_PRESETS, type HtmlEditingContext } from './htmlEditing.js';

export interface HtmlInsertFlyout {
  open(): void;
  hide(): void;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createHtmlInsertFlyout(button: HTMLElement, context: HtmlEditingContext, onChoose: (presetId: string) => void): HtmlInsertFlyout {
  let popover: HTMLDivElement | null = null;
  const ensure = (): HTMLDivElement => {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'html-insert-popover hidden';
    popover.innerHTML = '<div class="html-insert-popover-head"><strong>Insert element</strong><small>Adds after the selected element, or at the end of the page.</small></div><div class="html-insert-tile-grid">' +
      HTML_INSERT_PRESETS.map(preset => '<button type="button" class="html-insert-tile" data-insert-preset="' + preset.id + '" title="' + escapeHtml(preset.hint) + '"><span class="html-insert-tile-icon">+</span><span class="html-insert-tile-copy"><strong>' + escapeHtml(preset.label) + '</strong><small>' + escapeHtml(preset.hint) + '</small></span></button>').join('') + '</div>';
    popover.querySelectorAll<HTMLButtonElement>('[data-insert-preset]').forEach(node => {
      node.addEventListener('click', () => {
        const id = node.dataset.insertPreset;
        hide();
        if (id) onChoose(id);
      });
    });
    document.body.appendChild(popover);
    return popover;
  };
  const hide = (): void => { popover?.classList.add('hidden'); };
  const open = (): void => {
    if (!context.getEditing()) return;
    const node = ensure();
    node.classList.remove('hidden');
    const rect = button.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    node.style.width = width + 'px';
    const height = node.offsetHeight || 300;
    node.style.left = Math.max(10, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 10)) + 'px';
    node.style.top = Math.max(10, Math.min(rect.bottom + 8, window.innerHeight - height - 10)) + 'px';
  };
  button.addEventListener('click', event => { event.stopPropagation(); if (popover && !popover.classList.contains('hidden')) hide(); else open(); });
  document.addEventListener('pointerdown', event => {
    if (!popover || popover.classList.contains('hidden')) return;
    if (popover.contains(event.target as Node) || button.contains(event.target as Node)) return;
    hide();
  }, true);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !popover || popover.classList.contains('hidden')) return;
    hide();
    event.preventDefault();
    event.stopPropagation();
  }, true);
  return { open, hide };
}