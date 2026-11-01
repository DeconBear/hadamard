/**
 * Excalidraw-backed canvas GUI client. Mounts the locally built Excalidraw
 * bundle and syncs the scene through /api/canvas/scene.
 */
export const GUI_CANVAS_CLIENT_SCRIPT = String.raw`
/* ── Excalidraw-backed canvas client ────────────────────────────────────────
 * The canvas tab embeds the locally built Excalidraw bundle (MIT). Hadamard
 * keeps document management, module gating, agent tools and proposal review. */
var canvasState = {
  projectPath: null,
  docs: [],
  docsError: '',
  doc: null,
  docId: null,
  checks: [],
  query: '',
  handle: null,
  hydrating: false,
  saving: false,
  saveTimer: null,
  suppressSaveUntil: 0,
  status: 'Ready',
  statusKind: '',
  scriptPromise: null,
};

function canvasModuleEnabled() {
  return state.snapshot && state.snapshot.settings && state.snapshot.settings.modules
    && state.snapshot.settings.modules.enabled && state.snapshot.settings.modules.enabled.canvas === true;
}
function canvasProjectPath() {
  return (state.snapshot && (state.snapshot.projectPath || state.snapshot.workDir)) || '';
}
function canvasErrorText(error) { return error && error.message ? error.message : String(error); }
function canvasSetStatus(text, kind) {
  canvasState.status = text;
  canvasState.statusKind = kind || '';
  var status = el('cvxStatus');
  if (status) {
    status.textContent = text;
    status.className = 'cvx-status' + (kind === 'error' ? ' is-error' : '');
  }
}
async function canvasRequest(path, options) {
  var response = await api(path, options);
  var raw = await response.text();
  var payload = {};
  if (raw) { try { payload = JSON.parse(raw); } catch (_) { payload = { error: raw }; } }
  if (!response.ok) {
    var error = new Error(payload && payload.error ? payload.error : ('HTTP ' + response.status));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}
function canvasUrl(path, params) {
  var query = Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key] == null ? '' : params[key]);
  }).join('&');
  return path + (query ? '?' + query : '');
}

/* ── Module settings (Personalization -> Modules) ───────────────────────── */
function renderModuleSettings(modules) {
  var root = el('settingsModulesList');
  if (!root) return;
  root.textContent = '';
  var definitions = (modules && modules.definitions) || [];
  var states = {};
  ((modules && modules.states) || []).forEach(function (item) { states[item.id] = item; });
  if (!definitions.length) { root.innerHTML = '<p class="muted">No optional modules are registered.</p>'; return; }
  definitions.forEach(function (definition) {
    var row = document.createElement('div');
    row.className = 'settings-help-row';
    var copy = document.createElement('span');
    var title = document.createElement('strong');
    title.textContent = definition.title || definition.id;
    var description = document.createElement('small');
    description.textContent = (definition.description || '') + ' Default: ' + (definition.defaultEnabled ? 'on' : 'off') + ' · ' + (definition.kind || 'ui') + '. Disabling unloads its UI, tools and context.';
    copy.append(title, description);
    var label = document.createElement('label');
    label.className = 'switch-field';
    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.dataset.moduleId = definition.id;
    toggle.checked = states[definition.id] ? states[definition.id].enabled === true : definition.defaultEnabled === true;
    toggle.addEventListener('change', function () {
      var saving = persistSettingsNow();
      if (saving && typeof saving.then === 'function') {
        saving.then(function () {
          if (typeof renderProjectDetail === 'function' && state.projectView === 'detail') renderProjectDetail();
        }).catch(function () { /* settings surface reports errors */ });
      }
    });
    label.append(toggle);
    row.append(copy, label);
    root.append(row);
  });
}

/* ── Styles ─────────────────────────────────────────────────────────────── */
function canvasStyles() {
  return [
    '.cvx-root{--cvx-bg:var(--bg-app,#f5f6f8);--cvx-surface:var(--bg-surface,#fff);--cvx-border:var(--border,#e5e7eb);--cvx-ink:var(--text-1,#1f2937);--cvx-muted:var(--text-2,#64748b);--cvx-brand:var(--brand,#2563eb);--cvx-brand-soft:var(--brand-soft,#eef4ff);display:flex;height:100%;min-height:0;overflow:hidden;background:var(--cvx-bg);color:var(--cvx-ink);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}',
    '.cvx-side{width:244px;flex:0 0 244px;display:flex;flex-direction:column;min-height:0;background:var(--cvx-surface);border-right:1px solid var(--cvx-border)}',
    '.cvx-side-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:14px 14px 10px}',
    '.cvx-eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--cvx-muted)}',
    '.cvx-side-head h2{margin:3px 0 0;font-size:16px;line-height:1.2;font-weight:650;letter-spacing:-.02em}',
    '.cvx-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:var(--cvx-bg);color:var(--cvx-muted);font-size:10px;font-weight:600;vertical-align:2px}',
    '.cvx-search{display:flex;align-items:center;gap:6px;margin:0 14px 10px;padding:6px 8px;border:1px solid var(--cvx-border);border-radius:8px;background:var(--cvx-bg);color:var(--cvx-muted)}',
    '.cvx-search input{border:0;background:transparent;outline:0;font:inherit;font-size:12px;color:var(--cvx-ink);width:100%}',
    '.cvx-doc-list{flex:1;min-height:0;overflow:auto;padding:0 10px 10px;display:flex;flex-direction:column;gap:6px}',
    '.cvx-doc{position:relative;text-align:left;border:1px solid var(--cvx-border);background:var(--cvx-surface);border-radius:10px;padding:8px 10px 8px 13px;cursor:pointer;display:flex;flex-direction:column;gap:3px}',
    '.cvx-doc:hover{border-color:#cbd5e1;box-shadow:0 2px 8px rgba(15,23,42,.05)}',
    '.cvx-doc.active{border-color:var(--cvx-brand);background:var(--cvx-brand-soft)}',
    '.cvx-doc.active:before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--cvx-brand)}',
    '.cvx-doc strong{font-size:12.5px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}',
    '.cvx-doc-meta{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--cvx-muted)}',
    '.cvx-chip{background:var(--cvx-bg);border:1px solid var(--cvx-border);border-radius:4px;padding:0 4px;font-variant-numeric:tabular-nums}',
    '.cvx-doc.active .cvx-chip{background:rgba(255,255,255,.75)}',
    '.cvx-pending-dot{width:6px;height:6px;border-radius:50%;background:#7c5cff;margin-left:auto}',
    '.cvx-side-foot{border-top:1px solid var(--cvx-border);padding:9px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.cvx-badge{font-size:9px;font-weight:700;letter-spacing:.1em;color:#7c5cff;background:rgba(124,92,255,.08);border:1px solid rgba(124,92,255,.18);border-radius:999px;padding:2px 7px}',
    '.cvx-text-btn{border:0;background:none;color:var(--cvx-muted);font:inherit;font-size:11px;cursor:pointer}',
    '.cvx-text-btn:hover{color:var(--cvx-brand)}',
    '.cvx-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}',
    '.cvx-topbar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--cvx-surface);border-bottom:1px solid var(--cvx-border);min-height:52px}',
    '.cvx-topbar h2{margin:2px 0 0;font-size:15px;font-weight:650;line-height:1.2;max-width:52ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cvx-topbar .cvx-eyebrow{font-size:9px}',
    '.cvx-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.cvx-button{border:1px solid var(--cvx-border);background:var(--cvx-surface);color:var(--cvx-ink);border-radius:7px;padding:4px 9px;font:inherit;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap}',
    '.cvx-button:hover:not(:disabled){border-color:var(--cvx-brand);color:var(--cvx-brand);background:var(--cvx-brand-soft)}',
    '.cvx-button:disabled{opacity:.45;cursor:default}',
    '.cvx-button-primary{background:var(--cvx-brand);border-color:var(--cvx-brand);color:#fff}',
    '.cvx-button-primary:hover:not(:disabled){background:#1d4ed8;border-color:#1d4ed8;color:#fff}',
    '.cvx-status{font-size:10.5px;color:var(--cvx-muted);font-variant-numeric:tabular-nums;margin-right:4px}',
    '.cvx-status.is-error{color:#ef4444}',
    '.cvx-host{position:relative;flex:1;min-height:0;overflow:hidden;background:var(--cvx-bg)}',
    '.cvx-host .excalidraw{height:100%!important}',
    '.cvx-error{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);max-width:520px;padding:18px 20px;border:1px solid #fecaca;background:#fff7f7;border-radius:12px;color:#991b1b;font-size:12px;line-height:1.6;text-align:center;z-index:10}',
    '.cvx-error code{background:#fee2e2;border-radius:4px;padding:1px 5px;font-size:11px}',
    '.cvx-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--cvx-muted);font-size:12px;background:var(--cvx-bg);z-index:5}',
    '.cvx-overlay[hidden]{display:none}',
    '.cvx-right{width:300px;flex:0 0 300px;display:flex;flex-direction:column;min-height:0;background:var(--cvx-surface);border-left:1px solid var(--cvx-border);overflow:auto}',
    '.cvx-pane-head{padding:14px 14px 8px;border-bottom:0}',
    '.cvx-pane-head h2{margin:3px 0 0;font-size:15px;font-weight:650;letter-spacing:-.01em}',
    '.cvx-section{padding:0 14px 14px}',
    '.cvx-section-title{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--cvx-muted)}',
    '.cvx-proposal{border:1px solid var(--cvx-border);border-radius:10px;padding:10px;margin-bottom:8px;display:flex;flex-direction:column;gap:7px}',
    '.cvx-proposal p{margin:0;font-size:12px;font-weight:600;line-height:1.4}',
    '.cvx-proposal-meta{display:flex;flex-wrap:wrap;gap:5px;font-size:10px;color:var(--cvx-muted)}',
    '.cvx-proposal-actions{display:flex;gap:6px}',
    '.cvx-proposal-actions .cvx-button{flex:1;text-align:center}',
    '.cvx-empty{font-size:11.5px;color:var(--cvx-muted);line-height:1.55;margin:0}',
    '.cvx-check{display:flex;gap:7px;align-items:flex-start;font-size:11px;color:var(--cvx-muted);padding:3px 0}',
    '.cvx-check-dot{width:6px;height:6px;border-radius:50%;margin-top:5px;flex:0 0 auto;background:#10b981}',
    '.cvx-check.error .cvx-check-dot{background:#ef4444}',
    '.cvx-check.ok{color:#059669;font-weight:500}',
    '.cvx-hint{font-size:10.5px;color:var(--cvx-muted);line-height:1.6;margin:0}',
    '.cvx-hint kbd{background:var(--cvx-bg);border:1px solid var(--cvx-border);border-radius:4px;padding:0 4px;font-size:10px}',
    '@media (max-width:1500px){.cvx-side{width:214px;flex-basis:214px}.cvx-right{width:272px;flex-basis:272px}}',
  ].join('');
}

/* ── Workspace skeleton ─────────────────────────────────────────────────── */
function canvasEnsureWorkspace() {
  var panel = el('projectCanvasPanel');
  if (!panel) return null;
  if (el('canvasWorkspace')) return el('canvasWorkspace');
  panel.innerHTML = ''
    + '<style>' + canvasStyles() + '</style>'
    + '<div id="canvasWorkspace" class="cvx-root">'
    + '  <aside class="cvx-side">'
    + '    <div class="cvx-side-head"><div><div class="cvx-eyebrow">Workspace</div><h2>Canvases <span id="cvxDocCount" class="cvx-count">0</span></h2></div><button type="button" class="cvx-button cvx-button-primary" id="cvxNewBtn" title="New blank canvas">+ New</button></div>'
    + '    <label class="cvx-search"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="cvxDocSearch" placeholder="Filter canvases" aria-label="Filter canvases"></label>'
    + '    <div id="cvxDocList" class="cvx-doc-list"></div>'
    + '    <p id="cvxDocsError" style="color:#ef4444;font-size:10.5px;padding:0 14px"></p>'
    + '    <div class="cvx-side-foot"><span class="cvx-badge">EXCALIDRAW</span><button type="button" class="cvx-text-btn" id="cvxRefreshBtn">Reload list</button></div>'
    + '  </aside>'
    + '  <main class="cvx-main">'
    + '    <div class="cvx-topbar">'
    + '      <div><div class="cvx-eyebrow">Design canvas</div><h2 id="cvxDocTitle">No canvas</h2></div>'
    + '      <div class="cvx-actions">'
    + '        <span id="cvxStatus" class="cvx-status">Ready</span>'
    + '        <button type="button" class="cvx-button" id="cvxReloadBtn" title="Reload this canvas from disk">Reload</button>'
    + '        <button type="button" class="cvx-button" id="cvxAiBtn" title="Create an AI-model architecture canvas">AI template</button>'
    + '      </div>'
    + '    </div>'
    + '    <div id="cvxHost" class="cvx-host"><div id="cvxLoading" class="cvx-overlay">Loading canvas editor…</div></div>'
    + '    <div id="cvxError" class="cvx-error" hidden></div>'
    + '  </main>'
    + '  <aside class="cvx-right">'
    + '    <div class="cvx-pane-head"><div class="cvx-eyebrow">Agent review</div><h2>Proposals</h2></div>'
    + '    <div class="cvx-section" id="cvxProposals"></div>'
    + '    <div class="cvx-pane-head"><div class="cvx-eyebrow">Validation</div><h2>Checks</h2></div>'
    + '    <div class="cvx-section" id="cvxChecks"></div>'
    + '    <div class="cvx-pane-head"><div class="cvx-eyebrow">Tips</div><h2>Working with the agent</h2></div>'
    + '    <div class="cvx-section">'
    + '      <p class="cvx-hint">Everything on the canvas is Excalidraw: shapes, arrows, text, images, freedraw, frames. Use the left toolbar to draw and the left style panel to change stroke, fill, roughness, fonts and arrowheads.</p>'
    + '      <p class="cvx-hint" style="margin-top:8px">The agent reads blocks as a text outline and can propose changes. Pending proposals appear here; accepting applies them to the scene.</p>'
    + '      <p class="cvx-hint" style="margin-top:8px">Canvas opens with <kbd>Ctrl+Z</kbd>/<kbd>Ctrl+Shift+Z</kbd> history, <kbd>Ctrl+A</kbd> select all, and the scene autosaves after you stop drawing.</p>'
    + '    </div>'
    + '  </aside>'
    + '</div>';
  el('cvxNewBtn').addEventListener('click', function () { void canvasCreateDoc('blank-design'); });
  el('cvxAiBtn').addEventListener('click', function () { void canvasCreateDoc('ai-model-transformer'); });
  el('cvxRefreshBtn').addEventListener('click', function () { void canvasRefresh(); });
  el('cvxReloadBtn').addEventListener('click', function () { void canvasReloadScene(); });
  el('cvxDocSearch').addEventListener('input', function (event) {
    canvasState.query = String(event.target.value || '').toLocaleLowerCase();
    canvasRenderDocList();
  });
  return el('canvasWorkspace');
}
async function mountCanvasPanel() {
  if (!canvasModuleEnabled()) return;
  canvasEnsureWorkspace();
  try {
    await canvasListDocs();
    canvasRenderDocList();
    var current = canvasState.docId || (canvasState.docs[0] && canvasState.docs[0].id) || null;
    if (current && canvasState.docs.some(function (doc) { return doc.id === current; })) await canvasOpenDoc(current);
    else canvasSetStatus('Create a canvas to start designing');
  } catch (error) {
    canvasShowError(canvasErrorText(error));
  }
}
async function canvasListDocs() {
  canvasState.projectPath = canvasProjectPath();
  var data = await canvasRequest(canvasUrl('/api/canvas/list', { projectPath: canvasState.projectPath }));
  canvasState.docs = data.documents || [];
  canvasState.docsError = (data.errors || []).map(function (item) { return item.file + ': ' + item.message; }).join('; ');
  return canvasState.docs;
}
function canvasRenderDocList() {
  var root = el('cvxDocList');
  if (!root) return;
  root.textContent = '';
  var docs = canvasState.docs.filter(function (doc) {
    if (!canvasState.query) return true;
    return String(doc.title).toLocaleLowerCase().indexOf(canvasState.query) >= 0;
  });
  var count = el('cvxDocCount');
  if (count) count.textContent = String(canvasState.docs.length);
  docs.forEach(function (doc) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'cvx-doc' + (canvasState.docId === doc.id ? ' active' : '');
    var title = document.createElement('strong');
    title.textContent = doc.title;
    button.appendChild(title);
    var meta = document.createElement('div');
    meta.className = 'cvx-doc-meta';
    var revision = document.createElement('span');
    revision.className = 'cvx-chip';
    revision.textContent = 'rev ' + doc.revision;
    var blocks = document.createElement('span');
    blocks.className = 'cvx-chip';
    blocks.textContent = doc.nodeCount + ' items';
    meta.append(revision, blocks);
    if (doc.pendingProposals) {
      var dot = document.createElement('span');
      dot.className = 'cvx-pending-dot';
      dot.title = doc.pendingProposals + ' pending proposal(s)';
      meta.appendChild(dot);
    }
    button.appendChild(meta);
    button.addEventListener('click', function () { void canvasOpenDoc(doc.id); });
    root.appendChild(button);
  });
  if (!docs.length) {
    var empty = document.createElement('p');
    empty.className = 'cvx-empty';
    empty.textContent = canvasState.query ? 'No canvases match this filter.' : 'No canvases yet. Create one or start from the AI template.';
    root.appendChild(empty);
  }
  var err = el('cvxDocsError');
  if (err) err.textContent = canvasState.docsError || '';
}
async function canvasCreateDoc(template) {
  try {
    var titleBase = template === 'ai-model-transformer' ? 'AI model canvas' : 'Untitled canvas';
    var title = titleBase + (canvasState.docs.length > 0 ? ' ' + (canvasState.docs.length + 1) : '');
    var data = await canvasRequest('/api/canvas/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: canvasState.projectPath || canvasProjectPath(), title: title, template: template }),
    });
    await canvasListDocs();
    canvasRenderDocList();
    await canvasOpenDoc(data.doc.id);
    canvasSetStatus(template === 'ai-model-transformer' ? 'AI-model canvas created' : 'Canvas created');
  } catch (error) { canvasShowError(canvasErrorText(error)); }
}
async function canvasRefresh() {
  try {
    await canvasListDocs();
    canvasRenderDocList();
    canvasSetStatus('Canvas list reloaded');
  } catch (error) { canvasShowError(canvasErrorText(error)); }
}
function canvasLoadEditorScript() {
  if (window.HadamardExcalidraw) return Promise.resolve(window.HadamardExcalidraw);
  if (canvasState.scriptPromise) return canvasState.scriptPromise;
  canvasState.scriptPromise = new Promise(function (resolve, reject) {
    var existing = document.querySelector('script[data-hadamard-excalidraw]');
    if (existing) { reject(new Error('Excalidraw bundle did not initialize.')); return; }
    var script = document.createElement('script');
    script.src = '/gui-canvas/excalidraw.js';
    script.dataset.hadamardExcalidraw = '1';
    script.onload = function () {
      if (window.HadamardExcalidraw) resolve(window.HadamardExcalidraw);
      else reject(new Error('Excalidraw global missing after load.'));
    };
    script.onerror = function () { reject(new Error('Could not load the Excalidraw bundle. Run: node scripts/build-gui-canvas.mjs')); };
    document.head.appendChild(script);
  });
  return canvasState.scriptPromise;
}
function canvasShowError(message) {
  canvasSetStatus(message, 'error');
  var error = el('cvxError');
  if (error) {
    error.hidden = false;
    error.textContent = message.indexOf('build-gui-canvas') >= 0
      ? 'Canvas editor assets are missing. Run: node scripts/build-gui-canvas.mjs, then press Reload.'
      : message;
  }
  var loading = el('cvxLoading');
  if (loading) loading.hidden = true;
}
function canvasHideError() {
  var error = el('cvxError');
  if (error) { error.hidden = true; error.textContent = ''; }
}
async function canvasOpenDoc(docId) {
  if (canvasState.docId && canvasState.docId !== docId) await canvasFlushSave();
  try {
    canvasHideError();
    var loading = el('cvxLoading');
    if (loading) loading.hidden = false;
    var data = await canvasRequest(canvasUrl('/api/canvas/scene', {
      projectPath: canvasState.projectPath || canvasProjectPath(), docId: docId,
    }));
    canvasState.doc = data.doc;
    canvasState.docId = docId;
    canvasState.checks = data.checks || [];
    canvasState.saveTimer = null;
    await canvasMountEditor(data.scene);
    canvasRenderDocList();
    canvasRenderRightPane();
    canvasSetStatus('Saved · rev ' + data.doc.revision);
    var title = el('cvxDocTitle');
    if (title) title.textContent = data.doc.title;
    if (loading) loading.hidden = true;
  } catch (error) { canvasShowError(canvasErrorText(error)); }
}
async function canvasMountEditor(scene) {
  var editor = await canvasLoadEditorScript();
  var host = el('cvxHost');
  if (!host) return;
  var loading = el('cvxLoading');
  if (loading) loading.hidden = true;
  if (canvasState.handle) {
    try { canvasState.handle.unmount(); } catch (_) { /* ignore */ }
    canvasState.handle = null;
  }
  var oldHost = host.querySelector('.hadamard-excalidraw-host');
  if (oldHost) oldHost.remove();
  canvasState.hydrating = true;
  canvasState.handle = editor.mount(host, {
    initialData: {
      elements: (scene && scene.elements) || [],
      appState: { viewBackgroundColor: '#f7f8fa', ...((scene && scene.appState) || {}), collaborators: new Map() },
      files: (scene && scene.files) || {},
      scrollToContent: true,
    },
    theme: 'light',
    onChange: function () {
      if (canvasState.hydrating || Date.now() < canvasState.suppressSaveUntil) return;
      canvasScheduleSave();
    },
    onReady: function () {
      canvasState.hydrating = false;
      setTimeout(canvasFitExcalidrawView, 250);
    },
  });
  window.__hadamardCanvas = {
    handle: canvasState.handle,
    getDoc: function () { return canvasState.doc; },
    saveNow: canvasSaveScene,
    reload: canvasReloadScene,
  };
  setTimeout(function () { canvasState.hydrating = false; }, 1200);
}
function canvasFitExcalidrawView() {
  try {
    var api = canvasState.handle && canvasState.handle.getApi();
    var host = el('cvxHost');
    if (!api || !host) return;
    var allElements = api.getSceneElements ? api.getSceneElements().filter(function (element) { return !element.isDeleted; }) : [];
    var elements = allElements.filter(function (element) { return element.type !== 'frame'; });
    if (!elements.length) elements = allElements;
    if (!elements.length) return;
    var minX = Infinity; var minY = Infinity; var maxX = -Infinity; var maxY = -Infinity;
    elements.forEach(function (element) {
      var x = element.x || 0; var y = element.y || 0;
      var w = element.width || 0; var h = element.height || 0;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    });
    if (!isFinite(minX)) return;
    var rect = host.getBoundingClientRect();
    var pad = 80;
    var contentWidth = Math.max(40, maxX - minX);
    var contentHeight = Math.max(40, maxY - minY);
    var zoom = Math.min(1.6, Math.max(0.1, Math.min((rect.width - pad * 2) / contentWidth, (rect.height - pad * 2) / contentHeight)));
    var centerX = (minX + maxX) / 2;
    var centerY = (minY + maxY) / 2;
    api.updateScene({
      appState: {
        ...api.getAppState(),
        scrollX: rect.width / 2 - centerX * zoom,
        scrollY: rect.height / 2 - centerY * zoom,
        zoom: { value: zoom },
      },
    });
  } catch (_) { /* keep default viewport */ }
}
function canvasScheduleSave() {
  if (canvasState.saveTimer) clearTimeout(canvasState.saveTimer);
  canvasSetStatus('Unsaved changes…');
  canvasState.saveTimer = setTimeout(function () { void canvasSaveScene(); }, 800);
}
async function canvasFlushSave() {
  if (canvasState.saveTimer) {
    clearTimeout(canvasState.saveTimer);
    canvasState.saveTimer = null;
    await canvasSaveScene();
  }
}
async function canvasSaveScene() {
  if (!canvasState.doc || !canvasState.handle || canvasState.saving) return;
  var scene = canvasState.handle.getScene();
  var payload = {
    elements: scene.elements || [],
    appState: { viewBackgroundColor: (scene.appState && scene.appState.viewBackgroundColor) || '#f7f8fa' },
    files: scene.files || {},
  };
  canvasState.saving = true;
  canvasSetStatus('Saving…');
  try {
    var data = await canvasRequest('/api/canvas/scene', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: canvasState.projectPath,
        docId: canvasState.docId,
        baseRevision: canvasState.doc.revision,
        scene: payload,
      }),
    });
    canvasState.doc = data.doc;
    canvasState.checks = data.checks || [];
    canvasUpdateDocSummary(data.doc);
    var title = el('cvxDocTitle');
    if (title) title.textContent = data.doc.title;
    canvasRenderRightPane();
    canvasRenderDocList();
    canvasSetStatus('Saved · rev ' + data.doc.revision);
  } catch (error) {
    if (error.status === 409) {
      canvasSetStatus('Scene changed elsewhere; reloading…', 'error');
      await canvasReloadScene();
    } else {
      canvasShowError(canvasErrorText(error));
    }
  } finally {
    canvasState.saving = false;
  }
}
function canvasUpdateDocSummary(doc) {
  if (!canvasState.docs || !doc) return;
  var entry = canvasState.docs.find(function (item) { return item.id === doc.id; });
  if (!entry) return;
  entry.revision = doc.revision;
  entry.nodeCount = (doc.nodes || []).length;
  entry.edgeCount = (doc.edges || []).length;
  entry.updatedAt = doc.updatedAt;
  entry.pendingProposals = (doc.proposals || []).filter(function (proposal) { return proposal.status === 'pending'; }).length;
}
async function canvasReloadScene() {
  if (!canvasState.docId) return;
  try {
    var data = await canvasRequest(canvasUrl('/api/canvas/scene', {
      projectPath: canvasState.projectPath || canvasProjectPath(), docId: canvasState.docId,
    }));
    canvasState.doc = data.doc;
    canvasState.checks = data.checks || [];
    if (canvasState.handle) {
      canvasState.hydrating = true;
      canvasState.suppressSaveUntil = Date.now() + 2500;
      canvasState.handle.updateScene({
        elements: (data.scene && data.scene.elements) || [],
        appState: { viewBackgroundColor: '#f7f8fa', ...((data.scene && data.scene.appState) || {}) },
        files: (data.scene && data.scene.files) || {},
        scrollToContent: true,
      });
      setTimeout(function () { canvasState.hydrating = false; }, 2500);
    }
    canvasRenderRightPane();
    canvasRenderDocList();
    canvasUpdateDocSummary(data.doc);
    canvasSetStatus('Saved · rev ' + data.doc.revision);
  } catch (error) { canvasShowError(canvasErrorText(error)); }
}
function canvasRenderRightPane() {
  canvasRenderProposals();
  canvasRenderChecks();
}
function canvasRenderProposals() {
  var root = el('cvxProposals');
  if (!root) return;
  root.textContent = '';
  var doc = canvasState.doc;
  if (!doc) {
    var empty = document.createElement('p');
    empty.className = 'cvx-empty';
    empty.textContent = 'No canvas open.';
    root.appendChild(empty);
    return;
  }
  var pending = (doc.proposals || []).filter(function (proposal) { return proposal.status === 'pending'; });
  if (!pending.length) {
    var none = document.createElement('p');
    none.className = 'cvx-empty';
    none.textContent = 'No pending proposals. Ask the agent to design or review this canvas — changes arrive here for approval.';
    root.appendChild(none);
    return;
  }
  pending.forEach(function (proposal) {
    var card = document.createElement('div');
    card.className = 'cvx-proposal';
    var intent = document.createElement('p');
    intent.textContent = proposal.intent;
    var meta = document.createElement('div');
    meta.className = 'cvx-proposal-meta';
    meta.innerHTML = '<span class="cvx-chip">' + proposal.ops.length + ' ops</span>'
      + '<span class="cvx-chip">base rev ' + proposal.baseRevision + '</span>'
      + '<span>agent</span>';
    var actions = document.createElement('div');
    actions.className = 'cvx-proposal-actions';
    var accept = document.createElement('button');
    accept.type = 'button'; accept.className = 'cvx-button cvx-button-primary'; accept.textContent = 'Accept';
    accept.addEventListener('click', function () { void canvasResolveProposal(proposal.id, 'accept'); });
    var reject = document.createElement('button');
    reject.type = 'button'; reject.className = 'cvx-button'; reject.textContent = 'Reject';
    reject.addEventListener('click', function () { void canvasResolveProposal(proposal.id, 'reject'); });
    actions.append(accept, reject);
    card.append(intent, meta, actions);
    root.appendChild(card);
  });
}
function canvasRenderChecks() {
  var root = el('cvxChecks');
  if (!root) return;
  root.textContent = '';
  if (!canvasState.doc) { return; }
  if (!canvasState.checks.length) {
    var ok = document.createElement('div');
    ok.className = 'cvx-check ok';
    ok.innerHTML = '<span class="cvx-check-dot"></span><span>No problems found.</span>';
    root.appendChild(ok);
    return;
  }
  canvasState.checks.slice(0, 12).forEach(function (check) {
    var row = document.createElement('div');
    row.className = 'cvx-check ' + (check.severity || 'info');
    var dot = document.createElement('span');
    dot.className = 'cvx-check-dot';
    var text = document.createElement('span');
    text.textContent = check.message;
    row.append(dot, text);
    root.appendChild(row);
  });
}
async function canvasResolveProposal(proposalId, action) {
  try {
    var data = await canvasRequest('/api/canvas/proposal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: canvasState.projectPath, docId: canvasState.docId, proposalId: proposalId, action: action }),
    });
    canvasState.doc = data.doc;
    canvasState.checks = data.checks || [];
    canvasUpdateDocSummary(data.doc);
    await canvasReloadScene();
    if (data.conflicted) {
      canvasSetStatus('Proposal conflicted: the canvas changed since it was proposed. Reload and re-open the proposal.', 'error');
      canvasRenderRightPane();
      return;
    }
    canvasSetStatus(action === 'accept' ? 'Proposal accepted' : 'Proposal rejected');
  } catch (error) { canvasShowError(canvasErrorText(error)); }
}
`;
