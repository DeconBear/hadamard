import path from 'node:path';
import { CodeActService } from '../codeact/codeActService.js';
import type { CodeActSettings } from '../codeact/types.js';
import { ResearchService } from '../research/service.js';

/** Keeps workspace identity and backend lifecycle consistent across UI navigation. */
export class GuiResearchWorkspaceServices {
  private readonly services = new Map<string, { settings: string; service: ResearchService; codeAct?: CodeActService }>();
  private resolution: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly current: () => { workspace: string; settings: CodeActSettings; changing?: boolean }) {}

  resolve(expectedWorkspace: string, execution = false): Promise<ResearchService> {
    const task = this.resolution.then(async () => {
      if (this.closed) throw new Error('Research server is closing');
      const snapshot = this.current();
      const workspace = path.resolve(snapshot.workspace);
      if (path.resolve(expectedWorkspace) !== workspace || snapshot.changing) {
        throw new Error('Workspace changed or is changing. Reopen Research in the current project.');
      }
      const settings = JSON.stringify(snapshot.settings);
      let entry = this.services.get(workspace);
      if (entry && entry.settings !== settings) {
        if ((await entry.service.listRuns()).some(run => ['queued', 'running', 'validating'].includes(run.status))) {
          if (execution) throw new Error('CodeAct settings changed while research is active. Cancel or finish those runs first.');
          return entry.service;
        }
        await entry.service.close();
        await entry.codeAct?.close();
        this.services.delete(workspace);
        entry = undefined;
      }
      if (!entry) {
        const codeAct = snapshot.settings.enabled ? new CodeActService(snapshot.settings) : undefined;
        const service = new ResearchService(workspace, { codeAct });
        try { await service.initialize(); }
        catch (error) { await codeAct?.close(); throw error; }
        entry = { settings, service, codeAct };
        this.services.set(workspace, entry);
      }
      const latest = this.current();
      if (path.resolve(latest.workspace) !== workspace || latest.changing || JSON.stringify(latest.settings) !== settings) {
        throw new Error('Workspace or CodeAct settings changed. Refresh Research before continuing.');
      }
      return entry.service;
    });
    this.resolution = task.catch(() => undefined);
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.resolution;
    await Promise.all([...this.services.values()].map(async entry => {
      try { await entry.service.close(); } finally { await entry.codeAct?.close(); }
    }));
    this.services.clear();
  }
}
