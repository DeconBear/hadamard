/**
 * Tool-presentation mode type in a dependency-free leaf so the public type
 * barrel and the renderer can both reference it without import cycles.
 */
export type ToolPresentationMode = 'native' | 'ptc' | 'both';

export const SESSION_TOOL_PRESENTATION_KEY = '__hadamardToolPresentation';

export function readSessionToolPresentation(
  metadata: Record<string, unknown> | undefined,
  fallback?: ToolPresentationMode,
): ToolPresentationMode | undefined {
  const value = metadata?.[SESSION_TOOL_PRESENTATION_KEY];
  if (value === 'native' || value === 'ptc' || value === 'both') return value;
  return fallback;
}

export function sessionToolPresentationPatch(mode: ToolPresentationMode): Record<string, ToolPresentationMode> {
  return { [SESSION_TOOL_PRESENTATION_KEY]: mode };
}
