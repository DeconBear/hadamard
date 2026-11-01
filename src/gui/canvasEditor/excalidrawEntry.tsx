import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Excalidraw } from '@excalidraw/excalidraw';
// The package's "./*" export maps to types only; import the shipped CSS directly.
import excalidrawCss from '../../../node_modules/@excalidraw/excalidraw/dist/prod/index.css';

declare global {
  interface Window {
    HadamardExcalidraw?: {
      mount: (element: HTMLElement, options?: ExcalidrawMountOptions) => ExcalidrawMountHandle;
      version: string;
    };
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

export interface ExcalidrawMountOptions {
  initialData?: Record<string, unknown>;
  theme?: 'light' | 'dark';
  viewModeEnabled?: boolean;
  zenModeEnabled?: boolean;
  onReady?: (api: unknown) => void;
  onChange?: (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => void;
}

export interface ExcalidrawMountHandle {
  unmount: () => void;
  getApi: () => unknown;
  updateScene: (scene: Record<string, unknown>) => void;
  getScene: () => { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> };
  resize: () => void;
}

// Excalidraw loads fonts and data assets from this path; the GUI serves the
// vendored excalidraw assets locally (no network access).
window.EXCALIDRAW_ASSET_PATH = '/gui-canvas/';

function injectCss(): void {
  if (document.getElementById('hadamard-excalidraw-css')) return;
  const style = document.createElement('style');
  style.id = 'hadamard-excalidraw-css';
  style.textContent = String(excalidrawCss);
  document.head.appendChild(style);
}

function mount(element: HTMLElement, options: ExcalidrawMountOptions = {}): ExcalidrawMountHandle {
  injectCss();
  element.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'hadamard-excalidraw-host';
  host.style.cssText = 'position:absolute;inset:0;';
  element.appendChild(host);
  let api: any = null;
  let latestScene = { elements: [] as unknown[], appState: {} as Record<string, unknown>, files: {} as Record<string, unknown> };
  let root: Root | null = null;

  const handleChange = (elements: readonly unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
    latestScene = { elements: [...elements], appState, files };
    options.onChange?.(latestScene.elements, appState, files);
  };

  root = createRoot(host);
  root.render(React.createElement(Excalidraw, {
    initialData: options.initialData,
    theme: options.theme || 'light',
    viewModeEnabled: options.viewModeEnabled || false,
    zenModeEnabled: options.zenModeEnabled || false,
    excalidrawAPI: (instance: unknown) => {
      api = instance;
      options.onReady?.(instance);
    },
    onChange: handleChange,
    UIOptions: {
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
      },
    },
  } as any));

  const resize = () => {
    try { api?.refresh?.(); } catch { /* older builds */ }
    window.dispatchEvent(new Event('resize'));
  };
  window.addEventListener('resize', resize);
  return {
    unmount() {
      window.removeEventListener('resize', resize);
      try { root?.unmount(); } catch { /* ignore */ }
      element.innerHTML = '';
    },
    getApi: () => api,
    updateScene(scene) {
      api?.updateScene?.(scene);
    },
    getScene: () => latestScene,
    resize,
  };
}

window.HadamardExcalidraw = { mount, version: '0.18.1' };
export {};
