import { HadamardSdkError } from '../errors.js';
import type { AgentToolDefinition, ResolvedToolAdapter } from '../types.js';
import { renderCodeActHostSdk } from './codeActSdk.js';
import { renderTsHostSdk } from './tsSdkRenderer.js';
import { CODE_CELL_TOOL_NAME } from './codeCellTool.js';
import { RUN_CODE_TOOL_NAME } from './runCodeTool.js';

/**
 * Tool presentation layer (dsh native/code/both, Hadamard-owned): separates
 * HOW tools are presented to the model from the agent mode (ReAct driver)
 * and from the compute runtime (persistent CodeAct kernel). PTC presents one
 * stateless run_code wire tool plus a typed SDK; the model composes multiple
 * tool calls inside a program instead of emitting many JSON tool calls.
 *
 * @module src/codeact/toolPresentation
 */

import type { ToolPresentationMode } from './presentationTypes.js';

export type { ToolPresentationMode } from './presentationTypes.js';

export interface ToolPresentationPlan {
  mode: ToolPresentationMode;
  /** Wire-level tools the provider sees for this request. */
  providerTools: import('../provider/types.js').Tool[];
  /** Present when the run_code wire tool is on the wire. */
  wireToolName?: string;
  /** Typed host-tool SDK text (empty for native). */
  sdk: string;
  /** System-prompt instructions for the presentation (empty for native). */
  instructions: string;
}

export function resolveToolPresentation(options: {
  mode: ToolPresentationMode | undefined;
  resolvedTools: readonly ResolvedToolAdapter[];
  /** Pre-resolution tool definitions the SDK is rendered from. */
  sdkTools: readonly AgentToolDefinition[];
}): ToolPresentationPlan {
  const mode = options.mode ?? 'native';
  if (mode === 'native') {
    return {
      mode,
      providerTools: options.resolvedTools.map((tool) => tool.providerTool),
      sdk: '',
      instructions: '',
    };
  }
  const wire = options.resolvedTools.find((tool) => tool.publicName === RUN_CODE_TOOL_NAME);
  if (!wire) {
    throw new HadamardSdkError(
      `Tool presentation '${mode}' requires the ${RUN_CODE_TOOL_NAME} tool to be registered.`,
      'PTC_TOOL_MISSING',
    );
  }
  const sdkTools = options.sdkTools.filter((tool) => tool.name !== CODE_CELL_TOOL_NAME && tool.name !== RUN_CODE_TOOL_NAME);
  // Language-aware SDK: the registered run_code transport declares which
  // program language its backend executes, so the SDK text and the wire
  // schema flavor always agree.
  const wireDefinition = options.sdkTools.find((tool) => tool.name === RUN_CODE_TOOL_NAME);
  const codeLanguage = wireDefinition?.codeLanguage === 'typescript' ? 'typescript' : 'python';
  const sdk = codeLanguage === 'typescript'
    ? renderTsHostSdk(sdkTools)
    : renderCodeActHostSdk(sdkTools);
  // MCP adapters are not AgentToolDefinitions, so run_code programs cannot
  // dispatch them through the host RPC surface. Under ptc (wire = run_code
  // only) that would make them silently unreachable: fail loud instead.
  const mcpNames = options.resolvedTools
    .filter((tool) => tool.provider === 'mcp')
    .map((tool) => tool.publicName);
  if (mode === 'ptc' && mcpNames.length > 0) {
    throw new HadamardSdkError(
      `Tool presentation 'ptc' cannot expose MCP tools through the run_code transport (${mcpNames.join(', ')}); use 'both' or 'native' so MCP tools stay reachable as direct calls.`,
      'PTC_MCP_UNREACHABLE',
    );
  }
  const providerTools = mode === 'ptc'
    ? [wire.providerTool]
    : [
        ...options.resolvedTools
          .filter((tool) => tool.publicName !== RUN_CODE_TOOL_NAME)
          .map((tool) => tool.providerTool),
        wire.providerTool,
      ];
  return {
    mode,
    providerTools,
    wireToolName: RUN_CODE_TOOL_NAME,
    sdk,
    instructions: buildPtcInstructions(mode, sdk, sdkTools.length, mcpNames, codeLanguage),
  };
}

function buildPtcInstructions(
  mode: 'ptc' | 'both',
  sdk: string,
  toolCount: number,
  mcpNames: string[],
  codeLanguage: 'python' | 'typescript',
): string {
  const programNote = codeLanguage === 'typescript'
    ? 'one TypeScript program'
    : 'one Python program';
  const intro = mode === 'ptc'
    ? [
        `Tools are presented through a single run_code wire tool: instead of emitting many JSON tool calls, compose multiple tool calls inside ${programNote}.`,
        'run_code is the only tool you can call directly — a direct call naming any other tool fails. Reach every tool the SDK declares below from inside a run_code program.',
        `The typed SDK below declares the ${toolCount} visible host tool(s).`,
      ].join('\n')
    : [
        'Ordinary JSON tools AND a run_code wire tool are both available; prefer run_code when several tool calls compose into one program.',
      ].join('\n');
  const sdkBlock = sdk.trim()
    ? `Typed host-tool surface reachable from run_code programs (signatures are authoritative for parameter names):\n${sdk}`
    : '';
  return [
    intro,
    'Each run_code call executes in a fresh, stateless interpreter: no variables or imports survive between calls. Programs share the environment trust of the configured CodeAct backend (process backend: full access; container backend: restricted).',
    ...(codeLanguage === 'typescript'
      ? ['Only console output and the top-level return value are returned to the model; intermediate tool results stay inside the program, so filter large outputs before returning.']
      : ['Only stdout (print) and the final expression value are returned to the model; intermediate tool results stay inside the program, so filter large outputs before returning.']),
    ...(codeLanguage === 'typescript'
      ? ['A failed host call rejects with ToolCallError carrying the tool name on toolName; catch it to branch on which tool failed.']
      : ['A failed host call raises HadamardToolError with a tool_name attribute; catch it to branch on which tool failed.']),
    'Host tool calls inside a program go through the same permission checks as direct tool calls.',
    ...(mcpNames.length > 0
      ? [`MCP tools (${mcpNames.join(', ')}) are direct-call only: they cannot be invoked inside run_code programs.`]
      : []),
    ...(sdkBlock ? [sdkBlock] : []),
  ].join('\n');
}

