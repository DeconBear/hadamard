import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validatePluginManifest, type HcPluginManifest } from './pluginManifest.js';
import { discoverPlugins, type HcPluginDiscovery } from './pluginLoader.js';
import { HcValidationError } from './store.js';

export interface HcGallerySample {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: HcPluginManifest;
}

export interface HcPluginInstallResult {
  plugin: { id: string; path: string };
  discovery: HcPluginDiscovery;
}

// Embedded copies of examples/hcanvas-plugins so the packaged app does not need
// to ship the examples folder. Both are validated by validatePluginManifest.
const STICKY_NOTES_MANIFEST = {
  "schema": "hcanvas-plugin/1",
  "id": "sticky-notes",
  "name": "Sticky Notes",
  "version": "1.0.0",
  "apiVersion": "hcanvas-plugin/1",
  "blocks": [
    {
      "type": "sticky-note",
      "label": "Sticky note",
      "hint": "A small paper note with a title and body",
      "defaultSize": {
        "w": 280,
        "h": 200
      },
      "defaultData": {
        "title": "Sticky note",
        "body": "Write something here."
      },
      "fields": [
        {
          "key": "title",
          "label": "Title",
          "kind": "text"
        },
        {
          "key": "body",
          "label": "Body",
          "kind": "textarea"
        }
      ],
      "render": "<div style=\"box-sizing:border-box;height:100%;padding:18px 20px;border:1px solid #f0d58c;border-radius:4px;background:#fff7d6;color:#4a3b12;font-family:Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:3px 4px 0 rgba(58,45,12,.08);overflow:hidden\"><div style=\"margin:0 0 8px;font-size:15px;font-weight:750;letter-spacing:-.01em\">{{title}}</div><div style=\"white-space:pre-wrap;font-size:13px;line-height:1.55;color:#6b5620\">{{body}}</div></div>"
    }
  ]
};

const STARTER_PAGES_MANIFEST = {
  "schema": "hcanvas-plugin/1",
  "id": "starter-pages",
  "name": "Starter Pages",
  "version": "1.0.0",
  "apiVersion": "hcanvas-plugin/1",
  "pagePresets": [
    {
      "id": "project-brief",
      "label": "Project brief",
      "hint": "A calm one-page canvas brief",
      "mode": "canvas",
      "width": 1280,
      "height": 720,
      "background": "#fffdf8",
      "blocks": [
        {
          "type": "text",
          "x": 72,
          "y": 56,
          "w": 900,
          "h": 80,
          "z": 1,
          "text": "Project brief",
          "style": {
            "fontSize": 48,
            "fontWeight": 700,
            "color": "#1f2430",
            "fontFamily": "Georgia, serif"
          }
        },
        {
          "type": "text",
          "x": 74,
          "y": 145,
          "w": 700,
          "h": 48,
          "z": 2,
          "text": "What we are building, for whom, and why it matters.",
          "style": {
            "fontSize": 17,
            "fontWeight": 400,
            "color": "#8a8276"
          }
        },
        {
          "type": "shape",
          "x": 72,
          "y": 250,
          "w": 340,
          "h": 220,
          "z": 3,
          "shape": "rect",
          "text": "Goals",
          "style": {
            "fill": "#f7f4ff",
            "stroke": "#c4b5fd",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#4c1d95"
          }
        },
        {
          "type": "shape",
          "x": 438,
          "y": 250,
          "w": 340,
          "h": 220,
          "z": 4,
          "shape": "rect",
          "text": "Audience",
          "style": {
            "fill": "#f1fbf4",
            "stroke": "#bbf7d0",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#14532d"
          }
        },
        {
          "type": "shape",
          "x": 804,
          "y": 250,
          "w": 340,
          "h": 220,
          "z": 5,
          "shape": "rect",
          "text": "Success",
          "style": {
            "fill": "#fff7ed",
            "stroke": "#fed7aa",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#9a3412"
          }
        },
        {
          "type": "text",
          "x": 74,
          "y": 545,
          "w": 1000,
          "h": 80,
          "z": 6,
          "text": "Next step: capture the brief, agree on the audience, then ship a first version.",
          "style": {
            "fontSize": 15,
            "fontWeight": 500,
            "color": "#5d584e"
          }
        }
      ]
    },
    {
      "id": "daily-note",
      "label": "Daily note",
      "hint": "An infinite desk for thoughts and tasks",
      "mode": "infinite",
      "width": 1600,
      "height": 1000,
      "background": "#fbfaf7",
      "blocks": [
        {
          "type": "text",
          "x": 120,
          "y": 100,
          "w": 760,
          "h": 90,
          "z": 1,
          "text": "Daily note",
          "style": {
            "fontSize": 56,
            "fontWeight": 700,
            "color": "#1f2430",
            "fontFamily": "Georgia, serif"
          }
        },
        {
          "type": "text",
          "x": 124,
          "y": 210,
          "w": 620,
          "h": 60,
          "z": 2,
          "text": "Capture first. Organize later.",
          "style": {
            "fontSize": 18,
            "fontWeight": 400,
            "color": "#8a8276"
          }
        },
        {
          "type": "shape",
          "x": 124,
          "y": 330,
          "w": 420,
          "h": 260,
          "z": 3,
          "shape": "rect",
          "text": "Today",
          "style": {
            "fill": "#ffffff",
            "stroke": "#e7e0d2",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#1f2430"
          }
        },
        {
          "type": "shape",
          "x": 600,
          "y": 330,
          "w": 420,
          "h": 260,
          "z": 4,
          "shape": "rect",
          "text": "Ideas",
          "style": {
            "fill": "#f7f4ff",
            "stroke": "#ddd6fe",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#4c1d95"
          }
        },
        {
          "type": "shape",
          "x": 1076,
          "y": 330,
          "w": 420,
          "h": 260,
          "z": 5,
          "shape": "rect",
          "text": "Later",
          "style": {
            "fill": "#fff7ed",
            "stroke": "#fed7aa",
            "strokeWidth": 1,
            "radius": 16,
            "fontSize": 24,
            "fontWeight": 700,
            "color": "#9a3412"
          }
        }
      ]
    }
  ]
};

const SAMPLE_DEFINITIONS: ReadonlyArray<{ description: string; manifest: unknown }> = [
  {
    description: 'A sticky note block with a title and body for quick annotations on the canvas.',
    manifest: STICKY_NOTES_MANIFEST,
  },
  {
    description: 'Ready-made canvas and infinite page templates for project briefs and daily notes.',
    manifest: STARTER_PAGES_MANIFEST,
  },
];

let cachedSamples: HcGallerySample[] | null = null;

/** Embedded gallery catalog, ready for the /api/plugins/gallery response. */
export function listGallerySamples(): HcGallerySample[] {
  if (!cachedSamples) {
    cachedSamples = SAMPLE_DEFINITIONS.map(({ description, manifest }) => {
      const validated = validatePluginManifest(manifest);
      return {
        id: validated.id,
        name: validated.name,
        version: validated.version,
        description,
        manifest: validated,
      };
    });
  }
  return cachedSamples.map(sample => ({ ...sample }));
}

function projectPluginsRoot(workspace: string): string {
  return path.resolve(workspace, 'plugins');
}

function isInside(root: string, target: string): boolean {
  return target !== root && target.startsWith(root + path.sep);
}

function pluginDirFor(workspace: string, id: string): string {
  const root = projectPluginsRoot(workspace);
  const target = path.resolve(root, id);
  if (!isInside(root, target)) throw new HcValidationError('Unsafe plugin id: ' + id);
  return target;
}

function validateForInstall(input: unknown): HcPluginManifest {
  try {
    return validatePluginManifest(input);
  } catch (error) {
    throw new HcValidationError(error instanceof Error ? error.message : String(error));
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Install a declarative manifest into <workspace>/plugins/<id>/manifest.json.
 * Rejects unsafe ids and existing folders unless overwrite is true.
 */
export async function installPluginManifest(workspace: string, manifestInput: unknown, overwrite = false): Promise<HcPluginInstallResult> {
  const manifest = validateForInstall(manifestInput);
  const pluginDir = pluginDirFor(workspace, manifest.id);
  if (await pathExists(pluginDir)) {
    if (overwrite !== true) throw new HcValidationError('Plugin already installed: ' + manifest.id);
    const info = await stat(pluginDir);
    if (!info.isDirectory()) throw new HcValidationError('Plugin path is not a folder: ' + manifest.id);
  }
  await mkdir(pluginDir, { recursive: true });
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const tempPath = manifestPath + '.tmp-' + randomUUID();
  try {
    await writeFile(tempPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await rename(tempPath, manifestPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return {
    plugin: { id: manifest.id, path: manifestPath },
    discovery: await discoverPlugins(workspace),
  };
}

/**
 * Remove a project plugin folder. User plugins and unknown ids are rejected.
 */
export async function uninstallProjectPlugin(workspace: string, id: string): Promise<HcPluginDiscovery> {
  const pluginId = typeof id === 'string' ? id.trim() : '';
  if (!pluginId) throw new HcValidationError('id is required');
  const discovery = await discoverPlugins(workspace);
  const known = discovery.plugins.find(plugin => plugin.manifest.id === pluginId);
  if (!known) throw new HcValidationError('Unknown plugin id: ' + pluginId);
  if (known.source !== 'project') throw new HcValidationError('Cannot uninstall user plugin: ' + pluginId);
  const root = projectPluginsRoot(workspace);
  const folder = path.resolve(path.dirname(known.path));
  if (!isInside(root, folder)) throw new HcValidationError('Refusing to uninstall plugin outside the project plugin root: ' + pluginId);
  await rm(folder, { recursive: true, force: true });
  return discoverPlugins(workspace);
}
