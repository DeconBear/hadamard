export interface CanvasWheelInput {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export interface CanvasWheelActions {
  mode: string;
  pan(deltaX: number, deltaY: number): void;
  zoomAt(factor: number, clientX: number, clientY: number): void;
}

/** Shared navigation for the canvas viewport and wheel gestures forwarded from HTML blocks. */
export function handleCanvasWheel(input: CanvasWheelInput, actions: CanvasWheelActions): boolean {
  if (actions.mode === 'html') return false;
  input.preventDefault();
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? 1 : 1;
  const deltaX = input.deltaX * unit;
  const deltaY = input.deltaY * unit;
  const pinch = Boolean(input.ctrlKey || input.metaKey);
  const trackpadPan = !pinch && !input.shiftKey && input.deltaMode === 0 && (Math.abs(deltaX) > 0 || Math.abs(deltaY) < 48);
  if (pinch) {
    actions.zoomAt(Math.exp(-deltaY * 0.008), input.clientX, input.clientY);
    return true;
  }
  if (trackpadPan) {
    actions.pan(-deltaX, -deltaY);
    return true;
  }
  if (input.shiftKey) {
    actions.pan(-(Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY), 0);
    return true;
  }
  actions.zoomAt(Math.exp(-deltaY * 0.002), input.clientX, input.clientY);
  return true;
}

export interface BlockWheelMessage {
  blockId?: string;
  deltaMode?: number;
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

export function handleBlockWheelMessage(data: BlockWheelMessage, actions: CanvasWheelActions): void {
  if (!data.blockId) return;
  const iframe = document.querySelector<HTMLIFrameElement>('.block-wrap[data-block-id="' + data.blockId.replace(/"/g, '\\"') + '"] iframe');
  const rect = iframe?.getBoundingClientRect();
  handleCanvasWheel({
    deltaMode: Number(data.deltaMode) || 0,
    deltaX: Number(data.deltaX) || 0,
    deltaY: Number(data.deltaY) || 0,
    ctrlKey: Boolean(data.ctrlKey),
    metaKey: Boolean(data.metaKey),
    shiftKey: Boolean(data.shiftKey),
    clientX: (rect?.left || 0) + (Number(data.clientX) || 0),
    clientY: (rect?.top || 0) + (Number(data.clientY) || 0),
    preventDefault: () => undefined,
  }, actions);
}

export function installCanvasWheel(viewport: HTMLElement, getActions: () => CanvasWheelActions, ignoredSelector: string): void {
  viewport.addEventListener('wheel', event => {
    if ((event.target as Element).closest(ignoredSelector)) return;
    handleCanvasWheel(event, getActions());
  }, { passive: false });
}
