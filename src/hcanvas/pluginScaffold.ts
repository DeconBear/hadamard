import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface HcPluginScaffoldResult {
  id: string;
  manifestPath: string;
  pluginDir: string;
}

function blockScaffold(id: string) {
  return {
    schema: 'hcanvas-plugin/1',
    id,
    name: 'My first block',
    version: '0.1.0',
    apiVersion: 'hcanvas-plugin/1',
    blocks: [{
      type: id + '-card',
      label: 'My first block',
      hint: 'Edit this manifest to build your own block',
      defaultSize: { w: 320, h: 180 },
      defaultData: { title: 'Hello from a plugin', body: 'Change the manifest, then Reload plugins.' },
      fields: [
        { key: 'title', label: 'Title', kind: 'text' },
        { key: 'body', label: 'Body', kind: 'textarea' },
      ],
      render: '<div style="box-sizing:border-box;height:100%;padding:18px 20px;border:1px solid #d9d3c7;border-radius:14px;background:#fffdf8;font-family:Inter,sans-serif"><div style="font-weight:750;font-size:16px;margin-bottom:6px">{{title}}</div><div style="font-size:13px;line-height:1.55;color:#655e52;white-space:pre-wrap">{{body}}</div></div>',
    }],
  };
}

function pageScaffold(id: string) {
  return {
    schema: 'hcanvas-plugin/1',
    id,
    name: 'My first page template',
    version: '0.1.0',
    apiVersion: 'hcanvas-plugin/1',
    pagePresets: [{
      id: id + '-brief',
      label: 'My first page',
      hint: 'A custom canvas page template',
      mode: 'canvas',
      width: 1280,
      height: 720,
      background: '#fffdf8',
      blocks: [
        { type: 'text', x: 72, y: 64, w: 900, h: 90, text: 'My first page', style: { fontSize: 52, fontWeight: 700, color: '#1f2430' } },
        { type: 'text', x: 74, y: 165, w: 700, h: 60, text: 'Edit this manifest to make the template yours.', style: { fontSize: 17, color: '#8a8276' } },
      ],
    }],
  };
}

export async function createPluginScaffold(workspace: string, kind: 'block' | 'page' = 'block'): Promise<HcPluginScaffoldResult> {
  const root = path.join(workspace, 'plugins');
  await mkdir(root, { recursive: true });
  const base = kind === 'page' ? 'my-page-template' : 'my-first-plugin';
  let id = base;
  let suffix = 2;
  while (existsSync(path.join(root, id))) { id = base + '-' + suffix; suffix += 1; }
  const pluginDir = path.join(root, id);
  await mkdir(pluginDir, { recursive: true });
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifest = kind === 'page' ? pageScaffold(id) : blockScaffold(id);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { id, manifestPath, pluginDir };
}
