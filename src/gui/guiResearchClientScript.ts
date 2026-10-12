/** All experiment content is rendered as text; never execute or render artifact HTML. */
export const GUI_RESEARCH_CLIENT_SCRIPT = String.raw`
let researchPollTimer = null;
let researchRequestGeneration = 0;
let researchMutationPending = false;
let researchSelectedRun = null;
let researchWorkspace = '';
const researchDrafts = new Map();
function stopResearchPolling() {
  if (researchPollTimer) clearTimeout(researchPollTimer);
  researchPollTimer = null;
  researchRequestGeneration += 1;
}
function researchVisible(workspace) {
  return state.activeRegion === 'project' && state.projectView === 'detail'
    && state.projectDetailTab === 'research' && state.snapshot?.workDir === workspace;
}
function researchText(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = String(value ?? '');
  if (className) node.className = className;
  return node;
}
function researchJson(title, value) {
  const section = document.createElement('details');
  section.append(researchText('summary', title));
  const pre = researchText('pre', JSON.stringify(value, null, 2));
  pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px';
  section.append(pre);
  return section;
}
function researchButton(label, action) {
  const button = researchText('button', label, 'secondary-btn');
  button.type = 'button';
  button.disabled = researchMutationPending;
  button.addEventListener('click', action);
  return button;
}
function researchExampleManifest() {
  return {
    title: 'Deterministic parameter scan', objective: 'Verify a tiny quadratic scan against a pinned expected minimum',
    code: 'import json, pathlib\nxs = RESEARCH_PARAMETERS["xs"]\nvalues = [(x - 2) ** 2 for x in xs]\nout = pathlib.Path("artifacts")\nout.mkdir(exist_ok=True)\n(out / "metrics.json").write_text(json.dumps({"minimum": min(values), "samples": len(xs)}))\nprint("scan finished", len(xs), "samples")',
    parameters: { xs: [0, 1, 2, 3, 4] }, seeds: [7], inputs: [],
    acceptanceCriteria: [
      { id: 'minimum', kind: 'numeric', artifact: 'metrics.json', path: 'minimum', expected: 0, tolerance: 0 },
      { id: 'samples', kind: 'numeric', artifact: 'metrics.json', path: 'samples', expected: 5, tolerance: 0 }
    ],
    budget: { timeoutMs: 10000, maxArtifactBytes: 1048576, maxRuns: 10 }
  };
}
async function researchMutate(body, workspace) {
  if (researchMutationPending || !researchVisible(workspace)) return;
  researchMutationPending = true;
  const panel = el('projectResearchPanel');
  panel?.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const response = await api('/api/research', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, workspace })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Research request failed');
    if (researchVisible(workspace) && data.run) researchSelectedRun = data.run.id;
    if (researchVisible(workspace)) el('researchStatus').textContent = 'Saved';
  } catch (error) {
    if (researchVisible(workspace)) el('researchStatus').textContent = error?.message || 'Research request failed';
  } finally {
    researchMutationPending = false;
    panel?.querySelectorAll('button').forEach(button => { button.disabled = false; });
    if (researchVisible(workspace)) void refreshResearchPanel();
  }
}
function renderResearchRecords(data, workspace) {
  const host = el('researchRecords');
  if (!host) return;
  const expanded = new Set(Array.from(host.querySelectorAll('details[open]')).map(section => section.querySelector('summary')?.textContent));
  host.textContent = '';
  const runs = data.runs || [];
  const manifests = data.manifests || [];
  const active = runs.filter(run => ['queued', 'running', 'validating'].includes(run.status));
  host.append(researchText('p', manifests.length + ' experiments · ' + active.length + ' active · ' + runs.filter(run => run.status === 'passed').length + ' criteria passed · ' + runs.filter(run => ['failed', 'blocked', 'timed_out'].includes(run.status)).length + ' need attention'));
  const selected = runs.find(run => run.id === researchSelectedRun);
  if (selected) {
    host.append(researchButton('Back to experiments', () => { researchSelectedRun = null; renderResearchRecords(data, workspace); }));
    host.append(researchText('h3', 'Run ' + selected.id));
    host.append(researchText('p', 'State: ' + selected.status));
    if (selected.reason || selected.blockedReason || selected.error || selected.failure) host.append(researchText('p', selected.reason || selected.blockedReason || selected.error || JSON.stringify(selected.failure)));
    const controls = document.createElement('div');
    if (['queued', 'running', 'validating'].includes(selected.status)) {
      controls.append(researchButton('Cancel run', () => researchMutate({ action: 'cancel', id: selected.id }, workspace)));
    } else {
      controls.append(researchButton('Rerun pinned experiment', () => {
        if (!confirm('Execute the same pinned experiment in a fresh run? This uses the configured CodeAct backend and consumes its run budget.')) return;
        void researchMutate({ action: 'rerun', id: selected.id, confirmed: true, idempotencyKey: crypto.randomUUID() }, workspace);
      }));
    }
    host.append(controls);
    const manifest = manifests.find(item => item.id === selected.manifestId);
    host.append(researchJson('Execution and logs', selected.execution || selected));
    host.append(researchJson('Independent validation and metrics', selected.validation || { status: 'pending' }));
    host.append(researchJson('Artifact lineage and digests', selected.artifacts || []));
    host.append(researchJson('Immutable experiment manifest', manifest || { id: selected.manifestId }));
    host.append(researchJson('Complete run record', selected));
  } else {
    for (const manifest of manifests) {
      const card = document.createElement('section');
      card.style.cssText = 'border:1px solid var(--border);border-radius:10px;padding:14px;margin:10px 0';
      card.append(researchText('h3', manifest.title || manifest.id));
      card.append(researchText('p', manifest.objective || ''));
      card.append(researchButton('Run pinned experiment', () => {
        if (!confirm('Execute this pinned Python experiment with the configured CodeAct backend? Process mode is trusted code, not a sandbox.')) return;
        void researchMutate({ action: 'start', id: manifest.id, confirmed: true, idempotencyKey: crypto.randomUUID() }, workspace);
      }));
      const related = runs.filter(run => run.manifestId === manifest.id);
      for (const run of related) {
        const row = document.createElement('p');
        row.append(researchButton(run.status + ' · ' + run.id, () => { researchSelectedRun = run.id; renderResearchRecords(data, workspace); }));
        card.append(row);
      }
      card.append(researchJson('Pinned manifest', manifest));
      host.append(card);
    }
    if (!manifests.length) host.append(researchText('p', 'No experiments yet. Pin the tiny offline example below or provide your own manifest.'));
  }
  host.querySelectorAll('details').forEach(section => { section.open = expanded.has(section.querySelector('summary')?.textContent); });
}
async function refreshResearchPanel() {
  const workspace = state.snapshot?.workDir || '';
  if (!researchVisible(workspace)) { stopResearchPolling(); return; }
  if (researchPollTimer) clearTimeout(researchPollTimer);
  const generation = ++researchRequestGeneration;
  try {
    const response = await api('/api/research?workspace=' + encodeURIComponent(workspace));
    const data = await response.json();
    if (generation !== researchRequestGeneration || !researchVisible(workspace)) return;
    if (!response.ok) throw new Error(data.error || 'Could not read research records');
    renderResearchRecords(data, workspace);
  } catch (error) {
    if (generation === researchRequestGeneration && researchVisible(workspace)) el('researchStatus').textContent = error?.message || 'Could not read research records';
  } finally {
    if (generation === researchRequestGeneration && researchVisible(workspace)) researchPollTimer = setTimeout(refreshResearchPanel, 2000);
  }
}
function mountResearchPanel() {
  stopResearchPolling();
  const panel = el('projectResearchPanel');
  const workspace = state.snapshot?.workDir || '';
  if (!panel) return;
  if (researchWorkspace !== workspace) { researchSelectedRun = null; researchWorkspace = workspace; }
  panel.textContent = '';
  panel.style.cssText = 'padding:20px;overflow:auto;min-height:0';
  panel.append(researchText('h2', 'Research experiments'));
  panel.append(researchText('p', 'Pinned manifests → CodeAct → recorded artifacts → independent criteria checks. A passed check is not a scientific claim. Process mode runs trusted Python; use enforce/container for isolation.', 'muted'));
  const status = researchText('p', ''); status.id = 'researchStatus'; status.setAttribute('role', 'status'); panel.append(status);
  const records = document.createElement('div'); records.id = 'researchRecords'; panel.append(records);
  const editor = document.createElement('details'); editor.append(researchText('summary', 'New experiment manifest (JSON)'));
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'Experiment manifest JSON');
  textarea.style.cssText = 'width:100%;min-height:300px;font-family:monospace;margin:12px 0';
  textarea.value = researchDrafts.get(workspace) || JSON.stringify(researchExampleManifest(), null, 2);
  textarea.addEventListener('input', () => researchDrafts.set(workspace, textarea.value));
  editor.append(textarea, researchButton('Pin manifest and probe environment', () => {
    let manifest;
    try { manifest = JSON.parse(textarea.value); } catch { status.textContent = 'Enter valid manifest JSON'; return; }
    if (!confirm('Pin this manifest and run a metadata-only probe of the configured Python environment? Criteria cannot be edited afterward.')) return;
    void researchMutate({ action: 'create', manifest, confirmed: true }, workspace);
  }));
  panel.append(editor);
  void refreshResearchPanel();
}
`;
