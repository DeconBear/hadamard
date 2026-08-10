import { formatErrorLine } from './transcript.js';

export interface TuiBridgeRunPort {
  run(prompt: string): Promise<void>;
  background(prompt: string): Promise<void>;
  listRuns(): void;
  stop(runId: string): void;
  status(): void;
  history(nativeSessionId: string): Promise<void>;
  resume(nativeSessionId: string): Promise<void>;
}

export interface TuiBridgeConfigurationPort {
  switchProvider(target: string): Promise<void>;
  setup(): Promise<void>;
  manage(): Promise<void>;
  disable(): Promise<void>;
  selectModel(modelId: string): Promise<void>;
  help(): void;
  openBoard(): Promise<void>;
}

export interface TuiBridgeCommandPort {
  runs: TuiBridgeRunPort;
  configuration: TuiBridgeConfigurationPort;
  appendStatic(lines: readonly string[]): void;
}

export async function runTuiBridgeCommand(
  name: string,
  args: string,
  port: TuiBridgeCommandPort,
): Promise<boolean> {
  if (name !== 'bridge') return false;
  if (args === 'run' || args.startsWith('run ')) {
    const prompt = args.startsWith('run ') ? args.slice(4).trim() : '';
    if (!prompt) port.appendStatic([...formatErrorLine('usage: /bridge run <prompt>'), '']);
    else await port.runs.run(prompt);
    return true;
  }
  if (args === 'background' || args.startsWith('background ')) {
    const prompt = args.startsWith('background ') ? args.slice(11).trim() : '';
    if (!prompt) port.appendStatic([...formatErrorLine('usage: /bridge background <prompt>'), '']);
    else await port.runs.background(prompt);
    return true;
  }
  if (args === 'runs') {
    port.runs.listRuns();
    return true;
  }
  if (args === 'stop' || args.startsWith('stop ')) {
    const runId = args.startsWith('stop ') ? args.slice(5).trim() : '';
    if (!runId) port.appendStatic([...formatErrorLine('usage: /bridge stop <runId>'), '']);
    else port.runs.stop(runId);
    return true;
  }
  if (args === 'status') {
    port.runs.status();
    return true;
  }
  if (args === 'history' || args.startsWith('history ')) {
    await port.runs.history(args.startsWith('history ') ? args.slice(8).trim() : '');
    return true;
  }
  if (args === 'resume' || args.startsWith('resume ')) {
    const nativeSessionId = args.startsWith('resume ') ? args.slice(7).trim() : '';
    if (!nativeSessionId) port.appendStatic([...formatErrorLine('usage: /bridge resume <native-id>'), '']);
    else await port.runs.resume(nativeSessionId);
    return true;
  }
  if (args === 'switch' || args.startsWith('switch ')) {
    await port.configuration.switchProvider(args.startsWith('switch ') ? args.slice(7).trim() : '');
    return true;
  }
  if (args === 'setup') await port.configuration.setup();
  else if (args === 'config') await port.configuration.manage();
  else if (args === 'off') await port.configuration.disable();
  else if (args === 'model' || args.startsWith('model ')) {
    await port.configuration.selectModel(args.startsWith('model ') ? args.slice(6).trim() : '');
  } else if (args === 'help') port.configuration.help();
  else if (!args) await port.configuration.openBoard();
  else await port.configuration.setup();
  return true;
}
