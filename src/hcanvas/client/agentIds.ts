import type { ListMenuAction } from './listContextMenu.js';
import { translatePhrase } from './i18n.js';
import { esc } from './utils.js';

export type CopyAgentId = (text: string, message: string) => void;

export function pageAgentIdMenuActions(pageId: string, docId: string, copy: CopyAgentId): ListMenuAction[] {
  return [
    { label: translatePhrase('Copy page ID'), action: () => copy(pageId, 'Copied page ID') },
    { label: translatePhrase('Copy canvas ID'), action: () => copy(docId, 'Copied canvas ID') },
  ];
}

export function canvasAgentIdMenuActions(docId: string, copy: CopyAgentId): ListMenuAction[] {
  return [{ label: translatePhrase('Copy canvas ID'), action: () => copy(docId, 'Copied canvas ID') }];
}

function row(label: string, value: string, buttonId: string): string {
  const copyLabel = translatePhrase('Copy ' + label);
  return '<div class="agent-id-row"><span>' + esc(translatePhrase(label)) + '</span><code title="' + esc(value) + '">' + esc(value) + '</code><button type="button" class="btn tiny" id="' + buttonId + '" title="' + esc(copyLabel) + '" aria-label="' + esc(copyLabel) + '">' + esc(translatePhrase('Copy')) + '</button></div>';
}

export function agentIdsMarkup(docId: string, pageId: string): string {
  return '<section class="inspector-section agent-id-section"><div class="inspector-title">' + esc(translatePhrase('Agent IDs')) + '</div>' + row('Canvas ID', docId, 'copyCanvasIdBtn') + row('Page ID', pageId, 'copyPageIdBtn') + '<p class="muted">' + esc(translatePhrase('Tell your agent which IDs to edit.')) + '</p></section>';
}

export function bindAgentIdButtons(root: HTMLElement, docId: string, pageId: string, copy: CopyAgentId): void {
  root.querySelector<HTMLButtonElement>('#copyCanvasIdBtn')?.addEventListener('click', () => copy(docId, 'Copied canvas ID'));
  root.querySelector<HTMLButtonElement>('#copyPageIdBtn')?.addEventListener('click', () => copy(pageId, 'Copied page ID'));
}
