const STORAGE_KEY = 'hcanvas.markdownHelp.hidden.v1';
let dismissed = false;
let activeCleanup: (() => void) | null = null;

function neverShowAgain(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
}

export function installMarkdownHelp(mount: HTMLElement, pageName: string): void {
  activeCleanup?.();
  activeCleanup = null;
  mount.querySelectorAll('.markdown-help').forEach(node => node.remove());
  const root = document.createElement('div');
  root.className = 'markdown-help';
  root.innerHTML = '<button type="button" class="markdown-help-trigger" title="Markdown editing help" aria-label="Markdown editing help" aria-expanded="false">?</button><div class="markdown-help-popover hidden" role="dialog" aria-label="Markdown editing help"><small>MARKDOWN PAGE</small><strong></strong><p>Click text to edit directly.<br>Right-click to open Markdown source.</p><div class="markdown-help-actions"><button type="button" class="btn tiny" data-help-dismiss>Dismiss</button><button type="button" class="btn tiny" data-help-never>Don’t show again</button></div></div>';
  const trigger = root.querySelector<HTMLButtonElement>('.markdown-help-trigger')!;
  const popover = root.querySelector<HTMLElement>('.markdown-help-popover')!;
  const title = root.querySelector<HTMLElement>('.markdown-help-popover strong')!;
  title.textContent = pageName;
  let outside: ((event: PointerEvent) => void) | null = null;
  const unbindOutside = (): void => {
    if (outside) document.removeEventListener('pointerdown', outside, true);
    outside = null;
  };
  const show = (): void => {
    popover.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    if (!outside) {
      outside = event => { if (!root.contains(event.target as Node)) hide(); };
      document.addEventListener('pointerdown', outside, true);
    }
  };
  const hide = (): void => {
    dismissed = true;
    popover.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    unbindOutside();
  };
  trigger.addEventListener('click', () => {
    if (popover.classList.contains('hidden')) show();
    else hide();
  });
  root.querySelector('[data-help-dismiss]')?.addEventListener('click', hide);
  root.querySelector('[data-help-never]')?.addEventListener('click', () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* preference storage is optional */ }
    hide();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); hide(); trigger.focus(); }
  });
  activeCleanup = () => { unbindOutside(); root.remove(); };
  mount.appendChild(root);
  if (!dismissed && !neverShowAgain()) show();
}
