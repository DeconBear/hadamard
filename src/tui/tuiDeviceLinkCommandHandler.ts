import type { DeviceLinkCommandResult } from '../device-link/commandService.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiDeviceLinkCommandPort {
  execute(args: string): Promise<DeviceLinkCommandResult>;
  appendStatic(lines: readonly string[]): void;
}

export async function runTuiDeviceLinkCommand(
  name: string,
  args: string,
  port: TuiDeviceLinkCommandPort,
): Promise<boolean> {
  if (name !== 'devices') return false;
  const supported = ['status', 'start', 'stop', 'pair', 'scopes', 'revoke', 'send', 'outbox', 'discover', 'audit'] as const;
  const command = args.trim().split(/\s/u, 1)[0]?.toLowerCase() || 'status';
  if (!supported.includes(command as typeof supported[number])) {
    port.appendStatic([...formatErrorLine(`unknown Device Link command: ${command}`), '']);
    return true;
  }
  try {
    const result = await port.execute(args);
    port.appendStatic([
      ...formatInfoLine(result.message),
      ...(result.lines ?? []).map(line => `  ${line}`),
      '',
    ]);
  } catch (error) {
    port.appendStatic([
      ...formatErrorLine(error instanceof Error ? error.message : String(error)),
      '',
    ]);
  }
  return true;
}
