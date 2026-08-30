import { describe, expect, it } from 'vitest';

import { createHadamardGuiClientScript, createHadamardGuiHtml } from '../src/gui/hadamardGuiAssets.js';

describe('GUI Project detail auxiliary panel', () => {
  it('starts collapsed without changing the conversation default', () => {
    const html = createHadamardGuiHtml();
    const script = createHadamardGuiClientScript();

    expect(html).toContain('id="detailAuxPanelToggleBtn" class="icon-btn" title="Show panel" aria-label="Show panel" aria-pressed="false"');
    expect(script).toContain("conversation: { auxWidth: 340, terminalHeight: 260, auxView: null, auxCollapsed: false");
    expect(script).toContain("project: { auxWidth: 340, terminalHeight: 260, auxView: null, auxCollapsed: true");
  });

  it('migrates the old expanded default once and then preserves user choice', () => {
    const script = createHadamardGuiClientScript();

    expect(script).toContain("surface !== 'project' || parsed.version === 2");
    expect(script).toContain('JSON.stringify({ version: 2, ...state.workbenchLayouts })');
    expect(script).toContain('function openAuxView(kind, reveal = true)');
    expect(script).toContain('if (reveal) ensureAuxVisible();');
    expect(script).toContain('openAuxView(state.auxView, !state.auxCollapsed)');
  });
});
