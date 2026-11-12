export interface ListMenuAction {
  label: string;
  action(): void;
  danger?: boolean;
  disabled?: boolean;
}

let activeMenu: HTMLElement | null = null;

function closeMenu(): void {
  activeMenu?.remove();
  activeMenu = null;
}

export function showListContextMenu(event: MouseEvent, actions: ListMenuAction[]): void {
  closeMenu();
  if (!actions.length) return;
  const menu = document.createElement('div');
  menu.className = 'page-context-menu list-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = actions.map((action, index) => '<button type="button" role="menuitem" data-menu-index="' + index + '"' + (action.disabled ? ' disabled' : '') + (action.danger ? ' class="danger"' : '') + '>' + action.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</button>').join('');
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 10)) + 'px';
  menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 10)) + 'px';
  activeMenu = menu;
  const close = (): void => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('scroll', close, true);
    closeMenu();
  };
  const outside = (down: PointerEvent): void => { if (!menu.contains(down.target as Node)) close(); };
  const escape = (key: KeyboardEvent): void => { if (key.key === 'Escape') close(); };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('scroll', close, true);
  menu.querySelectorAll<HTMLButtonElement>('[data-menu-index]').forEach(button => {
    button.addEventListener('click', () => {
      const action = actions[Number(button.dataset.menuIndex)];
      if (!action || action.disabled) return;
      close();
      action.action();
    });
  });
}
