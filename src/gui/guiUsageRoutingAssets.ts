export const usageRoutingConfigurationHeaderHtml = `
      <header class="region-header">
        <div class="region-titles">
          <h1>Configuration</h1>
          <p>Configure models, providers, and local API or CLI runtimes</p>
        </div>
        <div class="region-actions" role="tablist" aria-label="Configuration sections">
          <button type="button" id="configurationModelsTab" class="pill-btn active" role="tab" aria-selected="true">Models &amp; runtimes</button>
          <button type="button" id="configurationUsageTab" class="pill-btn" role="tab" aria-selected="false">Usage &amp; Routing</button>
          <button type="button" id="bridgeNewConfig" class="pill-btn primary">+ New config</button>
        </div>
      </header>
`;

export const usageRoutingConfigurationPageHtml = `
      <div class="region-body bridge-region-body configuration-usage-page" id="configurationUsagePage" hidden>
        <div id="configurationUsageSlot"></div>
      </div>
`;

export const usageRoutingHtml = `
      <section class="settings-panel" data-configuration-usage-panel>
        <h1>Usage &amp; Routing</h1>
        <p class="muted">One local control center for the token ledger, limits, managed API keys, Gateway Routes, and native CLI login status.</p>
        <div class="usage-routing-tabs" role="tablist" aria-label="Usage and routing pages">
          <button type="button" class="active" data-usage-routing-page-tab="overview">Overview</button>
          <button type="button" data-usage-routing-page-tab="ledger">Ledger</button>
          <button type="button" data-usage-routing-page-tab="limits">Limits</button>
          <button type="button" data-usage-routing-page-tab="keys">API Keys</button>
          <button type="button" data-usage-routing-page-tab="routes">Routes</button>
        </div>
        <div class="settings-group usage-filter-bar">
          <label>Range<select id="usageRange"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="0">All time</option></select></label>
          <label>Provider<input id="usageProviderFilter" autocomplete="off" placeholder="All providers"></label>
          <label>Model<input id="usageModelFilter" autocomplete="off" placeholder="All models"></label>
          <label>Status<select id="usageStatusFilter"><option value="">All statuses</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option><option value="cancelled">Cancelled</option></select></label>
          <button type="button" id="usageRoutingRefresh" class="secondary-btn">Refresh</button>
        </div>
        <p id="usageRoutingStatus" class="muted" role="status">Open this tab to load local usage and routing data.</p>

        <div class="usage-routing-page" data-usage-routing-page="overview">
          <div class="usage-kpis">
            <article><span>Requests</span><strong id="usageKpiRequests">—</strong></article>
            <article><span>Total tokens</span><strong id="usageKpiTokens">—</strong></article>
            <article><span>Cache read</span><strong id="usageKpiCache">—</strong></article>
            <article><span>Estimated cost</span><strong id="usageKpiCost">—</strong></article>
          </div>
          <div class="settings-group">
            <div class="settings-group-head"><div><h2>Token trend</h2><p class="muted">Daily totals under the active filter.</p></div></div>
            <svg id="usageTrendChart" class="usage-trend-chart" viewBox="0 0 720 220" role="img" aria-label="No usage trend data"><desc>Daily token usage trend.</desc></svg>
            <div id="usageTrendFallback" class="sr-only" aria-live="polite"></div>
          </div>
          <div class="settings-group"><h2>Provider breakdown</h2><div id="usageProviderBreakdown" class="settings-card-list compact"></div></div>
        </div>

        <div class="usage-routing-page" data-usage-routing-page="ledger" hidden>
          <div class="settings-group usage-table-wrap">
            <table class="usage-table"><thead><tr><th>Time</th><th>Source</th><th>Provider / route</th><th>Model</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th><th>Status</th></tr></thead><tbody id="usageLedgerBody"></tbody></table>
            <p id="usageLedgerEmpty" class="muted">No matching ledger entries.</p>
            <div class="settings-action-row"><button type="button" id="usageLedgerPrev" class="secondary-btn">Previous</button><span id="usageLedgerPage" class="muted">Page 1</span><button type="button" id="usageLedgerNext" class="secondary-btn">Next</button></div>
          </div>
        </div>

        <div class="usage-routing-page" data-usage-routing-page="limits" hidden>
          <div class="settings-group"><h2>Usage limits</h2><div id="usageBudgetList" class="settings-card-list"></div></div>
          <div class="settings-group"><h2>Add or update a limit</h2><div class="usage-admin-grid">
            <label>ID<input id="usageBudgetId" autocomplete="off" placeholder="budget.monthly"></label>
            <label>Scope<select id="usageBudgetScope"><option value="global">Global</option><option value="provider">Provider</option><option value="credential">Credential</option><option value="route">Route</option><option value="model">Model</option></select></label>
            <label>Scope ID<input id="usageBudgetScopeId" autocomplete="off" placeholder="Not used for global"></label>
            <label>Period<select id="usageBudgetPeriod"><option value="daily">Daily</option><option value="monthly" selected>Monthly</option><option value="lifetime">Lifetime</option></select></label>
            <label>Metric<select id="usageBudgetMetric"><option value="totalTokens">Tokens</option><option value="requests">Requests</option><option value="costUsd">USD cost</option></select></label>
            <label>Limit<input id="usageBudgetLimit" type="number" min="0" step="any" value="1000000"></label>
            <label>Action<select id="usageBudgetAction"><option value="warn">Warn</option><option value="deny">Deny</option><option value="fallbackRoute">Fallback route</option></select></label>
            <label>Fallback route ID<input id="usageBudgetFallback" autocomplete="off"></label>
          </div><div class="settings-action-row"><button type="button" id="usageBudgetSave" class="primary">Save limit</button></div></div>
        </div>

        <div class="usage-routing-page" data-usage-routing-page="keys" hidden>
          <div class="settings-group"><h2>Volcengine Ark Agent Plan</h2><p class="muted">Save the key in Hadamard's encrypted local Keyway store and add ready-to-use glm-5.2 and glm-5.3 routes. Nothing is written to Codex or an environment variable.</p><div class="usage-admin-grid">
            <label class="usage-wide">Ark API key<input id="usageArkAgentPlanSecret" type="password" autocomplete="new-password" placeholder="Stored write-only in Hadamard"></label>
          </div><div class="settings-action-row"><button type="button" id="usageArkAgentPlanInstall" class="primary">Install / rotate Ark models</button></div></div>
          <div class="settings-group"><h2>Managed API credentials</h2><p class="muted">Secrets are write-only and encrypted by the desktop host. Native CLI OAuth/session data is never imported here.</p><div id="usageCredentialList" class="settings-card-list"></div></div>
          <div class="settings-group"><h2>Add or rotate a credential</h2><div class="usage-admin-grid">
            <label>ID<input id="usageCredentialId" autocomplete="off" placeholder="credential.ark.primary"></label>
            <label>Provider ID<input id="usageCredentialProvider" autocomplete="off" placeholder="ark"></label>
            <label>Label<input id="usageCredentialLabel" autocomplete="off" placeholder="Primary"></label>
            <label>Priority<input id="usageCredentialPriority" type="number" min="0" value="0"></label>
            <label>Weight<input id="usageCredentialWeight" type="number" min="1" value="1"></label>
            <label>New secret<input id="usageCredentialSecret" type="password" autocomplete="new-password" placeholder="Leave blank to keep existing"></label>
          </div><div class="settings-action-row"><button type="button" id="usageCredentialSave" class="primary">Save credential</button></div></div>
          <div class="settings-group"><h2>Migration</h2><p class="muted">Preview first. Bridge API keys are copied into write-only storage only on Apply; native CLI OAuth/session secrets are never read. KeywayExportV1 files contain metadata and usage, not secrets.</p>
            <div class="settings-action-row"><button type="button" id="usageBridgeMigrationPreview" class="secondary-btn">Preview bridge configs</button><button type="button" id="usageBridgeMigrationApply" class="secondary-btn">Apply ready configs</button></div>
            <label class="inline-field">KeywayExportV1 file<input id="usagePortableMigrationFile" autocomplete="off" placeholder="C:\\path\\to\\keyway-export-v1.json"></label>
            <div class="settings-action-row"><button type="button" id="usagePortableMigrationPreview" class="secondary-btn">Preview file</button><button type="button" id="usagePortableMigrationApply" class="secondary-btn">Import transactionally</button></div>
          </div>
        </div>

        <div class="usage-routing-page" data-usage-routing-page="routes" hidden>
          <div class="settings-group"><h2>Authenticated loopback gateway</h2><p id="usageGatewayStatus" class="muted">Stopped. Embedded in-process routing remains available.</p><div class="settings-action-row"><button type="button" id="usageGatewayStart" class="secondary-btn">Start</button><button type="button" id="usageGatewayStop" class="secondary-btn">Stop</button></div><p class="muted">Binds to 127.0.0.1 only. A client key is shown once after startup and is never returned by status.</p></div>
          <div class="settings-group"><h2>Execution targets</h2><div id="usageTargetList" class="settings-card-list"></div></div>
          <div class="settings-group"><h2>Add or update a target</h2><div class="usage-admin-grid">
            <label>ID<input id="usageTargetId" autocomplete="off" placeholder="target.ark"></label>
            <label>Kind<select id="usageTargetKind"><option value="managed-api">Managed API</option><option value="native-cli">Native CLI login</option></select></label>
            <label>Provider / runtime<input id="usageTargetProvider" autocomplete="off" placeholder="ark or claude"></label>
            <label>Protocol<select id="usageTargetProtocol"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
            <label>Base URL / profile<input id="usageTargetLocation" autocomplete="off" placeholder="https://api.example.com/v1"></label>
          </div><div class="settings-action-row"><button type="button" id="usageTargetSave" class="primary">Save target</button></div></div>
          <div class="settings-group"><h2>Gateway Routes</h2><div id="usageRouteList" class="settings-card-list"></div></div>
          <div class="settings-group"><h2>Add or update a route</h2><div class="usage-admin-grid">
            <label>ID<input id="usageRouteId" autocomplete="off" placeholder="route.chat"></label>
            <label>Alias<input id="usageRouteAlias" autocomplete="off" placeholder="chat-default"></label>
            <label>Mode<select id="usageRouteMode"><option value="direct">Direct</option><option value="priority-failover">Priority failover</option></select></label>
            <label class="usage-wide">Candidates<textarea id="usageRouteCandidates" rows="4" placeholder="target.ark | glm-5.2 | 0&#10;target.backup | glm-5.3 | 1"></textarea><small>One per line: target ID | upstream model | priority</small></label>
          </div><div class="settings-action-row"><button type="button" id="usageRouteSave" class="primary">Save route</button></div></div>
        </div>
      </section>
`;

export const usageRoutingStyles = `
.usage-routing-tabs { display: flex; gap: 4px; margin: 18px 0 0; padding-bottom: 10px; overflow-x: auto; border-bottom: 1px solid var(--border); }
.configuration-usage-page { justify-content: center; }
.configuration-usage-page[hidden], #configurationModelsPage[hidden] { display: none !important; }
.configuration-usage-page .settings-panel { display: block !important; width: min(960px, 100%); max-width: 960px; }
.configuration-usage-page .settings-panel > h1 { margin-top: 2px; }
.usage-routing-tabs button { flex: 0 0 auto; border: 0; border-radius: 8px; min-height: 32px; padding: 0 12px; background: transparent; color: var(--text-2); cursor: pointer; }
.usage-routing-tabs button.active { background: color-mix(in srgb, var(--text-1) 10%, transparent); color: var(--text-1); font-weight: 600; }
.usage-routing-page[hidden] { display: none; }
.usage-filter-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; align-items: end; gap: 10px; }
.usage-filter-bar label, .usage-admin-grid label { display: grid; gap: 5px; color: var(--text-2); font-size: 11.5px; }
.usage-filter-bar input, .usage-filter-bar select, .usage-admin-grid input, .usage-admin-grid select, .usage-admin-grid textarea {
  width: 100%; min-width: 0; min-height: 34px; border: 1px solid var(--border-hover); border-radius: 8px; padding: 6px 9px; background: var(--bg-surface); color: var(--text-1); font: inherit;
}
.usage-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding-top: 18px; }
.usage-kpis article { min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); }
.usage-kpis span { display: block; color: var(--text-2); font-size: 11.5px; }
.usage-kpis strong { display: block; margin-top: 8px; overflow-wrap: anywhere; font-size: 20px; font-variant-numeric: tabular-nums; }
.usage-trend-chart { width: 100%; height: 220px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); }
.usage-trend-chart .grid { stroke: var(--border); stroke-width: 1; }
.usage-trend-chart .area { fill: color-mix(in srgb, var(--brand) 14%, transparent); }
.usage-trend-chart .line { fill: none; stroke: var(--brand); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.usage-table-wrap { overflow-x: auto; }
.usage-table { width: 100%; min-width: 860px; border-collapse: collapse; font-size: 11.5px; }
.usage-table th, .usage-table td { padding: 9px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.usage-table th { color: var(--text-2); font-weight: 600; }
.usage-table td { font-variant-numeric: tabular-nums; }
.usage-admin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.usage-admin-grid .usage-wide { grid-column: 1 / -1; }
.usage-admin-grid textarea { resize: vertical; min-height: 88px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.usage-admin-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; align-items: center; }
.usage-admin-card small { overflow-wrap: anywhere; }
.usage-admin-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.usage-admin-actions button { min-height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-surface); color: var(--text-1); cursor: pointer; }
.usage-admin-actions button.danger { color: var(--err); }
.sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; white-space: nowrap !important; border: 0 !important; }
@media (max-width: 760px) {
  .usage-filter-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-admin-grid { grid-template-columns: 1fr; }
  .usage-admin-grid .usage-wide { grid-column: auto; }
}
`;

export const usageRoutingClient = `
let usageRoutingActivePage = 'overview';
let usageLedgerOffset = 0;
const USAGE_LEDGER_PAGE_SIZE = 50;

function compactUsageNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { notation: number >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
}

function usageFilterSearch(includePage) {
  const search = new URLSearchParams();
  const days = Number(el('usageRange')?.value || 0);
  if (days > 0) search.set('from', new Date(Date.now() - days * 86400000).toISOString());
  const provider = el('usageProviderFilter')?.value.trim();
  const model = el('usageModelFilter')?.value.trim();
  const status = el('usageStatusFilter')?.value;
  if (provider) search.set('providerId', provider);
  if (model) search.set('model', model);
  if (status) search.set('status', status);
  if (includePage) {
    search.set('limit', String(USAGE_LEDGER_PAGE_SIZE));
    search.set('offset', String(usageLedgerOffset));
  }
  return search.toString();
}

async function usageRoutingJson(path, options) {
  const response = await api(path, options || {});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Usage & Routing is unavailable.');
  return payload;
}

function renderUsageTrend(points) {
  const svg = el('usageTrendChart');
  const fallback = el('usageTrendFallback');
  if (!svg) return;
  const ns = 'http://www.w3.org/2000/svg';
  const desc = document.createElementNS(ns, 'desc');
  desc.textContent = 'Daily total token usage under the active filters.';
  svg.replaceChildren(desc);
  if (!Array.isArray(points) || points.length === 0) {
    svg.setAttribute('aria-label', 'No token trend data for the active filter');
    if (fallback) fallback.textContent = 'No token trend data for the active filter.';
    return;
  }
  const width = 720;
  const height = 220;
  const pad = 28;
  const max = Math.max(1, ...points.map(point => Number(point.tokens || 0)));
  for (let index = 0; index < 5; index += 1) {
    const y = pad + ((height - pad * 2) * index / 4);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(pad)); line.setAttribute('x2', String(width - pad));
    line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('class', 'grid');
    svg.appendChild(line);
  }
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : pad + ((width - pad * 2) * index / (points.length - 1));
    const y = height - pad - ((height - pad * 2) * Number(point.tokens || 0) / max);
    return [x, y];
  });
  const linePath = coordinates.map((point, index) => (index ? 'L' : 'M') + point[0] + ' ' + point[1]).join(' ');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', linePath + ' L ' + coordinates.at(-1)[0] + ' ' + (height - pad) + ' L ' + coordinates[0][0] + ' ' + (height - pad) + ' Z');
  area.setAttribute('class', 'area');
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', linePath); line.setAttribute('class', 'line');
  svg.append(area, line);
  const summary = points.map(point => point.date + ': ' + compactUsageNumber(point.tokens) + ' tokens').join('; ');
  svg.setAttribute('aria-label', summary);
  if (fallback) fallback.textContent = summary;
}

function renderUsageOverview(payload) {
  const summary = payload.summary || {};
  el('usageKpiRequests').textContent = compactUsageNumber(summary.requests);
  el('usageKpiTokens').textContent = compactUsageNumber(summary.totalTokens);
  el('usageKpiCache').textContent = compactUsageNumber(summary.cacheReadTokens);
  el('usageKpiCost').textContent = '$' + Number(summary.costUsd || 0).toFixed(4);
  renderUsageTrend(payload.trend || []);
  const list = el('usageProviderBreakdown');
  list.replaceChildren();
  for (const item of payload.byProvider || []) {
    const card = document.createElement('div');
    card.className = 'settings-help-row';
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = item.key;
    const small = document.createElement('small');
    small.textContent = compactUsageNumber(item.tokens) + ' tokens · ' + compactUsageNumber(item.requests) + ' requests · $' + Number(item.costUsd || 0).toFixed(4);
    text.append(strong, small); card.append(text); list.append(card);
  }
  if (!list.childElementCount) list.textContent = 'No provider-attributed usage.';
}

function renderUsageLedger(payload) {
  const body = el('usageLedgerBody');
  body.replaceChildren();
  for (const event of payload.events || []) {
    const row = document.createElement('tr');
    const values = [
      new Date(event.timestamp).toLocaleString(),
      event.source,
      [event.providerId, event.routeAlias || event.routeId].filter(Boolean).join(' / ') || '—',
      event.resolvedModel || event.requestedModel,
      compactUsageNumber(event.usage?.inputTokens),
      compactUsageNumber(event.usage?.outputTokens),
      compactUsageNumber((event.usage?.cacheReadTokens || 0) + (event.usage?.cacheWriteTokens || 0)),
      event.usage?.costUsd === undefined ? 'Unpriced' : '$' + Number(event.usage.costUsd).toFixed(4),
      event.status,
    ];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value ?? ''); row.append(cell); }
    body.append(row);
  }
  el('usageLedgerEmpty').hidden = body.childElementCount > 0;
  el('usageLedgerPage').textContent = 'Page ' + (Math.floor(usageLedgerOffset / USAGE_LEDGER_PAGE_SIZE) + 1);
  el('usageLedgerPrev').disabled = usageLedgerOffset === 0;
  el('usageLedgerNext').disabled = (payload.events || []).length < USAGE_LEDGER_PAGE_SIZE;
}

function usageAdminCard(title, detail, actions) {
  const card = document.createElement('div');
  card.className = 'settings-help-row usage-admin-card';
  const text = document.createElement('span');
  const strong = document.createElement('strong'); strong.textContent = title;
  const small = document.createElement('small'); small.textContent = detail;
  text.append(strong, small);
  const actionBox = document.createElement('span'); actionBox.className = 'usage-admin-actions';
  for (const action of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
    if (action.danger) button.classList.add('danger');
    button.addEventListener('click', () => {
      Promise.resolve().then(action.run).catch(error => { el('usageRoutingStatus').textContent = error.message || String(error); });
    });
    actionBox.append(button);
  }
  card.append(text, actionBox);
  return card;
}

async function usageMutation(path, method, body) {
  const status = el('usageRoutingStatus');
  status.textContent = 'Saving...';
  await usageRoutingJson(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  status.textContent = 'Saved locally.';
  await refreshUsageRouting();
}

function renderUsageCatalog(catalog) {
  const gateway = catalog.gateway || {};
  const gatewayStatus = el('usageGatewayStatus');
  if (gatewayStatus) gatewayStatus.textContent = gateway.running
    ? 'Running at ' + String(gateway.url || 'unknown') + ' · ' + String(gateway.authentication || 'client-key')
    : 'Stopped. Embedded in-process routing remains available.';
  const budgets = el('usageBudgetList'); budgets.replaceChildren();
  for (const budget of catalog.budgets || []) {
    const scope = budget.scope?.kind === 'global' ? 'global' : budget.scope?.kind + ':' + budget.scope?.id;
    budgets.append(usageAdminCard(budget.id, scope + ' · ' + budget.period + ' · ' + budget.metric + ' ' + budget.limit + ' · ' + budget.action + (budget.enabled ? '' : ' · disabled'), [
      { label: 'Delete', danger: true, run: () => void usageMutation('/api/usage-routing/budgets/' + encodeURIComponent(budget.id), 'DELETE') },
    ]));
  }
  if (!budgets.childElementCount) budgets.textContent = 'No usage limits configured.';

  const credentials = el('usageCredentialList'); credentials.replaceChildren();
  for (const credential of catalog.credentials || []) {
    const health = credential.health?.state || (credential.secretConfigured ? 'configured' : 'missing');
    credentials.append(usageAdminCard(credential.label || credential.id, credential.providerId + ' · priority ' + credential.priority + ' · ' + health, [
      { label: 'Edit', run: () => { el('usageCredentialId').value = credential.id; el('usageCredentialProvider').value = credential.providerId; el('usageCredentialLabel').value = credential.label || ''; el('usageCredentialPriority').value = String(credential.priority); el('usageCredentialWeight').value = String(credential.weight); } },
      { label: 'Test', run: async () => { const result = await usageRoutingJson('/api/usage-routing/credentials/' + encodeURIComponent(credential.id) + '/test', { method: 'POST' }); el('usageRoutingStatus').textContent = credential.id + ': ' + result.state; await refreshUsageRouting(); } },
      { label: 'Delete', danger: true, run: () => void usageMutation('/api/usage-routing/credentials/' + encodeURIComponent(credential.id), 'DELETE') },
    ]));
  }
  if (!credentials.childElementCount) credentials.textContent = 'No managed API credentials. Native CLI logins appear under targets.';

  const targets = el('usageTargetList'); targets.replaceChildren();
  for (const target of catalog.targets || []) {
    const detail = target.kind === 'managed-api'
      ? target.providerId + ' · ' + target.protocol + ' · ' + target.baseUrl
      : target.runtime + ' · native login' + (target.profileName ? ' · ' + target.profileName : '');
    targets.append(usageAdminCard(target.id, detail, [
      { label: 'Edit', run: () => { el('usageTargetId').value = target.id; el('usageTargetKind').value = target.kind; el('usageTargetProvider').value = target.kind === 'managed-api' ? target.providerId : target.runtime; el('usageTargetProtocol').value = target.protocol || 'openai'; el('usageTargetLocation').value = target.kind === 'managed-api' ? target.baseUrl : (target.profileName || ''); } },
      { label: 'Test', run: async () => { const result = await usageRoutingJson('/api/usage-routing/targets/' + encodeURIComponent(target.id) + '/test', { method: 'POST' }); el('usageRoutingStatus').textContent = target.id + ': ' + (result.state || 'configured'); } },
      { label: 'Delete', danger: true, run: () => void usageMutation('/api/usage-routing/targets/' + encodeURIComponent(target.id), 'DELETE') },
    ]));
  }
  if (!targets.childElementCount) targets.textContent = 'No execution targets configured.';

  const routes = el('usageRouteList'); routes.replaceChildren();
  for (const route of catalog.routes || []) {
    const candidates = (route.candidates || []).map(candidate => candidate.targetId + ' → ' + candidate.upstreamModel + ' (p' + candidate.priority + ')').join(', ');
    routes.append(usageAdminCard(route.alias, route.mode + ' · ' + candidates, [
      { label: 'Use in Hadamard', run: async () => { const selected = await usageRoutingJson('/api/usage-routing/routes/' + encodeURIComponent(route.alias) + '/activate', { method: 'POST' }); el('usageRoutingStatus').textContent = 'Hadamard now uses ' + selected.routeAlias + ' (' + selected.model + ').'; } },
      { label: 'Edit', run: () => { el('usageRouteId').value = route.id; el('usageRouteAlias').value = route.alias; el('usageRouteMode').value = route.mode; el('usageRouteCandidates').value = (route.candidates || []).map(candidate => candidate.targetId + ' | ' + candidate.upstreamModel + ' | ' + candidate.priority).join('\\n'); } },
      { label: 'Delete', danger: true, run: () => void usageMutation('/api/usage-routing/routes/' + encodeURIComponent(route.id), 'DELETE') },
    ]));
  }
  if (!routes.childElementCount) routes.textContent = 'No Gateway Routes configured.';
}

async function refreshUsageRouting() {
  const status = el('usageRoutingStatus');
  if (!status) return;
  status.textContent = 'Loading local usage and routing data...';
  try {
    const query = usageFilterSearch(false);
    const tasks = [usageRoutingJson('/api/usage-routing/catalog')];
    if (usageRoutingActivePage === 'overview') tasks.push(usageRoutingJson('/api/usage-routing/overview?' + query));
    if (usageRoutingActivePage === 'ledger') tasks.push(usageRoutingJson('/api/usage-routing/ledger?' + usageFilterSearch(true)));
    const results = await Promise.all(tasks);
    renderUsageCatalog(results[0]);
    if (usageRoutingActivePage === 'overview') renderUsageOverview(results[1]);
    if (usageRoutingActivePage === 'ledger') renderUsageLedger(results[1]);
    status.textContent = 'Local data refreshed. Secrets and prompts are excluded from this view.';
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

function showUsageRoutingPage(page) {
  usageRoutingActivePage = ['overview', 'ledger', 'limits', 'keys', 'routes'].includes(page) ? page : 'overview';
  document.querySelectorAll('[data-usage-routing-page-tab]').forEach(button => button.classList.toggle('active', button.dataset.usageRoutingPageTab === usageRoutingActivePage));
  document.querySelectorAll('[data-usage-routing-page]').forEach(panel => { panel.hidden = panel.dataset.usageRoutingPage !== usageRoutingActivePage; });
  void refreshUsageRouting();
}

function showConfigurationPage(page) {
  const usage = page === 'usage';
  el('configurationModelsPage').hidden = usage;
  el('configurationUsagePage').hidden = !usage;
  el('bridgeNewConfig').hidden = usage;
  el('configurationModelsTab').classList.toggle('active', !usage);
  el('configurationUsageTab').classList.toggle('active', usage);
  el('configurationModelsTab').setAttribute('aria-selected', usage ? 'false' : 'true');
  el('configurationUsageTab').setAttribute('aria-selected', usage ? 'true' : 'false');
  if (usage) void refreshUsageRouting();
}

`;

export const usageRoutingBindings = `
const usageRoutingPanel = document.querySelector('[data-configuration-usage-panel]');
if (usageRoutingPanel && el('configurationUsageSlot')) el('configurationUsageSlot').appendChild(usageRoutingPanel);
el('configurationModelsTab')?.addEventListener('click', () => showConfigurationPage('models'));
el('configurationUsageTab')?.addEventListener('click', () => showConfigurationPage('usage'));
document.querySelectorAll('[data-usage-routing-page-tab]').forEach(button => button.addEventListener('click', () => showUsageRoutingPage(button.dataset.usageRoutingPageTab)));
el('usageRoutingRefresh')?.addEventListener('click', () => { usageLedgerOffset = 0; void refreshUsageRouting(); });
for (const id of ['usageRange', 'usageProviderFilter', 'usageModelFilter', 'usageStatusFilter']) {
  el(id)?.addEventListener('change', () => { usageLedgerOffset = 0; void refreshUsageRouting(); });
}
el('usageLedgerPrev')?.addEventListener('click', () => { usageLedgerOffset = Math.max(0, usageLedgerOffset - USAGE_LEDGER_PAGE_SIZE); void refreshUsageRouting(); });
el('usageLedgerNext')?.addEventListener('click', () => { usageLedgerOffset += USAGE_LEDGER_PAGE_SIZE; void refreshUsageRouting(); });
el('usageBudgetSave')?.addEventListener('click', () => {
  const scopeKind = el('usageBudgetScope').value;
  void usageMutation('/api/usage-routing/budgets', 'PUT', {
    id: el('usageBudgetId').value.trim(),
    scopeKind,
    ...(scopeKind === 'global' ? {} : { scopeId: el('usageBudgetScopeId').value.trim() }),
    period: el('usageBudgetPeriod').value,
    metric: el('usageBudgetMetric').value,
    limit: Number(el('usageBudgetLimit').value),
    action: el('usageBudgetAction').value,
    fallbackRouteId: el('usageBudgetFallback').value.trim(),
    enabled: true,
  }).catch(error => { el('usageRoutingStatus').textContent = error.message || String(error); });
});
el('usageCredentialSave')?.addEventListener('click', () => {
  const secretInput = el('usageCredentialSecret');
  const secret = secretInput.value;
  secretInput.value = '';
  void usageMutation('/api/usage-routing/credentials', 'PUT', {
    id: el('usageCredentialId').value.trim(),
    providerId: el('usageCredentialProvider').value.trim(),
    label: el('usageCredentialLabel').value.trim(),
    priority: Number(el('usageCredentialPriority').value),
    weight: Number(el('usageCredentialWeight').value),
    ...(secret ? { secret } : {}),
    enabled: true,
  }).catch(error => { el('usageRoutingStatus').textContent = error.message || String(error); });
});
el('usageArkAgentPlanInstall')?.addEventListener('click', async () => {
  const secretInput = el('usageArkAgentPlanSecret');
  const secret = secretInput.value;
  secretInput.value = '';
  if (!secret) { el('usageRoutingStatus').textContent = 'Enter the Ark Agent Plan API key.'; return; }
  try {
    const result = await usageRoutingJson('/api/usage-routing/presets/ark-agent-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    await refreshUsageRouting();
    el('usageRoutingStatus').textContent = 'Ark models installed in Hadamard: ' + result.routeAliases.join(', ') + '. Select Routes → Use in Hadamard.';
  } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
});
el('usageBridgeMigrationPreview')?.addEventListener('click', async () => {
  try {
    const result = await usageRoutingJson('/api/usage-routing/migration/bridge');
    el('usageRoutingStatus').textContent = 'Bridge migration preview: ' + result.ready + ' ready, ' + result.blocked + ' blocked. Native OAuth/session secrets read: no.';
  } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
});
el('usageBridgeMigrationApply')?.addEventListener('click', async () => {
  try {
    const result = await usageRoutingJson('/api/usage-routing/migration/bridge', { method: 'POST' });
    await refreshUsageRouting();
    el('usageRoutingStatus').textContent = 'Bridge migration: ' + result.imported + ' imported, ' + result.skipped + ' skipped. Legacy configs remain unchanged.';
  } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
});
for (const action of ['Preview', 'Apply']) {
  el('usagePortableMigration' + action)?.addEventListener('click', async () => {
    const filePath = el('usagePortableMigrationFile').value.trim();
    try {
      const result = await usageRoutingJson('/api/usage-routing/migration/portable/' + (action === 'Preview' ? 'preview' : 'import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (action === 'Apply') await refreshUsageRouting();
      el('usageRoutingStatus').textContent = (action === 'Preview' ? 'Import preview: ' : 'Import complete: ') + JSON.stringify(result);
    } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
  });
}
el('usageGatewayStart')?.addEventListener('click', async () => {
  try {
    const result = await usageRoutingJson('/api/usage-routing/gateway/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 0 }),
    });
    await refreshUsageRouting();
    el('usageRoutingStatus').textContent = result.clientKey
      ? 'Gateway started at ' + result.url + '. Client key (shown once): ' + result.clientKey
      : 'Gateway is already running at ' + result.url + '.';
  } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
});
el('usageGatewayStop')?.addEventListener('click', async () => {
  try {
    await usageRoutingJson('/api/usage-routing/gateway/stop', { method: 'POST' });
    await refreshUsageRouting();
    el('usageRoutingStatus').textContent = 'Loopback gateway stopped.';
  } catch (error) { el('usageRoutingStatus').textContent = error.message || String(error); }
});
el('usageTargetSave')?.addEventListener('click', () => {
  const kind = el('usageTargetKind').value;
  const provider = el('usageTargetProvider').value.trim();
  const location = el('usageTargetLocation').value.trim();
  const body = kind === 'managed-api'
    ? { id: el('usageTargetId').value.trim(), kind, providerId: provider, protocol: el('usageTargetProtocol').value, baseUrl: location, enabled: true }
    : { id: el('usageTargetId').value.trim(), kind, runtime: provider, ...(location ? { profileName: location } : {}), enabled: true };
  void usageMutation('/api/usage-routing/targets', 'PUT', body).catch(error => { el('usageRoutingStatus').textContent = error.message || String(error); });
});
el('usageRouteSave')?.addEventListener('click', () => {
  const routeId = el('usageRouteId').value.trim();
  const candidates = el('usageRouteCandidates').value.split(/\\r?\\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const parts = line.split('|').map(part => part.trim());
    return { id: routeId + '.candidate.' + (index + 1), targetId: parts[0], upstreamModel: parts[1], priority: Number(parts[2] || index), weight: 1, enabled: true };
  });
  void usageMutation('/api/usage-routing/routes', 'PUT', {
    id: routeId,
    alias: el('usageRouteAlias').value.trim(),
    mode: el('usageRouteMode').value,
    candidates,
    enabled: true,
  }).catch(error => { el('usageRoutingStatus').textContent = error.message || String(error); });
});
`;
