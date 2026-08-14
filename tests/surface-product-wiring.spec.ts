import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const PRODUCT_SURFACES = [
  ['src/tui/hadamardTui.ts', 'tui'],
  ['src/gui/hadamardGui.ts', 'gui'],
  ['src/parity/hadamardCleanBridgeCompatSdk.ts', 'bridge'],
] as const;

async function readSurfaceSource(file: string): Promise<string> {
  const files = file === 'src/tui/hadamardTui.ts'
    ? [
        file,
        'src/tui/hadamardTuiController.ts',
        'src/tui/tuiRuntimeLifecycle.ts',
        'src/tui/tuiFramePresenter.ts',
        'src/tui/tuiInputController.ts',
        'src/tui/tuiMemoryCommandHandler.ts',
        'src/tui/tuiConfigurationCommandHandler.ts',
        'src/tui/tuiBasicCommandHandler.ts',
        'src/tui/tuiPlanCommandHandler.ts',
        'src/tui/tuiSessionCommandHandler.ts',
        'src/tui/tuiWorkflowCommandHandler.ts',
        'src/tui/tuiWorktreeCommandHandler.ts',
        'src/tui/tuiBridgeCommandHandler.ts',
        'src/tui/tuiTeamCommandHandler.ts',
        'src/tui/tuiIssueCommandHandler.ts',
        'src/tui/tuiAssistantCommandHandler.ts',
        'src/tui/tuiManagerCommandHandler.ts',
        'src/tui/tuiWorkspaceCommandHandler.ts',
        'src/tui/tuiContextCommandHandler.ts',
        'src/tui/tuiCatalogCommandHandler.ts',
      ]
    : [file];
  return (await Promise.all(files.map(source =>
    readFile(new URL(`../${source}`, import.meta.url), 'utf8')))).join('\n');
}

describe('product RunEvent wiring boundary', () => {
  it.each(PRODUCT_SURFACES)('%s projects legacy events through shared %s semantics', async (file, target) => {
    const source = await readSurfaceSource(file);

    expect(source).toContain('LegacySurfaceEventPipeline');
    expect(source).toContain('new LegacySurfaceEventPipeline(');
    expect(source).toMatch(new RegExp(`\\.projectFor\\([^)]*, ['\"]${target}['\"]\\)`));
  });

  it('keeps the native bridge as an AgentRuntime adapter, not a createAgentSdk facade', async () => {
    const source = await readFile(
      new URL('../src/surfaces/runtimeBridgeAdapter.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('this.runtime.stream(this.agent');
    expect(source).toContain('this.runtime.run(this.agent');
    expect(source).not.toContain('createAgentSdk');
    expect(source).not.toMatch(/new\s+AgentRuntime\s*\(/);
  });

  it('routes GUI issue dispatch through durable spawn/checkpoint coordination', async () => {
    const source = await readFile(
      new URL('../src/gui/hadamardGui.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('new DurableIssueCoordinator(');
    expect(source).toContain('new SqliteDurableChildStore(');
    expect(source).toContain('await coordinator.run({');
    expect(source).toContain("prefix: 'gui-issue:'");
  });

  it.each([
    'src/tui/hadamardTui.ts',
    'src/gui/hadamardGui.ts',
  ])('%s delegates managed plugin settings to the shared SDK runtime', async (file) => {
    const source = await readSurfaceSource(file);
    expect(source).toContain('managedPlugins: managedPluginSettings');
    expect(source).not.toContain('createManagedPluginRuntime');
  });

  it('does not inject managed-plugin tools or Skills outside the SDK', async () => {
    const tui = await readSurfaceSource('src/tui/hadamardTui.ts');
    const gui = await readSurfaceSource('src/gui/hadamardGui.ts');
    expect(tui).not.toContain('skills: managedPluginRuntime?.skills ?? []');
    expect(gui).not.toContain('skills: managedPluginSkills');
  });

  it('commits completion-selected TUI commands to input history', async () => {
    const tui = await readSurfaceSource('src/tui/hadamardTui.ts');
    expect(tui).toContain('editor.setText(selectedCommand);');
    expect(tui).toContain('editor.submit();');
  });

  it.each([
    'src/tui/hadamardTui.ts',
  ])('%s retries managed plugin cleanup and exits nonzero on failure', async (file) => {
    const source = await readSurfaceSource(file);
    expect(source).toContain('closeManagedPluginsForExit');
    expect(source).toContain('MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS = 2');
    expect(source).toContain('billing may continue');
    expect(source).toContain('exitCode = 1');
    expect(source).toContain('closeManagedPluginsForExit(() => sdk.close())');
  });

  it('reports GUI and Electron cleanup failures instead of always exiting successfully', async () => {
    const gui = await readFile(
      new URL('../src/gui/hadamardGui.ts', import.meta.url),
      'utf8',
    );
    const electron = await readFile(
      new URL('../src/gui/electronMain.ts', import.meta.url),
      'utf8',
    );

    expect(gui).toContain('SDK runtime cleanup attempt ${attempt}/2 failed');
    expect(gui).toContain("process.exit(1)");
    expect(gui).not.toContain('close().finally(() => process.exit(0))');
    expect(electron).toContain('quittingAfterCleanup');
    expect(electron).toContain("app.exit(1)");
    expect(electron).toContain('dialog.showErrorBox');
    expect(electron).not.toContain('server.close().finally(() => app.quit())');
  });

  it('shows the Electron window after the GUI URL loads even if ready-to-show does not fire', async () => {
    const electron = await readFile(
      new URL('../src/gui/electronMain.ts', import.meta.url),
      'utf8',
    );
    const loadIndex = electron.indexOf('await window.loadURL(guiServer.url);');
    const fallbackIndex = electron.indexOf('if (!window.isVisible()) window.show();');
    expect(loadIndex).toBeGreaterThan(0);
    expect(fallbackIndex).toBeGreaterThan(loadIndex);
    expect(electron).toContain('let mainWindow: BrowserWindow | null = null;');
    expect(electron).toContain('mainWindow = window;');
    expect(electron).toContain('if (mainWindow === window) mainWindow = null;');
    expect(electron).toContain('show: true,');
    expect(electron).not.toContain('show: false,');
  });
});
