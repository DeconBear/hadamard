import { esc } from './utils.js';
import { translatePhrase } from './i18n.js';

export interface ModalHostDeps {
  /** True while the source/autosave modal owns close semantics. */
  isSourceModalOpen(): boolean;
}

export interface ModalHostController {
  openModal(html: string): void;
  closeModal(): void;
  confirmDialog(message: string): Promise<boolean>;
}

/** Generic app modal host (extracted from main.ts). */
export function createModalHost(deps: ModalHostDeps): ModalHostController {
  function closeModal(): void {
    if (deps.isSourceModalOpen()) {
      const custom = (window as unknown as { __hcCloseModal?: () => void }).__hcCloseModal;
      if (custom) { custom(); return; }
    }
    const root = document.getElementById('modalRoot');
    if (root) root.textContent = '';
    document.body.classList.remove('modal-open');
  }

  function openModal(html: string): void {
    closeModal();
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = html;
    backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
    root.appendChild(backdrop);
    document.body.classList.add('modal-open');
    backdrop.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => closeModal()));
  }

  function confirmDialog(message: string): Promise<boolean> {
    return new Promise(resolve => {
      const html = '<div class="modal small"><div class="modal-head"><div><strong>Confirm</strong><small>' + esc(translatePhrase(message)) + '</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-foot"><button class="btn" id="confirmCancel">Cancel</button><button class="btn primary" id="confirmOk">Confirm</button></div></div>';
      openModal(html);
      let settled = false;
      const finish = (value: boolean): void => { if (settled) return; settled = true; closeModal(); resolve(value); };
      document.getElementById('confirmCancel')?.addEventListener('click', () => finish(false));
      document.getElementById('confirmOk')?.addEventListener('click', () => finish(true));
      document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => finish(false)));
    });
  }

  return { openModal, closeModal, confirmDialog };
}
