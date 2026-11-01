/**
 * Canvas pack registry. Validation/export fan out over active packs.
 */
import type { CanvasCheck, CanvasDoc } from '../types.js';
import { AI_MODEL_PACK, analyzeAiModel } from './aiModel.js';
import type { CanvasPack } from './types.js';

export type { CanvasPack, CanvasNodeKindDefinition, CanvasEdgeKindDefinition } from './types.js';

export const CANVAS_PACKS: readonly CanvasPack[] = Object.freeze([AI_MODEL_PACK]);

export function getCanvasPack(id: string): CanvasPack | undefined {
  return CANVAS_PACKS.find(pack => pack.id === id);
}

export function getCanvasNodeKind(kind: string): { pack: CanvasPack; definition: CanvasPack['nodeKinds'][string] } | undefined {
  for (const pack of CANVAS_PACKS) {
    const definition = pack.nodeKinds[kind];
    if (definition) return { pack, definition };
  }
  return undefined;
}

/** Run every registered pack validator whose kinds appear or whose pack is active. */
export function validateCanvas(doc: CanvasDoc): CanvasCheck[] {
  const checks: CanvasCheck[] = [];
  for (const pack of CANVAS_PACKS) {
    if (typeof pack.validate !== 'function') continue;
    const hasKinds = doc.nodes.some(node => pack.nodeKinds[node.kind]);
    const active = doc.meta.packIds.includes(pack.id);
    if (!hasKinds && !active) continue;
    try {
      checks.push(...pack.validate(doc));
    } catch (error) {
      checks.push({
        id: pack.id + '.validator-crashed',
        severity: 'error',
        packId: pack.id,
        message: 'Validator failed: ' + (error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return checks;
}

export type CanvasExportFormat = 'json-canvas' | 'mermaid' | 'markdown' | 'pytorch';

export function exportPackArtifact(doc: CanvasDoc, format: 'mermaid' | 'pytorch'): string | undefined {
  for (const pack of CANVAS_PACKS) {
    const artifacts = pack.export?.(doc);
    if (artifacts && typeof artifacts[format] === 'string') return artifacts[format];
  }
  return undefined;
}

export { AI_MODEL_PACK, analyzeAiModel };
