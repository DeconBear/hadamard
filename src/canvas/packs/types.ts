/**
 * Canvas domain pack contract.
 *
 * A pack owns semantic node/edge kinds, validation and export for one design
 * domain. Packs never touch storage or UI directly.
 */
import type { CanvasCheck, CanvasDoc, CanvasPort } from '../types.js';

export interface CanvasNodeKindDefinition {
  title: string;
  defaultText?: string;
  defaults?: Record<string, unknown>;
  ports?: CanvasPort[];
  /** Human-readable schema hint used by inspector/tool docs. */
  fields?: Record<string, string>;
}

export interface CanvasEdgeKindDefinition {
  title: string;
  label?: string;
}

export interface CanvasPack {
  id: string;
  title: string;
  /** Node kinds this pack registers, keyed by canvas kind string. */
  nodeKinds: Record<string, CanvasNodeKindDefinition>;
  edgeKinds: Record<string, CanvasEdgeKindDefinition>;
  validate?(doc: CanvasDoc): CanvasCheck[];
  /** Human/agent-readable export artifacts keyed by format (mermaid, pytorch, ...). */
  export?(doc: CanvasDoc): Record<string, string>;
  /** Extra guidance folded into canvas tool descriptions when this pack is active. */
  promptHints?: string;
}
