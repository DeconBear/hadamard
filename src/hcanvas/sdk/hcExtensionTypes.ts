/**
 * Public types for Hcanvas extension manifests and the viewer SDK.
 *
 * These declarations are advisory: the host validates manifests at runtime with
 * `hcanvas-extension/1`. Copy them into an extension project (or import the file
 * directly during development) to get editor completion.
 */

export type HcExtensionViewerSurface = 'file' | 'tab' | 'page';

export type HcExtensionCapabilities = {
  document?: { read?: boolean; write?: boolean };
  workspace?: { read?: string[]; write?: string[] };
  network?: { allow?: string[] };
  process?: { sidecars?: string[]; tools?: string[]; terminals?: string[] };
  ui?: string[];
  commands?: string[];
  menus?: string[];
  configuration?: string[];
};

export type HcExtensionFormatContribution = {
  id: string;
  label?: string;
  extensions: string[];
  viewer: string;
  surfaces?: HcExtensionViewerSurface[];
  priority?: 'default' | 'optional';
};

export type HcExtensionViewerContribution = {
  id: string;
  label?: string;
  type: 'iframe' | 'builtin';
  builtinId?: string;
  entry?: string;
  surfaces?: HcExtensionViewerSurface[];
  resources?: string[];
  singleton?: boolean;
};

export type HcExtensionViewContribution = {
  id: string;
  title: string;
  slot?: string;
  viewer: string;
  icon?: string;
};

export type HcExtensionCommandContribution = {
  id: string;
  title: string;
  category?: string;
  exec?: { kind: 'view'; viewId: string } | { kind: 'command'; commandId: string } | { kind: 'sidecar'; sidecarId: string; method: string };
};

export type HcExtensionSidecarContribution = {
  id: string;
  label?: string;
  command: string[];
  cwd?: 'extension' | 'workspace';
  env?: Record<string, string>;
  role?: 'service' | 'language-server';
  protocol?: 'jsonrpc-stdio' | 'lines';
  requests?: { method: string; timeoutMs?: number }[];
  outputChannel?: string;
  limits?: { maxStdoutBytes?: number; maxStderrBytes?: number };
};

export type HcExtensionKernelContribution = {
  id: string;
  label?: string;
  language: string;
  sidecar: string;
  defaultFor?: string[];
};

export type HcExtensionManifest = {
  schema: 'hcanvas-extension/1';
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  engines?: { hcanvas?: string };
  activation?: string[];
  capabilities?: HcExtensionCapabilities;
  builtin?: boolean;
  dev?: boolean;
  contributes?: {
    formats?: HcExtensionFormatContribution[];
    viewers?: HcExtensionViewerContribution[];
    views?: HcExtensionViewContribution[];
    commands?: HcExtensionCommandContribution[];
    sidecars?: HcExtensionSidecarContribution[];
    kernels?: HcExtensionKernelContribution[];
    configuration?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type HcViewerFileContext = { rootId: string; path: string; readOnly?: boolean };
export type HcViewerPageContext = { pageId?: string; format?: string; data?: unknown };

export type HcViewerContext = {
  instanceId: string;
  extensionId: string;
  viewId: string;
  surface: string;
  sdkVersion?: string;
  capabilities?: Record<string, unknown>;
  file?: HcViewerFileContext;
  page?: HcViewerPageContext;
};

export type HcSidecarJob = {
  onProgress(handler: (progress: unknown) => void): () => void;
  onOutput(handler: (chunk: unknown) => void): () => void;
  done: Promise<unknown>;
  cancel(): Promise<void>;
};

/** Subset of the runtime viewer API; see /api/extension-sdk/hc-extension-api.js. */
export type HcExtensionApi = {
  context: HcViewerContext;
  files: {
    read(rootId: string, path: string, encoding?: 'utf8' | 'base64'): Promise<{ content: string; size?: number }>;
    write(rootId: string, path: string, content: string): Promise<{ ok: boolean }>;
  };
  document: {
    read(): Promise<{ format?: string; data: unknown; readOnly?: boolean }>;
    apply(ops: unknown[]): Promise<{ ok?: boolean; revision?: number }>;
  };
  commands: { list(): Promise<{ commands: { id: string; title: string }[] }>; execute(id: string): Promise<{ ok: boolean }> };
  sidecars: { request(sidecarId: string, method: string, params?: unknown): HcSidecarJob };
  kernels: {
    list(): Promise<{ kernels: { id: string; label?: string; language: string }[] }>;
    execute(kernelId: string, code: string, options?: unknown): Promise<{ onOutput(handler: (event: unknown) => void): void; done: Promise<unknown> }>;
  };
  ui: { toast(message: string, kind?: 'info' | 'success' | 'error'): void; setTitle(title: string): void };
};
