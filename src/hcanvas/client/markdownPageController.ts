import type { HcDocument, HcOp, HcPage } from '../types.js';

export interface MarkdownPageControllerOptions {
  getPage(pageId: string): HcPage | null;
  applyOps(ops: HcOp[], options?: { refreshArtboard?: boolean }): Promise<HcDocument | null>;
  openSource(page: HcPage): void;
}

/** Debounced persistence and source-menu plumbing for directly editable Markdown pages. */
export class MarkdownPageController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draft: { pageId: string; markdown: string } | null = null;

  constructor(private readonly options: MarkdownPageControllerOptions) {}

  schedule(pageId: string, markdown: string): void {
    const page = this.options.getPage(pageId);
    if (!page || page.markdown === markdown) return;
    this.draft = { pageId, markdown };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 700);
  }

  commit(pageId: string, markdown: string): void {
    this.draft = { pageId, markdown };
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const page = this.options.getPage(draft.pageId);
    if (!page || page.markdown === draft.markdown) return;
    await this.options.applyOps([{ op: 'set_page_markdown', pageId: draft.pageId, markdown: draft.markdown }], { refreshArtboard: false });
  }

  showSourceMenu(pageId: string, x: number, y: number): void {
    document.querySelectorAll('.page-context-menu').forEach(node => node.remove());
    const menu = document.createElement('div');
    menu.className = 'page-context-menu';
    menu.innerHTML = '<button type="button">Edit Markdown source</button>';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 10)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 10)) + 'px';
    const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
    const outside = (event: PointerEvent): void => { if (!menu.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    menu.querySelector('button')?.addEventListener('click', () => { close(); void this.openSource(pageId); });
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); }, 0);
  }

  async openSource(pageId: string): Promise<void> {
    await this.flush();
    const page = this.options.getPage(pageId);
    if (page?.markdown !== undefined) this.options.openSource(page);
  }
}
