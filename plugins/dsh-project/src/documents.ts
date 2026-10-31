import path from 'node:path';
import { readdir, realpath, open } from 'node:fs/promises';
import { getHadamardProjectSessionDirectory } from '../../../src/config/projectSessionDirectory.js';

export interface ProjectDocument { id: string; title: string; group: string }
interface DocumentFile extends ProjectDocument { file: string; root: string }
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function documentFiles(workDir: string, homeDir: string) {
  const files: DocumentFile[] = [];
  let truncated = false;
  let visited = 0;
  let workspaceRoot: string | undefined;
  try { workspaceRoot = await realpath(workDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  async function scan(dir: string, recursive: boolean, depth = 0): Promise<void> {
    let entries;
    try {
      if (!workspaceRoot || !inside(workspaceRoot, await realpath(dir))) return;
      entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 4000 || files.length >= 200) { truncated = true; return; }
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && /\.md(?:own)?$/i.test(entry.name)) {
        const relative = path.relative(workDir, file).split(path.sep).join('/');
        files.push({ id: `workspace:${relative}`, title: relative, group: '项目文档', root: workDir, file });
      } else if (entry.isDirectory() && recursive) {
        if (depth >= 8) { truncated = true; continue; }
        await scan(file, true, depth + 1);
      }
    }
  }
  await scan(workDir, false);
  await scan(path.join(workDir, 'docs'), true);
  const dataRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
  for (const doc of [
    { id: 'design', title: '设计文档', root: workDir, file: path.join(workDir, '.hadamard/design/design.md') },
    { id: 'plan', title: '项目计划', root: dataRoot, file: path.join(dataRoot, 'plan.json') },
    { id: 'note', title: '项目笔记', root: dataRoot, file: path.join(dataRoot, 'workspace-note.txt') },
  ]) {
    try {
      const [root, file] = await Promise.all([realpath(doc.root), realpath(doc.file)]);
      if (inside(root, file)) files.unshift({ ...doc, group: 'Hadamard' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { files, truncated };
}

export async function listDocuments(workDir: string, homeDir: string) {
  const { files, truncated } = await documentFiles(workDir, homeDir);
  return { documents: files.map(({ id, title, group }) => ({ id, title, group })), truncated };
}

export async function readDocument(workDir: string, homeDir: string, id: unknown, signal: AbortSignal) {
  const { files } = await documentFiles(workDir, homeDir);
  const doc = files.find(file => file.id === id);
  if (!doc) throw new Error('文档不存在或已移出项目。');
  const [root, file] = await Promise.all([realpath(doc.root), realpath(doc.file)]);
  if (!inside(root, file)) throw new Error('文档路径超出项目范围。');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 524288) throw new Error('文档超过 512 KiB，请在本地编辑器中打开。');
    signal.throwIfAborted();
    // Bounded read even when a writer grows the file after stat.
    const buffer = Buffer.alloc(524289);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 524288) throw new Error('文档超过 512 KiB，请在本地编辑器中打开。');
    signal.throwIfAborted();
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (doc.id === 'plan') {
      const plan = JSON.parse(content) as {
        milestones?: { title: string; due?: string; status?: string; notes?: string }[];
        today?: string[];
        upcoming?: string[];
      };
      content = [
        '# 项目计划', '## 里程碑',
        ...(plan.milestones ?? []).map(item => `### ${item.title}\n\n${[item.due, item.status, item.notes].filter(Boolean).join(' · ')}`),
        '## 今日计划', ...(plan.today ?? []).map(item => `- ${item}`),
        '## 后续安排', ...(plan.upcoming ?? []).map(item => `- ${item}`),
      ].join('\n\n');
    }
    return { id: doc.id, title: doc.title, content };
  } finally { await handle.close(); }
}
