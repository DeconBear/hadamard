export interface NotebookVariableDockOptions {
  panel: HTMLElement;
  body: HTMLElement;
  expand: HTMLButtonElement;
  popout: HTMLButtonElement;
  render(): void;
}

export function installNotebookVariableDock(options: NotebookVariableDockOptions) {
  let open = false;
  let floating = false;
  let position: { left: number; top: number } | null = null;
  let drag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  const bar = options.panel.querySelector<HTMLElement>('.nb-variable-bar')!;
  const applyPosition = (left: number, top: number): void => {
    const rect = options.panel.getBoundingClientRect();
    position = {
      left: Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - 42)),
    };
    options.panel.style.left = position.left + 'px';
    options.panel.style.top = position.top + 'px';
    options.panel.style.right = 'auto';
  };
  const sync = (): void => {
    options.body.classList.toggle('hidden', !open);
    options.panel.classList.toggle('collapsed', !open);
    options.panel.classList.toggle('floating', floating);
    options.expand.setAttribute('aria-expanded', String(open));
    options.popout.title = floating ? 'Dock variables' : 'Pop out variables';
    options.popout.setAttribute('aria-label', floating ? 'Dock variables' : 'Pop out variables');
    bar.title = floating ? 'Drag to move' : '';
    if (floating && position) applyPosition(position.left, position.top);
    if (!floating) {
      options.panel.style.left = '';
      options.panel.style.top = '';
      options.panel.style.right = '';
    }
    options.render();
  };
  options.expand.addEventListener('click', () => {
    open = !open;
    if (!open) floating = false;
    sync();
  });
  options.popout.addEventListener('click', () => {
    open = true;
    floating = !floating;
    sync();
  });
  bar.addEventListener('pointerdown', event => {
    if (!floating || event.button !== 0 || (event.target as Element | null)?.closest('button,input,select')) return;
    const rect = options.panel.getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    bar.setPointerCapture(event.pointerId);
    options.panel.classList.add('dragging');
    event.preventDefault();
  });
  bar.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  });
  const finish = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    options.panel.classList.remove('dragging');
    if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
  };
  bar.addEventListener('pointerup', finish);
  bar.addEventListener('pointercancel', finish);
  return {
    isOpen: () => open,
    open: () => { open = true; sync(); },
  };
}
