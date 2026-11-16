import { commandRegistry } from './commandRegistry.js';
import { getExtensionCatalog } from './extensionCatalog.js';
import { esc } from './utils.js';

export interface CommandPaletteDeps {
  openModal(html: string): void;
  closeModal(): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  openExtensionView(viewId: string): boolean;
}

interface PaletteItem {
  id: string;
  title: string;
  category?: string;
  source: 'builtin' | 'extension';
  run(): void | Promise<void>;
}

let paletteOpen = false;

function collectItems(deps: CommandPaletteDeps): PaletteItem[] {
  const items: PaletteItem[] = commandRegistry.list().map(command => ({
    id: command.id,
    title: command.title,
    category: command.category,
    source: 'builtin',
    run: async () => { await commandRegistry.execute(command.id); },
  }));
  const seen = new Set(items.map(item => item.id));
  for (const extension of getExtensionCatalog().extensions) {
    if (!extension.enabled) continue;
    for (const command of extension.contributes.commands) {
      if (!command.id || seen.has(command.id)) continue;
      seen.add(command.id);
      const exec = command.exec && typeof command.exec === 'object' ? command.exec as Record<string, unknown> : undefined;
      items.push({
        id: command.id,
        title: command.title,
        category: command.category || extension.name,
        source: 'extension',
        run: () => {
          const kind = exec && typeof exec.kind === 'string' ? exec.kind : '';
          if (kind === 'view') {
            const viewId = typeof exec.viewId === 'string' ? exec.viewId : '';
            if (!deps.openExtensionView(viewId)) deps.toast('View is not available: ' + viewId, 'error');
            return;
          }
          if (kind === 'builtin') {
            const builtinId = typeof exec.builtinId === 'string' ? exec.builtinId : '';
            void commandRegistry.execute(builtinId);
            return;
          }
          if (kind === 'openExternal') {
            const target = typeof exec.url === 'string' ? exec.url : '';
            if (/^https?:\/\//iu.test(target)) window.open(target, '_blank', 'noopener');
            else deps.toast('Invalid external URL.', 'error');
            return;
          }
          if (kind === 'sidecar' || kind === 'tool') {
            deps.toast('This command needs the sidecar runtime (P3).', 'info');
            return;
          }
          if (commandRegistry.has(command.id)) { void commandRegistry.execute(command.id); return; }
          deps.toast('Command is not available yet: ' + command.id, 'info');
        },
      });
    }
  }
  return items;
}

function renderList(items: PaletteItem[], active: number): string {
  if (!items.length) return '<p class="palette-empty">No matching commands.</p>';
  return items.map((item, index) => '<button type="button" class="palette-item' + (index === active ? ' active' : '') + '" data-palette-id="' + esc(item.id) + '">' +
    '<span class="palette-title">' + esc(item.title) + '</span>' +
    '<span class="palette-meta">' + esc(item.category || (item.source === 'extension' ? 'Extension' : 'Command')) + '</span>' +
    '</button>').join('');
}

export function installCommandPalette(deps: CommandPaletteDeps): void {
  let items: PaletteItem[] = [];
  let filtered: PaletteItem[] = [];
  let active = 0;

  const execute = (item: PaletteItem | undefined): void => {
    if (!item) return;
    close();
    try { void Promise.resolve(item.run()).catch(error => deps.toast(error instanceof Error ? error.message : String(error), 'error')); }
    catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  const close = (): void => {
    if (!paletteOpen) return;
    paletteOpen = false;
    deps.closeModal();
  };

  const paint = (): void => {
    const list = document.getElementById('paletteResults');
    if (list) list.innerHTML = renderList(filtered, active);
    document.querySelectorAll<HTMLElement>('[data-palette-id]').forEach(button => {
      button.addEventListener('click', () => execute(filtered.find(item => item.id === button.dataset.paletteId)));
    });
  };

  const update = (query: string): void => {
    const value = query.trim().toLowerCase();
    filtered = value
      ? items.filter(item => item.id.toLowerCase().includes(value) || item.title.toLowerCase().includes(value) || (item.category || '').toLowerCase().includes(value))
      : items;
    active = 0;
    paint();
  };

  const open = (): void => {
    if (paletteOpen) return;
    paletteOpen = true;
    items = collectItems(deps);
    filtered = items;
    active = 0;
    deps.openModal('<div class="modal command-palette"><div class="palette-search"><input id="paletteInput" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div><div id="paletteResults" class="palette-results"></div></div>');
    paint();
    const input = document.getElementById('paletteInput') as HTMLInputElement | null;
    if (!input) return;
    input.focus();
    input.addEventListener('input', () => update(input.value));
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(filtered.length - 1, active + 1); paint(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (event.key === 'Enter') { event.preventDefault(); execute(filtered[active]); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    document.addEventListener('click', event => {
      if (!paletteOpen) return;
      const target = event.target as Element;
      if (!target.closest('.command-palette')) close();
    }, { once: true });
  };

  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'p') return;
    event.preventDefault();
    open();
  });
}
