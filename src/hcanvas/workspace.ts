import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface HcWorkspaceInfo {
  workspace: string;
  project: string | null;
  guidePath: string;
  initialized: boolean;
}

export function projectWorkspaceDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), '.hcanvas');
}

export function workspaceGuide(workspace: string, project: string | null): string {
  const example = project ? path.basename(project).replace(/[^A-Za-z0-9_-]+/g, '-') : 'my-canvas';
  return '# Hadamard Canvas · CLI guide\n' +
    '\nWorkspace: ' + workspace + '\n' +
    (project ? 'Project: ' + project + '\n' : '') +
    '\nThis directory is the complete hcanvas workspace. Keep it with the project or back it up as-is.\n\n' +
    '## Layout\n\n' +
    '- docs/<docId>.json — documents (JSON schema hadamard-canvas/1)\n' +
    '- state.json — active document/page and agent sessions\n' +
    '- masters.json — reusable page masters\n' +
    '- daemon.json — local service URL + token (machine-local)\n' +
    '- exports/ — HTML/PDF/PNG/PPTX/DOCX outputs\n\n' +
    '## Start\n\n' +
    'hcanvas app --project ' + (project || workspace) + '\n' +
    'hcanvas desktop --project ' + (project || workspace) + '\n\n' +
    '## Read\n\n' +
    'hcanvas context --json\n' +
    'hcanvas read ' + example + ' --format outline\n' +
    'hcanvas read ' + example + ' --format html --page <pageId>\n' +
    'hcanvas read ' + example + ' --format scene --page <whiteboardPageId>\n\n' +
    '## Write\n\n' +
    'hcanvas apply ' + example + ' --ops-file ops.json --base-revision <rev> --actor claude-code\n' +
    'hcanvas propose ' + example + ' --ops-file ops.json --base-revision <rev> --intent "Add a section"\n\n' +
    '## Multi-agent\n\n' +
    'hcanvas sessions create ' + example + ' --actor claude-code\n' +
    'export HCANVAS_SESSION=<sessionId>\n' +
    'hcanvas context --json\n\n' +
    '## Import / export\n\n' +
    'hcanvas import ./page.html ' + example + '\n' +
    'hcanvas export ' + example + ' --format pdf --out ./exports/deck.pdf\n' +
    'hcanvas import-scene ./board.excalidraw ' + example + '\n' +
    'hcanvas convert-whiteboard ' + example + '\n' +
    'hcanvas export-scene ' + example + ' --out ./exports/board.excalidraw\n' +
    'hcanvas export ' + example + ' --format pptx\n\n' +
    'Read before writing: always pass the latest revision returned by hcanvas context/read.\n';
}

export async function initWorkspace(root: string, project?: string | null): Promise<HcWorkspaceInfo> {
  const workspace = path.resolve(root);
  const projectPath = project ? path.resolve(project) : workspace.endsWith(path.sep + '.hcanvas') ? path.dirname(workspace) : null;
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await mkdir(path.join(workspace, 'exports'), { recursive: true });
  const infoPath = path.join(workspace, 'workspace.json');
  if (!existsSync(infoPath)) {
    await writeFile(infoPath, JSON.stringify({ schema: 'hadamard-canvas-workspace/1', project: projectPath, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  const guidePath = path.join(workspace, 'CLI.md');
  if (!existsSync(guidePath)) await writeFile(guidePath, workspaceGuide(workspace, projectPath), 'utf8');
  const ignorePath = path.join(workspace, '.gitignore');
  if (!existsSync(ignorePath)) await writeFile(ignorePath, 'daemon.json\nexports/\n', 'utf8');
  return { workspace, project: projectPath, guidePath, initialized: true };
}

export async function workspaceInfo(root: string): Promise<HcWorkspaceInfo & { guide: string }> {
  const workspace = path.resolve(root);
  const info = await initWorkspace(workspace);
  let guide = '';
  try { guide = await readFile(info.guidePath, 'utf8'); } catch { /* optional */ }
  let project = info.project;
  try {
    const saved = JSON.parse(await readFile(path.join(workspace, 'workspace.json'), 'utf8')) as { project?: string | null };
    if (saved.project) project = saved.project;
  } catch { /* optional */ }
  return { ...info, project, guide };
}