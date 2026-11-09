import {
  HTML_INSERT_PRESETS,
  bindHtmlStyleControls,
  collectHtmlTree,
  deleteSelectedHtml,
  duplicateSelectedHtml,
  htmlBreadcrumbMarkup,
  htmlStylePresetMarkup,
  insertHtmlPreset,
  type HtmlEditingContext,
} from './htmlEditing.js';
import { esc, toHex } from './utils.js';

export interface HtmlInspectorOptions {
  root: HTMLElement;
  contentDocument: Document | null;
  editing: { pageId: string; blockId?: string } | null;
  context: HtmlEditingContext;
  editText(element: HTMLElement): void;
  openSource(target: { pageId: string; blockId?: string }): void;
}

export function renderHtmlInspectorPanel(options: HtmlInspectorOptions): void {
  const { root, contentDocument, context } = options;
  if (!contentDocument) { root.innerHTML = '<p class="empty-state">HTML editor is loading…</p>'; return; }
  const selected = context.getSelectedElement();
  const style = selected ? contentDocument.defaultView?.getComputedStyle(selected) : null;
  const rows = collectHtmlTree(contentDocument);
  let html = '<section class="inspector-section html-editor-overview"><div class="inspector-title">HTML editor</div><p class="inspector-note">Click to select · click selected text again to edit · styles save automatically.</p></section>';
  html += '<section class="inspector-section"><div class="inspector-title">Insert element</div><p class="inspector-note">Adds after the selected element, or at the end of the page.</p><div class="html-insert-grid">';
  for (const preset of HTML_INSERT_PRESETS) html += '<button type="button" class="html-insert-btn" data-html-insert="' + preset.id + '" title="' + esc(preset.hint) + '"><span class="html-insert-plus">+</span><span class="html-insert-label">' + esc(preset.label) + '</span></button>';
  html += '</div></section>';
  html += htmlBreadcrumbMarkup(selected);
  if (selected) {
    const tag = selected.tagName.toLowerCase();
    const id = selected.getAttribute('data-hc-id') || '';
    const classes = selected.getAttribute('class') || '';
    html += '<section class="inspector-section html-selected-section"><div class="inspector-title">Selected element</div>';
    html += '<div class="field"><span>Element</span><input readonly value="' + esc('<' + tag + '>' + (id ? ' #' + id : '') + (classes ? ' .' + classes.replace(/\s+/g, '.') : '')) + '"></div>';
    html += '<div class="html-style-head"><span>Style</span><small>Changes apply automatically</small></div>';
    html += htmlStylePresetMarkup();
    html += '<div class="field-row"><div class="field"><span>Text color</span><div class="swatch-row"><input id="hcColor" type="color" value="' + esc(toHex(style?.color || '#1d232e')) + '"><input id="hcColorText" value="' + esc(style?.color || '#1d232e') + '"></div></div><div class="field"><span>Background</span><div class="swatch-row"><input id="hcBg" type="color" value="' + esc(toHex(style?.backgroundColor || '#ffffff')) + '"><input id="hcBgText" value="' + esc(style?.backgroundColor || 'transparent') + '"></div></div></div>';
    html += '<div class="field-row"><div class="field"><span>Font size</span><input id="hcFontSize" type="number" value="' + esc(parseFloat(style?.fontSize || '16') || 16) + '"></div><div class="field"><span>Padding</span><input id="hcPadding" value="' + esc(style?.padding || '0px') + '"></div><div class="field"><span>Align</span><select id="hcAlign"><option value="">—</option><option value="left">left</option><option value="center">center</option><option value="right">right</option><option value="justify">justify</option></select></div></div>';
    html += '<div class="field-row"><div class="field"><span>Weight</span><select id="hcFontWeight"><option value="">—</option><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semibold</option><option value="700">Bold</option></select></div><div class="field"><span>Radius</span><input id="hcRadius" value="' + esc(style?.borderRadius || '0px') + '"></div><div class="field"><span>Line height</span><input id="hcLineHeight" value="' + esc(style?.lineHeight || 'normal') + '"></div></div>';
    html += '<div class="field-row"><div class="field"><span>Letter spacing</span><input id="hcLetterSpacing" value="' + esc(style?.letterSpacing || 'normal') + '"></div></div>';
    html += '<div class="actions-row"><button id="hcEditText" class="btn tiny">Edit text</button><button id="hcSelectParent" class="btn tiny">Select parent</button><button id="hcDuplicate" class="btn tiny">Duplicate</button><button id="hcSourceBtn" class="btn tiny">Source</button><button id="hcDelete" class="btn tiny danger">Delete</button></div><p class="html-keyboard-hint">Click again / Enter to edit · Ctrl/Cmd+C/X/V · Delete · Ctrl/Cmd+Z</p></section>';
  } else {
    html += '<section class="inspector-section"><p class="empty-state">Click an element in the page to inspect styles. Click the selected text again, or press Enter, to edit it.</p></section>';
  }
  html += '<section class="inspector-section html-tree-section"><div class="inspector-title">Elements <span class="inspector-count">' + rows.length + '</span></div><div class="element-tree">';
  for (const row of rows) {
    html += '<button type="button" class="element-row' + (selected && row.hcId === selected.getAttribute('data-hc-id') ? ' active' : '') + '" data-html-id="' + esc(row.hcId) + '" style="padding-left:' + (5 + Math.min(row.depth, 8) * 8) + 'px"><span class="tag">&lt;' + esc(row.tag) + '&gt;</span><span class="clip">' + esc(row.text || row.hcId) + '</span></button>';
  }
  html += '</div></section>';
  root.innerHTML = html;
  const align = root.querySelector<HTMLSelectElement>('#hcAlign');
  if (align) align.value = style?.textAlign || '';
  const weight = root.querySelector<HTMLSelectElement>('#hcFontWeight');
  if (weight) weight.value = style?.fontWeight || '';
  root.querySelectorAll<HTMLButtonElement>('[data-html-crumb]').forEach(button => {
    button.addEventListener('click', () => {
      const element = contentDocument.querySelector('[data-hc-id="' + (button.dataset.htmlCrumb || '').replace(/"/g, '\\"') + '"]');
      if (element) context.selectElement(element);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-html-id]').forEach(button => {
    button.addEventListener('click', () => {
      const element = contentDocument.querySelector('[data-hc-id="' + (button.dataset.htmlId || '').replace(/"/g, '\\"') + '"]');
      if (element) context.selectElement(element);
    });
  });
  bindHtmlStyleControls(root, context);
  root.querySelector<HTMLButtonElement>('#hcEditText')?.addEventListener('click', () => { if (selected) options.editText(selected as HTMLElement); });
  root.querySelector<HTMLButtonElement>('#hcDuplicate')?.addEventListener('click', () => { void duplicateSelectedHtml(context); });
  root.querySelector<HTMLButtonElement>('#hcDelete')?.addEventListener('click', () => { void deleteSelectedHtml(context); });
  root.querySelectorAll<HTMLButtonElement>('[data-html-insert]').forEach(button => {
    button.addEventListener('click', () => { void insertHtmlPreset(button.dataset.htmlInsert || '', context); });
  });
  root.querySelector<HTMLButtonElement>('#hcSelectParent')?.addEventListener('click', () => {
    const parent = selected?.parentElement;
    if (parent && parent !== contentDocument.body) context.selectElement(parent);
  });
  root.querySelector<HTMLButtonElement>('#hcSourceBtn')?.addEventListener('click', () => { if (options.editing) options.openSource(options.editing); });
}
