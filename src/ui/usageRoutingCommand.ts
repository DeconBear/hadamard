import type { UsageFilter } from '../usage/contracts.js';
import type { UsageRoutingAdminService } from '../keyway/usageRoutingAdminService.js';

export type UsageRoutingCommandAdminPort = Pick<UsageRoutingAdminService,
  | 'overview' | 'catalog' | 'saveBudget' | 'deleteBudget'
  | 'saveCredential' | 'testCredential'
  | 'saveRoute' | 'testTarget'>;

export interface UsageRoutingCommandPort {
  admin(): Promise<UsageRoutingCommandAdminPort>;
  promptSecret?(label: string): Promise<string | undefined>;
}

/** Shared GUI/TUI command behavior; presentation layers only render returned lines. */
export async function runUsageRoutingCommand(
  name: string,
  args: string,
  port: UsageRoutingCommandPort,
): Promise<string[] | undefined> {
  if (!['usage', 'limits', 'keys', 'routes', 'gateway'].includes(name)) return undefined;
  const admin = await port.admin();
  const words = tokenize(args);
  if (name === 'usage') return usageLines(admin, words);
  if (name === 'limits') return limitsLines(admin, words);
  if (name === 'keys') return keysLines(admin, words, port);
  if (name === 'routes') return routesLines(admin, words);
  return gatewayLines(admin, words);
}

async function usageLines(admin: UsageRoutingCommandAdminPort, words: string[]): Promise<string[]> {
  const filter: UsageFilter = {};
  const range = words[0] && !words[0].startsWith('--') ? words.shift() : 'today';
  if (range === 'today') filter.from = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  else if (range === '7d' || range === '30d') filter.from = new Date(Date.now() - Number(range.slice(0, -1)) * 86400000).toISOString();
  else if (range !== 'all') throw new TypeError('Usage range must be today, 7d, 30d, or all.');
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '--provider' && words[index + 1]) filter.providerId = words[++index];
    else if (words[index] === '--model' && words[index + 1]) filter.model = words[++index];
  }
  const overview = admin.overview(filter);
  return [
    `Usage (${range})`,
    `  requests  ${overview.summary.requests.toLocaleString()}`,
    `  tokens    ${overview.summary.totalTokens.toLocaleString()} (${overview.summary.inputTokens.toLocaleString()} in / ${overview.summary.outputTokens.toLocaleString()} out)`,
    `  cache     ${overview.summary.cacheReadTokens.toLocaleString()} read / ${overview.summary.cacheWriteTokens.toLocaleString()} write`,
    `  cost      $${(overview.summary.costUsd ?? 0).toFixed(4)}`,
    `  quality   ${overview.unknownUsageEntries} unknown entries`,
  ];
}

async function limitsLines(admin: UsageRoutingCommandAdminPort, words: string[]): Promise<string[]> {
  const action = words.shift() || 'list';
  if (action === 'list') {
    const budgets = (await admin.catalog()).budgets;
    return budgets.length
      ? ['Usage limits', ...budgets.map(policy => `  ${policy.id}  ${scopeLabel(policy.scope)} · ${policy.period} · ${policy.metric} ${policy.limit} · ${policy.action}${policy.enabled ? '' : ' · disabled'}`)]
      : ['Usage limits', '  (none)'];
  }
  if (action === 'remove') {
    const id = required(words.shift(), 'limit id');
    return [`Limit ${id}: ${admin.deleteBudget(id) ? 'removed' : 'not found'}`];
  }
  if (action !== 'set') throw new TypeError('Usage: /limits list|set|remove');
  const id = required(words.shift(), 'limit id');
  const scopeWord = required(words.shift(), 'scope (global or kind:id)');
  const [scopeKind, scopeId] = scopeWord.split(':', 2);
  const period = required(words.shift(), 'period');
  const metric = required(words.shift(), 'metric');
  const limit = Number(required(words.shift(), 'limit'));
  const budgetAction = required(words.shift(), 'action');
  admin.saveBudget({
    id,
    scopeKind,
    ...(scopeId ? { scopeId } : {}),
    period,
    metric,
    limit,
    action: budgetAction,
    ...(budgetAction === 'fallbackRoute' ? { fallbackRouteId: required(words.shift(), 'fallback route id') } : {}),
    enabled: true,
  });
  return [`Limit ${id}: saved`];
}

async function keysLines(
  admin: UsageRoutingCommandAdminPort,
  words: string[],
  port: UsageRoutingCommandPort,
): Promise<string[]> {
  const action = words.shift() || 'list';
  const catalog = await admin.catalog();
  if (action === 'list') {
    return catalog.credentials.length
      ? ['Managed API credentials', ...catalog.credentials.map(credential => `  ${credential.id}  ${credential.providerId} · ${credential.health?.state ?? (credential.secretConfigured ? 'configured' : 'missing')} · priority ${credential.priority}`)]
      : ['Managed API credentials', '  (none; native CLI OAuth remains managed by each CLI)'];
  }
  const id = required(words.shift(), 'credential id');
  const existing = catalog.credentials.find(item => item.id === id);
  if (action === 'test') {
    const result = await admin.testCredential(id);
    return [`Credential ${id}: ${String(result.state)}${result.tested === false ? ' (configuration only)' : ''}`];
  }
  if (action === 'disable') {
    if (!existing) throw new TypeError('Credential not found.');
    await admin.saveCredential({ ...existing, id, providerId: existing.providerId, enabled: false });
    return [`Credential ${id}: disabled`];
  }
  if (action !== 'add' && action !== 'rotate') throw new TypeError('Usage: /keys list|add|disable|rotate|test');
  if (!port.promptSecret) throw new TypeError('Use Configuration → Usage & Routing → API Keys to save a write-only secret.');
  const providerId = action === 'rotate'
    ? required(existing?.providerId, 'existing credential')
    : required(words.shift(), 'provider id');
  const secret = await port.promptSecret(`Secret for ${id}`);
  if (!secret) return [`Credential ${id}: unchanged`];
  await admin.saveCredential({
    ...(existing ?? {}),
    id,
    providerId,
    label: words.join(' ') || existing?.label || id,
    secret,
    enabled: true,
  });
  return [`Credential ${id}: ${action === 'rotate' ? 'rotated' : 'saved'} (write-only)`];
}

async function routesLines(admin: UsageRoutingCommandAdminPort, words: string[]): Promise<string[]> {
  const action = words.shift() || 'list';
  const catalog = await admin.catalog();
  if (action === 'list') {
    return catalog.routes.length
      ? ['Gateway Routes', ...catalog.routes.map(route => `  ${route.alias}  ${route.mode} · ${route.candidates.length} candidate(s)${route.enabled ? '' : ' · disabled'}`)]
      : ['Gateway Routes', '  (none)'];
  }
  const reference = required(words.shift(), 'route id or alias');
  const route = catalog.routes.find(item => item.id === reference || item.alias === reference);
  if (!route) throw new TypeError('Route not found.');
  if (action === 'show') return [
    `${route.alias} (${route.id})`,
    `  mode  ${route.mode}`,
    ...route.candidates.map(item => `  ${item.targetId} → ${item.upstreamModel} · priority ${item.priority}${item.enabled ? '' : ' · disabled'}`),
  ];
  if (action === 'enable') {
    await admin.saveRoute({ ...route, enabled: true });
    return [`Route ${route.alias}: enabled`];
  }
  if (action === 'test') {
    const candidate = route.candidates.find(item => item.enabled) ?? route.candidates[0];
    if (!candidate) throw new TypeError('Route has no candidate.');
    const target = catalog.targets.find(item => item.id === candidate.targetId);
    if (!target) throw new TypeError('Route target not found.');
    if (target.kind === 'native-cli') {
      const result = await admin.testTarget(target.id);
      return [`Route ${route.alias}: ${String(result.state ?? 'unknown')} (${target.runtime} native login)`];
    }
    const credential = catalog.credentials.find(item => item.providerId === target.providerId && item.enabled);
    if (!credential) return [`Route ${route.alias}: no enabled credential for ${target.providerId}`];
    const result = await admin.testCredential(credential.id);
    return [`Route ${route.alias}: ${String(result.state)} via ${target.providerId}`];
  }
  throw new TypeError('Usage: /routes list|show|test|enable');
}

async function gatewayLines(admin: UsageRoutingCommandAdminPort, words: string[]): Promise<string[]> {
  const action = words.shift() || 'status';
  const catalog = await admin.catalog();
  if (action === 'status') return [
    'Embedded Keyway gateway',
    `  targets      ${catalog.targets.length}`,
    `  credentials  ${catalog.credentials.length}`,
    `  routes       ${catalog.routes.length}`,
    '  loopback     stopped (embedded routing remains available)',
  ];
  if (action === 'start' || action === 'stop') {
    return [`Loopback gateway ${action} is unavailable until the optional gateway package is enabled.`];
  }
  throw new TypeError('Usage: /gateway status|start|stop');
}

function tokenize(value: string): string[] {
  return value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/gu)?.map(token => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

function scopeLabel(scope: { kind: string; id?: string }): string {
  return scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id ?? ''}`;
}
