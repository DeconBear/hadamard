export interface PresentInteractionOptions {
  root: HTMLElement;
  isActive(): boolean;
  isDocument(): boolean;
  next(delta: number): void;
  close(): void;
  toggleNotes(): void;
  canPrev(): boolean;
  canNext(): boolean;
}

export interface PresentInteractions {
  reset(): void;
  closeMenu(): boolean;
  toggleLaser(): void;
}

export function installPresentInteractions(options: PresentInteractionOptions): PresentInteractions {
  let menu: HTMLDivElement | null = null;
  let laserNode: HTMLDivElement | null = null;
  let laserActive = false;
  let lastX = 0;
  let lastY = 0;
  let wheelAt = 0;

  const hideMenu = (): void => { menu?.remove(); menu = null; };

  const ensureLaser = (): HTMLDivElement => {
    if (laserNode) return laserNode;
    laserNode = document.createElement('div');
    laserNode.className = 'present-laser hidden';
    document.body.appendChild(laserNode);
    return laserNode;
  };

  const updateLaser = (x: number, y: number): void => {
    lastX = x;
    lastY = y;
    if (!laserActive) return;
    const node = ensureLaser();
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    node.classList.remove('hidden');
  };

  const setLaser = (active: boolean): void => {
    laserActive = active;
    options.root.classList.toggle('laser-active', active);
    const node = ensureLaser();
    node.classList.toggle('hidden', !active);
    if (active) updateLaser(lastX, lastY);
  };

  const showMenu = (x: number, y: number): void => {
    hideMenu();
    menu = document.createElement('div');
    menu.className = 'present-context-menu';
    menu.innerHTML = '<button type="button" data-present-action="prev"' + (options.canPrev() ? '' : ' disabled') + '>← Previous page</button>' +
      '<button type="button" data-present-action="next"' + (options.canNext() ? '' : ' disabled') + '>Next page →</button>' +
      '<div class="present-menu-sep"></div>' +
      '<button type="button" data-present-action="laser" class="' + (laserActive ? 'checked' : '') + '">● Laser pointer</button>' +
      '<button type="button" data-present-action="notes">Speaker notes</button>' +
      '<button type="button" data-present-action="exit">Exit presentation</button>';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    menu.querySelectorAll<HTMLButtonElement>('[data-present-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.presentAction;
        hideMenu();
        if (action === 'prev') options.next(-1);
        else if (action === 'next') options.next(1);
        else if (action === 'laser') setLaser(!laserActive);
        else if (action === 'notes') options.toggleNotes();
        else if (action === 'exit') options.close();
      });
    });
  };

  const reset = (): void => {
    hideMenu();
    setLaser(false);
    lastX = window.innerWidth / 2;
    lastY = window.innerHeight / 2;
    wheelAt = 0;
  };

  options.root.addEventListener('click', event => {
    if (!options.isActive() || options.isDocument()) return;
    const target = event.target as Element;
    if (target.closest('.present-bar, .present-notes, .present-context-menu, button, a, input, select, textarea')) return;
    options.next(1);
  });
  options.root.addEventListener('contextmenu', event => {
    if (!options.isActive()) return;
    event.preventDefault();
    event.stopPropagation();
    showMenu(event.clientX, event.clientY);
  });
  options.root.addEventListener('wheel', event => {
    if (!options.isActive() || options.isDocument()) return;
    const target = event.target as Element;
    if (target.closest('.present-notes')) return;
    event.preventDefault();
    hideMenu();
    const now = Date.now();
    if (now - wheelAt < 380) return;
    wheelAt = now;
    options.next(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  options.root.addEventListener('pointermove', event => {
    if (!options.isActive()) return;
    updateLaser(event.clientX, event.clientY);
  });
  options.root.addEventListener('pointerleave', () => {
    if (laserActive) ensureLaser().classList.add('hidden');
  });
  document.addEventListener('pointerdown', event => {
    if (menu && !menu.contains(event.target as Node)) hideMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (!options.isActive()) return;
    if (event.key === 'Escape' && menu) {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
    } else if (event.key.toLowerCase() === 'l') {
      setLaser(!laserActive);
    }
  }, true);

  return { reset, closeMenu: () => { const open = Boolean(menu); hideMenu(); return open; }, toggleLaser: () => setLaser(!laserActive) };
}
