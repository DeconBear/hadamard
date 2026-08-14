import { A } from './ansi.js';
import { formatErrorLine } from './transcript.js';

export interface TuiContextSnapshot {
  effectiveWindowTokens: number;
  rawWindowTokens: number;
  autoCompactTokenLimit: number;
  compactSource: string;
  usedTokens: number;
  systemTokens?: number;
  toolTokens?: number;
  messageTokens?: number;
  tokenEstimateMultiplier?: number;
  messages: number;
  systemPromptChars: number;
  projectInstructionChars?: number;
  projectInstructionHash?: string;
  projectInstructionKey?: string;
  compactCount?: number;
  toolCount: number;
  mcpToolCount: number;
  instructionFiles: string[];
  model: string;
  effort: string;
  team: string;
  router: string;
  bridge: string;
}

export interface TuiDoctorSnapshot {
  model: string;
  provider: string;
  apiKey: string | null;
  baseURL?: string;
  workDir: string;
  isGit: boolean;
  sessionId: string;
  messageCount: number;
  permissionMode: string;
  toolCount: number;
  instructionFiles: string[];
  bridgeRuntimes: string[];
  activeBridge?: { name: string; model?: string };
}

export interface TuiContextCommandPort {
  configureContext(mode?: string): Promise<void>;
  contextSnapshot(): Promise<TuiContextSnapshot>;
  doctorSnapshot(): Promise<TuiDoctorSnapshot>;
  appendStatic(lines: readonly string[]): void;
}

function configuredMark(configured: boolean): string {
  return configured ? `${A.green}✓${A.reset}` : `${A.red}✗${A.reset}`;
}

export async function runTuiContextCommand(
  name: string,
  args: string,
  port: TuiContextCommandPort,
): Promise<boolean> {
  if (name !== 'context' && name !== 'doctor') return false;

  if (name === 'context') {
    const contextArgs = args.trim();
    if (contextArgs === 'setting' || contextArgs === 'settings') {
      await port.configureContext();
      return true;
    }
    if (contextArgs.startsWith('setting ') || contextArgs.startsWith('settings ')) {
      await port.configureContext(contextArgs.replace(/^settings?\s+/u, ''));
      return true;
    }
    if (contextArgs) {
      port.appendStatic([...formatErrorLine('usage: /context [settings [agents|claude|both]]'), '']);
      return true;
    }
    const snapshot = await port.contextSnapshot();
    const pct = snapshot.effectiveWindowTokens > 0
      ? Math.min(100, Math.round((snapshot.usedTokens / snapshot.effectiveWindowTokens) * 100))
      : 0;
    const used = snapshot.usedTokens >= 1000
      ? `${(snapshot.usedTokens / 1000).toFixed(1)}k`
      : `${snapshot.usedTokens}`;
    const window = snapshot.effectiveWindowTokens >= 1000
      ? `${(snapshot.effectiveWindowTokens / 1000).toFixed(0)}k`
      : `${snapshot.effectiveWindowTokens}`;
    const color = pct >= 90 ? A.red : pct >= 70 ? A.yellow : A.dim;
    const tokenBreakdown = typeof snapshot.systemTokens === 'number'
      && typeof snapshot.toolTokens === 'number'
      && typeof snapshot.messageTokens === 'number'
      ? `  ${A.dim}request estimate${A.reset} system ${snapshot.systemTokens.toLocaleString()} + tools ${snapshot.toolTokens.toLocaleString()} + messages ${snapshot.messageTokens.toLocaleString()}`
        + (snapshot.tokenEstimateMultiplier && snapshot.tokenEstimateMultiplier !== 1
          ? ` 路 calibrated 脳${snapshot.tokenEstimateMultiplier.toFixed(2)}`
          : '')
      : `  ${A.dim}request estimate${A.reset} breakdown unavailable until the next model request`;
    port.appendStatic([
      `${A.bold}Context window${A.reset}`,
      `  ${color}${pct}% used (${used} / ${window} tokens)${A.reset}`,
      tokenBreakdown,
      `  ${A.dim}raw window${A.reset}      ${snapshot.rawWindowTokens}`,
      `  ${A.dim}compact limit${A.reset}  ${snapshot.autoCompactTokenLimit} (${snapshot.compactSource})`,
      `  ${A.dim}messages${A.reset}        ${snapshot.messages}`,
      `  ${A.dim}system prompt${A.reset}   ~${snapshot.systemPromptChars} chars`,
      `  ${A.dim}project instructions${A.reset} ~${snapshot.projectInstructionChars ?? 0} chars` +
        (snapshot.projectInstructionHash ? ` · hash ${snapshot.projectInstructionHash}` : '') +
        (typeof snapshot.compactCount === 'number' ? ` · compact ${snapshot.compactCount}` : ''),
      `  ${A.dim}tools${A.reset}           ${snapshot.toolCount}${snapshot.mcpToolCount > 0 ? ` (${snapshot.mcpToolCount} MCP)` : ''}`,
      `  ${A.dim}instruction files${A.reset} ${snapshot.instructionFiles.length ? snapshot.instructionFiles.join(', ') : '(none loaded)'}`,
      `  ${A.dim}active${A.reset}         model=${snapshot.model} · effort=${snapshot.effort} · team=${snapshot.team} · router=${snapshot.router} · bridge=${snapshot.bridge}`,
      '',
    ]);
    return true;
  }

  const snapshot = await port.doctorSnapshot();
  const lines: string[] = [`${A.bold}Hadamard diagnostics${A.reset}`];
  lines.push(`  ${configuredMark(Boolean(snapshot.model))} model ${A.dim}${snapshot.model || '(unset)'}${A.reset}`);
  lines.push(`  ${configuredMark(Boolean(snapshot.provider))} provider ${A.dim}${snapshot.provider || '(unset)'}${A.reset}`);
  lines.push(`  ${configuredMark(Boolean(snapshot.apiKey))} api key ${A.dim}${snapshot.apiKey ?? '(not set — set HADAMARD_API_KEY or configure via /model config)'}${A.reset}`);
  if (snapshot.baseURL) lines.push(`  ${A.dim}base url${A.reset} ${snapshot.baseURL}`);
  lines.push(`  ${configuredMark(true)} workdir ${A.dim}${snapshot.workDir}${A.reset}`);
  lines.push(`  ${configuredMark(snapshot.isGit)} git repo ${A.dim}${snapshot.isGit ? 'yes' : 'no'}${A.reset}`);
  lines.push(`  ${configuredMark(true)} session ${A.dim}${snapshot.sessionId}${A.reset} · ${snapshot.messageCount} messages`);
  lines.push(`  ${configuredMark(true)} permission mode ${A.dim}${snapshot.permissionMode}${A.reset}`);
  lines.push(`  ${configuredMark(snapshot.toolCount > 0)} tools ${A.dim}${snapshot.toolCount}${A.reset}`);
  lines.push(`  ${configuredMark(snapshot.instructionFiles.length > 0)} instruction files ${A.dim}${snapshot.instructionFiles.length ? snapshot.instructionFiles.join(', ') : '(none)'}${A.reset}`);
  lines.push(`  ${configuredMark(snapshot.bridgeRuntimes.length > 0)} bridge runtimes ${A.dim}${snapshot.bridgeRuntimes.length ? snapshot.bridgeRuntimes.join(', ') : '(none on PATH)'}${A.reset}`);
  if (snapshot.activeBridge) {
    lines.push(`  ${A.dim}active bridge${A.reset} ${snapshot.activeBridge.name}${snapshot.activeBridge.model ? ` · ${snapshot.activeBridge.model}` : ''}`);
  }
  lines.push('');
  port.appendStatic(lines);
  return true;
}
