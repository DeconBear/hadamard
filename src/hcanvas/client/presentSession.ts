import type { HcDocument } from '../types.js';
import { fitPresentView, renderPresentView } from './presentView.js';

export interface PresentSessionDeps {
  getDoc(): HcDocument | null;
  getActivePageId(): string | null;
  getIndex(): number;
  setIndex(index: number): void;
  setPresenting(active: boolean): void;
  resetInteractions(): void;
  renderToolbarState(): void;
  root(): HTMLElement;
}

export interface PresentSessionController {
  openPresent(): void;
  closePresent(): void;
  togglePresentNotes(): void;
  nextPresent(delta: number): void;
  renderPresent(): void;
  fitPresentPage(): void;
}

/** Presentation mode state machine (extracted from main.ts). */
export function createPresentSession(deps: PresentSessionDeps): PresentSessionController {
  const renderPresent = (): void => {
    renderPresentView({
      root: deps.root(), doc: deps.getDoc(), index: deps.getIndex(),
      normalizePage: page => page,
      next: nextPresent, close: closePresent, toggleNotes: togglePresentNotes,
    });
  };

  const openPresent = (): void => {
    if (!deps.getDoc()) return;
    deps.setPresenting(true);
    deps.setIndex(Math.max(0, deps.getDoc()!.pages.findIndex(page => page.id === deps.getActivePageId())));
    deps.resetInteractions();
    renderPresent();
  };

  const closePresent = (): void => {
    deps.setPresenting(false);
    deps.resetInteractions();
    const root = deps.root();
    root.classList.add('hidden');
    root.textContent = '';
    deps.renderToolbarState();
  };

  const togglePresentNotes = (): void => {
    const notes = document.getElementById('presentNotes');
    const page = deps.getDoc()?.pages[deps.getIndex()];
    if (!notes) return;
    notes.classList.toggle('hidden');
    notes.textContent = page?.notes || 'No speaker notes for this page.';
    fitPresentPage();
  };

  const nextPresent = (delta: number): void => {
    const doc = deps.getDoc();
    if (!doc) return;
    deps.setIndex(Math.max(0, Math.min(doc.pages.length - 1, deps.getIndex() + delta)));
    renderPresent();
  };

  const fitPresentPage = (): void => {
    fitPresentView(deps.root());
  };

  return { openPresent, closePresent, togglePresentNotes, nextPresent, renderPresent, fitPresentPage };
}
