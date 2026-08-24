/**
 * Shared /lsp view model for the TUI and GUI slash commands: list every
 * configured or auto-detected language server with availability and live
 * running state from `client.codeIntelligence.serverStatus()`.
 *
 * @module src/ui/lspCommandView
 */
import type { CodeIntelligenceService } from '../codeIntel/codeIntelligenceService.js';
import { LANGUAGE_SERVER_PRESETS } from '../codeIntel/languageServerPresets.js';

export interface LspCommandViewResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
}

const NO_SERVERS_MESSAGE = [
  'No language servers configured or detected.',
  'Configure languageServers in ~/.hadamard/settings.json, or install a server binary and let auto-detection find it.',
  `Auto-detection probes PATH for: ${LANGUAGE_SERVER_PRESETS.map(preset => preset.command).join(', ')}.`,
].join('\n');

export async function runLspCommandView(
  service: Pick<CodeIntelligenceService, 'serverStatus'> | undefined,
): Promise<LspCommandViewResult> {
  if (!service) return { message: NO_SERVERS_MESSAGE };
  const statuses = await service.serverStatus();
  if (statuses.length === 0) return { message: NO_SERVERS_MESSAGE };
  return {
    message: `Language servers (${statuses.length})`,
    items: statuses.map(status => ({
      label: status.id,
      description: [
        status.languages.join(', '),
        status.available ? 'available' : `unavailable${status.reason ? ` (${status.reason})` : ''}`,
        status.running ? 'running' : 'not started',
      ].join(' · '),
    })),
  };
}
