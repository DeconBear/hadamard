import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { resolveBrowserScreenshotPath } from '../browser/hadamardBrowserSession.js';
import { createHadamardBrowserUseToolkit } from '../browser/hadamardBrowserTools.js';
import { createHadamardComputerUseTools } from '../computer/hadamardComputerUse.js';
import { createE2bComputerUseToolkit } from '../computer/e2bComputerUse.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, HadamardSkillDefinition } from '../types.js';
import {
  KIMI_WEBBRIDGE_ALLOWED_ACTIONS,
  createKimiWebBridgePlugin,
  type KimiWebBridgeAction,
} from './kimiWebBridgePlugin.js';
import {
  readStoredManagedPluginConfig,
  type ManagedPluginId,
} from './managedPluginCatalog.js';
import {
  createManagedOcrTool,
  type ManagedOcrApi,
  type ManagedOcrProvider,
} from './ocrPlugin.js';
import {
  buildImageGenConfigFromStored,
  createImageGenTool,
} from './imageGenPlugin.js';
import {
  buildVideoGenConfigFromStored,
  createVideoGenTool,
} from './videoGenPlugin.js';
import {
  buildMeshGenConfigFromStored,
  createMeshGenTool,
} from './meshGenPlugin.js';
import { hasMediaGenSecret } from './mediaGenProfiles.js';
import {
  createGitHubCliSkill,
  createManagedActionDispatcher,
  createManagedActionSkill,
} from './managedPluginSkills.js';

export interface ManagedPluginRuntimeOptions {
  cwd: string;
}

export interface ManagedPluginRuntime {
  tools: AgentToolDefinition[];
  skills: HadamardSkillDefinition[];
  enabledPluginIds: ManagedPluginId[];
  close(): Promise<void>;
}

const readOnlyKimiActions = new Set<KimiWebBridgeAction>([
  'find_tab',
  'snapshot',
  'screenshot',
  'list_tabs',
]);

export function createManagedPluginRuntime(
  raw: Record<string, unknown>,
  options: ManagedPluginRuntimeOptions,
): ManagedPluginRuntime {
  const tools: AgentToolDefinition[] = [];
  const skills: HadamardSkillDefinition[] = [];
  const enabledPluginIds: ManagedPluginId[] = [];
  const closers: Array<() => Promise<void>> = [];

  const ocr = readStoredManagedPluginConfig(raw, 'ocr');
  if (ocr.enabled === true && stringValue(ocr.apiKey)) {
    enabledPluginIds.push('ocr');
    tools.push(createManagedOcrTool({
      provider: stringValue(ocr.provider) as ManagedOcrProvider,
      api: stringValue(ocr.api) as ManagedOcrApi,
      apiKey: stringValue(ocr.apiKey),
      baseURL: stringValue(ocr.baseURL),
      model: stringValue(ocr.model),
      prompt: stringValue(ocr.prompt),
      timeoutMs: numberValue(ocr.timeoutMs),
    }, {
      cwd: options.cwd,
      name: 'ocr_extract',
    }));
  }

  const computer = readStoredManagedPluginConfig(raw, 'computer-use');
  if (computer.enabled === true) {
    const backend = stringValue(computer.backend) || 'local';
    if (backend === 'e2b' && stringValue(computer.e2bApiKey)) {
      const width = numberValue(computer.resolutionWidth) ?? 1440;
      const height = numberValue(computer.resolutionHeight) ?? 900;
      const runtime = createE2bComputerUseToolkit({
        apiKey: stringValue(computer.e2bApiKey),
        template: stringValue(computer.e2bTemplate),
        resolution: [width, height],
        dpi: numberValue(computer.dpi),
        timeoutMs: numberValue(computer.timeoutMs),
      });
      enabledPluginIds.push('computer-use');
      tools.push(createManagedActionDispatcher({
        name: 'computer_use',
        description: 'Run one Computer Use action. Load the computer-use Skill for actions and arguments.',
        sourcePrefix: 'computer_',
        sourceTools: runtime.tools,
      }));
      skills.push(createManagedActionSkill({
        name: 'computer-use',
        description: 'Control a configured local or E2B desktop through one compact Computer Use dispatcher.',
        whenToUse: 'Use for OS-level desktop interaction that browser automation or shell commands cannot perform.',
        dispatcherName: 'computer_use',
        sourcePrefix: 'computer_',
        sourceTools: runtime.tools,
        guidance: ['This backend is an isolated E2B desktop. Start it before other actions and stop it when finished.'],
      }));
      closers.push(runtime.close);
    } else if (backend === 'local') {
      const sourceTools = createHadamardComputerUseTools();
      enabledPluginIds.push('computer-use');
      tools.push(createManagedActionDispatcher({
        name: 'computer_use',
        description: 'Run one Computer Use action. Load the computer-use Skill for actions and arguments.',
        sourcePrefix: 'computer_',
        sourceTools,
      }));
      skills.push(createManagedActionSkill({
        name: 'computer-use',
        description: 'Control the local Windows desktop through one compact Computer Use dispatcher.',
        whenToUse: 'Use for OS-level desktop interaction that browser automation or shell commands cannot perform.',
        dispatcherName: 'computer_use',
        sourcePrefix: 'computer_',
        sourceTools,
        guidance: ['Focus the intended window before typing or sending keys. Use screenshots to verify visual state.'],
      }));
    }
  }

  const github = readStoredManagedPluginConfig(raw, 'github');
  if (github.enabled === true) {
    enabledPluginIds.push('github');
    skills.push(createGitHubCliSkill({
      hostname: stringValue(github.hostname),
      defaultOwner: stringValue(github.defaultOwner),
    }));
  }

  const kimi = readStoredManagedPluginConfig(raw, 'kimi-webbridge');
  if (kimi.enabled === true) {
    const plugin = createKimiWebBridgePlugin({
      endpoint: kimiCommandEndpoint(stringValue(kimi.daemonUrl)),
      session: stringValue(kimi.sessionName),
      timeoutMs: numberValue(kimi.timeoutMs),
      autoStart: kimi.autoStart !== false,
    });
    enabledPluginIds.push('kimi-webbridge');
    tools.push(createKimiAgentTool(plugin));
  }

  const playwright = readStoredManagedPluginConfig(raw, 'playwright');
  if (playwright.enabled === true) {
    const runtime = createHadamardBrowserUseToolkit({
      headless: playwright.headless !== false,
      channel: browserChannel(playwright.channel),
      cdpUrl: stringValue(playwright.cdpUrl),
      userDataDir: stringValue(playwright.userDataDir),
      workspaceDir: options.cwd,
      allowedDomains: stringArray(playwright.allowedDomains),
      defaultTimeoutMs: numberValue(playwright.defaultTimeoutMs),
      allowEvaluate: playwright.allowEvaluate === true,
    });
    enabledPluginIds.push('playwright');
    tools.push(createManagedActionDispatcher({
      name: 'browser_use',
      description: 'Run one Playwright browser action. Load the playwright Skill for actions and arguments.',
      sourcePrefix: 'browser_',
      sourceTools: runtime.tools,
    }));
    skills.push(createManagedActionSkill({
      name: 'playwright',
      description: 'Navigate, inspect, and interact with a controlled browser through one compact dispatcher.',
      whenToUse: 'Use for deterministic browser automation, page inspection, form interaction, and screenshots.',
      dispatcherName: 'browser_use',
      sourcePrefix: 'browser_',
      sourceTools: runtime.tools,
      guidance: ['Prefer snapshot indexes for interaction. Take a new snapshot after navigation or major page changes.'],
    }));
    closers.push(() => runtime.session.close());
  }

  // Tavily/Exa search providers are runtime contributions now
  // (see managedContributions.ts); they no longer live in this switch.

  const imageGen = readStoredManagedPluginConfig(raw, 'image-gen');
  if (imageGen.enabled === true && hasMediaGenSecret(imageGen, 'image')) {
    enabledPluginIds.push('image-gen');
    tools.push(createImageGenTool({
      cwd: options.cwd,
      config: buildImageGenConfigFromStored(imageGen),
      name: 'generate_image',
    }));
  }

  const videoGen = readStoredManagedPluginConfig(raw, 'video-gen');
  if (videoGen.enabled === true && hasMediaGenSecret(videoGen, 'video')) {
    enabledPluginIds.push('video-gen');
    tools.push(createVideoGenTool({
      cwd: options.cwd,
      config: buildVideoGenConfigFromStored(videoGen),
      name: 'generate_video',
    }));
  }

  const meshGen = readStoredManagedPluginConfig(raw, 'mesh-gen');
  if (meshGen.enabled === true && hasMediaGenSecret(meshGen, 'mesh')) {
    enabledPluginIds.push('mesh-gen');
    tools.push(createMeshGenTool({
      cwd: options.cwd,
      config: buildMeshGenConfigFromStored(meshGen),
      name: 'generate_mesh',
    }));
  }

  return {
    tools,
    skills,
    enabledPluginIds,
    close: async () => {
      const errors: unknown[] = [];
      for (const close of closers.reverse()) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more managed plugin runtimes failed to close.');
      }
    },
  };
}

function createKimiAgentTool(
  plugin: ReturnType<typeof createKimiWebBridgePlugin>,
): AgentToolDefinition {
  return tool(
    {
      name: 'kimi_webbridge',
      description:
        'Control the user’s existing signed-in Chrome or Edge browser through the local Kimi WebBridge daemon. Use snapshot refs for reliable interaction.',
      inputSchema: z.strictObject({
        action: z.enum(KIMI_WEBBRIDGE_ALLOWED_ACTIONS),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
      isReadOnly: input =>
        Boolean(
          input
          && readOnlyKimiActions.has(input.action)
          && !kimiActionWritesFile(input.action, input.args),
        ),
      isDestructive: input =>
        Boolean(
          input
          && (
            !readOnlyKimiActions.has(input.action)
            || kimiActionWritesFile(input.action, input.args)
          ),
        ),
      requiresUserInteraction: () => true,
      interruptBehavior: 'cancel',
    },
    async ({ action, args }, context) =>
      plugin.command(action, prepareKimiCommandArgs(action, args, context.cwd)),
  );
}

function kimiActionWritesFile(
  action: KimiWebBridgeAction,
  args: Record<string, unknown> | undefined,
): boolean {
  if (action === 'save_as_pdf' || action === 'upload') return true;
  return action === 'screenshot'
    && Boolean(
      typeof args?.path === 'string'
      || typeof args?.outputPath === 'string',
    );
}

export function prepareKimiCommandArgs(
  action: KimiWebBridgeAction,
  args: Record<string, unknown> | undefined,
  workspaceDir: string,
): Record<string, unknown> {
  const next = { ...(args ?? {}) };
  if (action === 'screenshot' || action === 'save_as_pdf') {
    let foundOutputPath = false;
    const outputFields = new Set(['path', 'outputPath', 'filePath', 'filename']);
    for (const [field, value] of Object.entries(next)) {
      if (/path|file(?:name)?/iu.test(field) && !outputFields.has(field)) {
        throw new TypeError(`Unsupported Kimi WebBridge output path field: ${field}`);
      }
      if (!outputFields.has(field)) continue;
      if (!Object.hasOwn(next, field)) continue;
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`Kimi WebBridge ${field} must be a non-empty string.`);
      }
      next[field] = resolveBrowserScreenshotPath(workspaceDir, value.trim());
      foundOutputPath = true;
    }
    if (action === 'save_as_pdf' && !foundOutputPath) {
      throw new TypeError('Kimi WebBridge save_as_pdf requires a workspace output path.');
    }
  }
  if (action === 'upload') {
    let foundInput = false;
    const inputFields = new Set([
      'files',
      'paths',
      'file',
      'path',
      'filePath',
      'filePaths',
      'file_paths',
    ]);
    for (const [field, value] of Object.entries(next)) {
      if (/path|file/iu.test(field) && !inputFields.has(field)) {
        throw new TypeError(`Unsupported Kimi WebBridge upload path field: ${field}`);
      }
      if (!inputFields.has(field)) continue;
      if (typeof value === 'string') {
        next[field] = resolveKimiInputFile(workspaceDir, value);
        foundInput = true;
        continue;
      }
      if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
        next[field] = value.map(item => resolveKimiInputFile(workspaceDir, item));
        foundInput = true;
        continue;
      }
      throw new TypeError(`Kimi WebBridge upload ${field} must contain one or more file paths.`);
    }
    if (!foundInput) {
      throw new TypeError('Kimi WebBridge upload requires workspace file paths.');
    }
  }
  return next;
}

function resolveKimiInputFile(workspaceDir: string, requestedPath: string): string {
  const workspaceRoot = realpathSync.native(path.resolve(workspaceDir));
  const candidate = path.resolve(workspaceRoot, requestedPath.trim());
  if (!isPathInside(workspaceRoot, candidate)) {
    throw new Error(`Kimi WebBridge upload path must stay inside the workspace: ${requestedPath}`);
  }
  const canonical = realpathSync.native(candidate);
  if (!isPathInside(workspaceRoot, canonical) || !statSync(canonical).isFile()) {
    throw new Error(`Kimi WebBridge upload path must identify a workspace file: ${requestedPath}`);
  }
  return canonical;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function kimiCommandEndpoint(value: string): string {
  const base = value || 'http://127.0.0.1:10086';
  return /\/command\/?$/u.test(base)
    ? base.replace(/\/$/u, '')
    : `${base.replace(/\/+$/u, '')}/command`;
}

function browserChannel(value: unknown): 'chromium' | 'chrome' | 'msedge' | undefined {
  return value === 'chromium' || value === 'chrome' || value === 'msedge'
    ? value
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

// searchCredentialAvailable moved to managedContributions.ts (runtime contributions).
