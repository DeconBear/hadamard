import type { HcPage } from '../types.js';

export interface ImageInsertOptions {
  getPage(): HcPage | null;
  getPoint(clientX: number, clientY: number): { x: number; y: number };
  getCenter(): { x: number; y: number };
  addImage(src: string, alt: string, width: number, height: number, point: { x: number; y: number }): Promise<void>;
  onPasteText?(text: string): boolean;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list || []).filter(file => file.type.startsWith('image/'));
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.matches?.('input, textarea, [contenteditable="true"]') || element.closest?.('.cm-editor')));
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function dimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 480, height: image.naturalHeight || 320 });
    image.onerror = () => resolve({ width: 480, height: 320 });
    image.src = src;
  });
}

export function installImageInsert(options: ImageInsertOptions): void {
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (!viewport) return;
  let dragDepth = 0;
  const canInsert = (): boolean => {
    const page = options.getPage();
    if (!page) return false;
    if (page.mode === 'html' || page.mode === 'whiteboard') {
      options.toast('Switch to a Canvas or Infinite page to insert images.', 'info');
      return false;
    }
    return true;
  };
  const insertFiles = async (files: File[], point: { x: number; y: number }): Promise<void> => {
    if (!files.length || !canInsert()) return;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      try {
        const src = await dataUrl(file);
        const size = await dimensions(src);
        const maxW = 640;
        const maxH = 480;
        const scale = Math.min(1, maxW / size.width, maxH / size.height);
        const width = Math.max(40, Math.round(size.width * scale));
        const height = Math.max(30, Math.round(size.height * scale));
        await options.addImage(src, file.name || 'Image', width, height, { x: point.x + index * 28, y: point.y + index * 28 });
      } catch (error) {
        options.toast(error instanceof Error ? error.message : 'Could not insert image', 'error');
      }
    }
  };
  viewport.addEventListener('dragenter', event => {
    if (!imageFiles(event.dataTransfer?.files).length) return;
    event.preventDefault();
    dragDepth += 1;
    viewport.classList.add('image-drop-active');
  });
  viewport.addEventListener('dragover', event => {
    if (!imageFiles(event.dataTransfer?.files).length) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('image-drop-active');
  });
  viewport.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) viewport.classList.remove('image-drop-active');
  });
  viewport.addEventListener('drop', event => {
    const files = imageFiles(event.dataTransfer?.files);
    dragDepth = 0;
    viewport.classList.remove('image-drop-active');
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void insertFiles(files, options.getPoint(event.clientX, event.clientY));
  });
  document.addEventListener('paste', event => {
    if (isTypingTarget(event.target)) return;
    const files = imageFiles(event.clipboardData?.files);
    if (files.length) {
      event.preventDefault();
      void insertFiles(files, options.getCenter());
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (options.onPasteText?.(text)) event.preventDefault();
  });
}