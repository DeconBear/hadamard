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
  const sync = (): void => {
    options.body.classList.toggle('hidden', !open);
    options.panel.classList.toggle('collapsed', !open);
    options.panel.classList.toggle('floating', floating);
    options.expand.setAttribute('aria-expanded', String(open));
    options.popout.title = floating ? 'Dock variables' : 'Pop out variables';
    options.popout.setAttribute('aria-label', floating ? 'Dock variables' : 'Pop out variables');
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
  return {
    isOpen: () => open,
    open: () => { open = true; sync(); },
  };
}
