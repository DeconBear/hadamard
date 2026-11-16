import { commandRegistry } from './commandRegistry.js';

export interface CoreCommandDeps {
  openAddPageModal(): Promise<void> | void;
  openProjectHub(): Promise<void> | void;
  openPresent(): void;
  openWorkspaceModal(): Promise<void> | void;
  exportCurrent(format: string, options?: { bleedMm?: number; cropMarks?: boolean }): Promise<void>;
  reloadPlugins(): Promise<unknown>;
}

function click(id: string): void {
  document.getElementById(id)?.click();
}

/** Built-in commands registered once at boot; the palette and menus land in P2. */
export function installCoreCommands(deps: CoreCommandDeps): void {
  const commands = [
    { id: 'view.toggleLeftSidebar', title: 'View: Toggle left sidebar', category: 'View', handler: () => click('toggleLeftSidebarBtn') },
    { id: 'view.toggleRightSidebar', title: 'View: Toggle right sidebar', category: 'View', handler: () => click('toggleRightSidebarBtn') },
    { id: 'page.add', title: 'Page: Add page', category: 'Page', handler: () => deps.openAddPageModal() },
    { id: 'project.open', title: 'Project: Open project manager', category: 'Project', handler: () => deps.openProjectHub() },
    { id: 'project.workspace', title: 'Project: Show workspace', category: 'Project', handler: () => deps.openWorkspaceModal() },
    { id: 'present.start', title: 'Present: Start presentation', category: 'Present', handler: () => deps.openPresent() },
    { id: 'export.html', title: 'Export: HTML file', category: 'Export', handler: () => deps.exportCurrent('html') },
    { id: 'export.pdf', title: 'Export: PDF', category: 'Export', handler: () => deps.exportCurrent('pdf') },
    { id: 'plugins.reload', title: 'Plugins: Reload', category: 'Plugins', handler: () => deps.reloadPlugins() },
    { id: 'plugins.manage', title: 'Plugins: Manage', category: 'Plugins', handler: () => click('managePluginsBtn') },
    { id: 'plugins.gallery', title: 'Plugins: Gallery', category: 'Plugins', handler: () => click('pluginGalleryBtn') },
  ] as const;
  for (const command of commands) commandRegistry.register({ ...command, handler: command.handler as () => void | Promise<void> });
}
