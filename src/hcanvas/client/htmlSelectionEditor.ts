export interface HtmlSelectionEditorOptions {
  getIframe(): HTMLIFrameElement | null;
  isEditing(): boolean;
  getDocument(): Document | null;
  canEdit(element: Element): boolean;
  startInline(element: HTMLElement): void;
  enterEdit(pageId: string): void;
}

export interface HtmlSelectionEditor {
  show(pageId: string, hcId: string, rect: { left: number; top: number; width: number; height: number }): void;
  hide(): void;
  applyPending(pageId: string): void;
}

/** Floating "Edit text" affordance for selections in HTML pages. */
export function createHtmlSelectionEditor(options: HtmlSelectionEditorOptions): HtmlSelectionEditor {
  let chip: HTMLButtonElement | null = null;
  let pending: { pageId: string; hcId: string } | null = null;
  const target = (doc: Document | null, hcId: string): Element | null => doc?.querySelector('[data-hc-id="' + hcId.replace(/"/g, '\\"') + '"]') || null;

  function hide(): void {
    chip?.remove();
    chip = null;
  }

  function show(pageId: string, hcId: string, rect: { left: number; top: number; width: number; height: number }): void {
    hide();
    const iframe = options.getIframe();
    if (!iframe) return;
    const box = iframe.getBoundingClientRect();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'html-selection-edit';
    button.dataset.pageId = pageId;
    button.dataset.hcId = hcId;
    button.textContent = 'Edit text';
    button.style.left = Math.max(12, Math.min(window.innerWidth - 42, box.left + rect.left + rect.width / 2)) + 'px';
    button.style.top = Math.max(12, Math.min(window.innerHeight - 36, box.top + rect.top + rect.height + 8)) + 'px';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      hide();
      if (options.isEditing()) {
        const element = target(options.getDocument(), hcId);
        if (element && options.canEdit(element)) options.startInline(element as HTMLElement);
        return;
      }
      pending = { pageId, hcId };
      options.enterEdit(pageId);
    });
    document.body.appendChild(button);
    chip = button;
  }

  function applyPending(pageId: string): void {
    if (!pending || pending.pageId !== pageId) return;
    const hcId = pending.hcId;
    pending = null;
    const element = target(options.getDocument(), hcId);
    if (element && options.canEdit(element)) options.startInline(element as HTMLElement);
  }

  return { show, hide, applyPending };
}
