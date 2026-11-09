interface SidebarLayoutState {
  order: string[];
  weights: Record<string, number>;
}

const STORAGE_KEY = 'hcanvas.sidebar.sections.v1';
const DEFAULT_WEIGHTS: Record<string, number> = { canvases: 0.9, pages: 2.0, files: 0.78, plugins: 0.4 };
const MIN_WEIGHT = 0.16;

function readState(): SidebarLayoutState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as SidebarLayoutState;
    if (parsed && Array.isArray(parsed.order) && parsed.weights) return parsed;
  } catch { /* defaults */ }
  return { order: [], weights: {} };
}

/** Resizable and reorderable Canvases / Pages / Files / Plugins sections. */
export function installSidebarLayout(container: HTMLElement): void {
  const saved = readState();
  let sections = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-section]'));
  const byId = new Map(sections.map(section => [section.dataset.sidebarSection || '', section]));
  const ordered = saved.order.map(id => byId.get(id)).filter((section): section is HTMLElement => Boolean(section));
  for (const section of sections) if (!ordered.includes(section)) ordered.push(section);
  sections = ordered;
  const weights: Record<string, number> = {};
  for (const section of sections) {
    const id = section.dataset.sidebarSection || '';
    weights[id] = Number.isFinite(saved.weights[id]) && saved.weights[id] > 0 ? saved.weights[id] : DEFAULT_WEIGHTS[id] || 1;
  }

  for (const section of sections) {
    const head = section.querySelector<HTMLElement>('.side-head');
    if (head && !head.querySelector('.section-drag-grip')) {
      const grip = document.createElement('span');
      grip.className = 'section-drag-grip';
      grip.textContent = '⋮⋮';
      grip.title = 'Drag to reorder section';
      grip.draggable = true;
      grip.addEventListener('dragstart', event => {
        event.dataTransfer?.setData('text/plain', section.dataset.sidebarSection || '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        section.classList.add('section-dragging');
      });
      grip.addEventListener('dragend', () => section.classList.remove('section-dragging'));
      head.insertBefore(grip, head.firstChild);
      const title = head.querySelector('.section-title');
      const collapse = head.querySelector('.section-collapse-btn');
      if (title && collapse) head.insertBefore(collapse, title);
    }
  }

  function applyWeights(): void {
    const total = sections.reduce((sum, section) => sum + (weights[section.dataset.sidebarSection || ''] || 1), 0);
    for (const section of sections) {
      const id = section.dataset.sidebarSection || '';
      section.style.flex = (weights[id] || 1) + ' 1 0px';
    }
    container.dataset.sidebarTotal = String(total);
  }

  function rebuildSplitters(): void {
    container.querySelectorAll('.sidebar-section-splitter').forEach(node => node.remove());
    for (let index = 0; index < sections.length - 1; index += 1) {
      const splitter = document.createElement('div');
      splitter.className = 'sidebar-section-splitter';
      splitter.title = 'Drag to resize sections';
      splitter.addEventListener('pointerdown', event => beginResize(event, index));
      sections[index]!.after(splitter);
    }
  }

  function rebuildDom(): void {
    for (const section of sections) container.appendChild(section);
    rebuildSplitters();
    applyWeights();
  }

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: sections.map(section => section.dataset.sidebarSection || ''), weights }));
  }

  function beginResize(event: PointerEvent, index: number): void {
    event.preventDefault();
    const splitter = event.currentTarget as HTMLElement;
    const before = sections[index];
    const after = sections[index + 1];
    if (!before || !after) return;
    const beforeId = before.dataset.sidebarSection || '';
    const afterId = after.dataset.sidebarSection || '';
    const startY = event.clientY;
    const totalWeight = sections.reduce((sum, section) => sum + (weights[section.dataset.sidebarSection || ''] || 1), 0);
    const containerHeight = Math.max(240, container.getBoundingClientRect().height);
    const minWeight = Math.max(MIN_WEIGHT, 48 / containerHeight * totalWeight);
    const startBefore = weights[beforeId] || 1;
    const startAfter = weights[afterId] || 1;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-section-resizing');
    const move = (moveEvent: PointerEvent): void => {
      const delta = (moveEvent.clientY - startY) / containerHeight * totalWeight;
      const nextBefore = Math.max(minWeight, startBefore + delta);
      const nextAfter = Math.max(minWeight, startAfter - delta);
      if (nextBefore <= minWeight && delta < 0) return;
      if (nextAfter <= minWeight && delta > 0) return;
      weights[beforeId] = nextBefore;
      weights[afterId] = nextAfter;
      applyWeights();
    };
    const up = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      document.body.classList.remove('sidebar-section-resizing');
      persist();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  }

  container.addEventListener('dragover', event => {
    const dragging = container.querySelector<HTMLElement>('.section-dragging');
    if (!dragging) return;
    event.preventDefault();
    const target = (document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-sidebar-section]')) as HTMLElement | null;
    for (const section of sections) section.classList.remove('section-drop-before', 'section-drop-after');
    if (!target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientY < rect.top + rect.height / 2 ? 'section-drop-before' : 'section-drop-after');
  });
  container.addEventListener('drop', event => {
    const dragging = container.querySelector<HTMLElement>('.section-dragging');
    if (!dragging) return;
    event.preventDefault();
    const target = (document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-sidebar-section]')) as HTMLElement | null;
    if (target && target !== dragging) {
      const targetIndex = sections.indexOf(target);
      const draggingIndex = sections.indexOf(dragging);
      const insertIndex = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? targetIndex : targetIndex + 1;
      sections.splice(draggingIndex, 1);
      sections.splice(insertIndex > draggingIndex ? insertIndex - 1 : insertIndex, 0, dragging);
      rebuildDom();
      persist();
    }
    for (const section of sections) section.classList.remove('section-drop-before', 'section-drop-after', 'section-dragging');
  });

  rebuildDom();
  window.addEventListener('resize', applyWeights);
}
