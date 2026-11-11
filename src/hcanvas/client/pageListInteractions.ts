export interface PageListInteractionOptions {
  root: HTMLElement;
  onReorder(pageId: string, toIndex: number): void;
  onDuplicate(pageId: string): void;
  onDelete(pageId: string): void;
  canDelete(): boolean;
  canEditSource?(pageId: string): boolean;
  onEditSource?(pageId: string): void;
}

/** Page cards: right-click actions and direct pointer dragging. */
export function installPageListInteractions(options: PageListInteractionOptions): void {
  const root = options.root;
  let menu: HTMLElement | null = null;
  let suppressClickUntil = 0;

  const pageItemAt = (target: Element | null): HTMLElement | null =>
    (target?.closest('.page-item[data-page-id]') as HTMLElement | null) || null;
  const pageIdOf = (item: HTMLElement): string => item.dataset.pageId || '';

  function closeMenu(): void {
    menu?.remove();
    menu = null;
  }

  function openMenu(event: MouseEvent, pageId: string): void {
    closeMenu();
    const node = document.createElement('div');
    node.className = 'page-context-menu';
    node.setAttribute('role', 'menu');
    node.innerHTML = (options.canEditSource?.(pageId) ? '<button type="button" data-page-menu="source" role="menuitem">Edit Markdown source</button>' : '') +
      '<button type="button" data-page-menu="duplicate" role="menuitem">Duplicate page</button>' +
      '<button type="button" data-page-menu="delete" role="menuitem"' + (options.canDelete() ? '' : ' disabled') + '>Delete page</button>';
    document.body.appendChild(node);
    const rect = node.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - rect.width - 10);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - 10);
    node.style.left = Math.max(8, left) + 'px';
    node.style.top = Math.max(8, top) + 'px';
    menu = node;
    node.querySelector('[data-page-menu="source"]')?.addEventListener('click', () => {
      closeMenu();
      options.onEditSource?.(pageId);
    });
    node.querySelector('[data-page-menu="duplicate"]')?.addEventListener('click', () => {
      closeMenu();
      options.onDuplicate(pageId);
    });
    node.querySelector('[data-page-menu="delete"]')?.addEventListener('click', () => {
      if (!options.canDelete()) return;
      closeMenu();
      options.onDelete(pageId);
    });
  }

  root.addEventListener('contextmenu', event => {
    const item = pageItemAt(event.target as Element);
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(event, pageIdOf(item));
  });

  document.addEventListener('pointerdown', event => {
    if (menu && !menu.contains(event.target as Node)) closeMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
  root.addEventListener('scroll', closeMenu, { passive: true });
  const observer = new MutationObserver(() => closeMenu());
  observer.observe(root, { childList: true, subtree: true });

  root.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const item = pageItemAt(event.target as Element);
    if (!item) return;
    const pageId = pageIdOf(item);
    if (!pageId) return;
    event.preventDefault();
    closeMenu();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let lastTarget: HTMLElement | null = null;
    let lastPosition: 'before' | 'after' = 'before';
    let lastY = startY;
    let autoScrollDir = 0;
    let autoScrollFrame = 0;

    const clearHints = (): void => {
      root.querySelectorAll('.page-drop-before, .page-drop-after').forEach(node => node.classList.remove('page-drop-before', 'page-drop-after'));
    };

    const updateTarget = (clientY: number): void => {
      const candidate = pageItemAt(document.elementFromPoint(startX, clientY));
      lastTarget = candidate && candidate !== item ? candidate : null;
      if (!lastTarget) return;
      const rect = lastTarget.getBoundingClientRect();
      lastPosition = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      lastTarget.classList.toggle('page-drop-before', lastPosition === 'before');
      lastTarget.classList.toggle('page-drop-after', lastPosition === 'after');
    };

    const autoScroll = (): void => {
      if (!autoScrollDir) { autoScrollFrame = 0; return; }
      root.scrollTop += autoScrollDir * 9;
      autoScrollFrame = requestAnimationFrame(autoScroll);
    };

    const move = (moveEvent: PointerEvent): void => {
      lastY = moveEvent.clientY;
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
      if (!active) {
        active = true;
        item.classList.add('dragging');
        document.body.classList.add('page-list-reordering');
      }
      moveEvent.preventDefault();
      clearHints();
      updateTarget(lastY);
      const rootRect = root.getBoundingClientRect();
      autoScrollDir = lastY < rootRect.top + 28 ? -1 : lastY > rootRect.bottom - 28 ? 1 : 0;
      if (autoScrollDir && !autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScroll);
    };

    const finish = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = 0;
      if (active && lastTarget) {
        const items = Array.from(root.querySelectorAll<HTMLElement>('.page-item[data-page-id]'));
        const from = items.indexOf(item);
        const targetIndex = items.indexOf(lastTarget);
        if (from >= 0 && targetIndex >= 0) {
          const insertion = targetIndex + (lastPosition === 'after' ? 1 : 0);
          const toIndex = Math.max(0, Math.min(items.length - 1, from < insertion ? insertion - 1 : insertion));
          if (toIndex !== from) options.onReorder(pageId, toIndex);
        }
        suppressClickUntil = performance.now() + 260;
      }
      clearHints();
      item.classList.remove('dragging');
      document.body.classList.remove('page-list-reordering');
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  root.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}
