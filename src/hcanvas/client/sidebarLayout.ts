interface SidebarLayoutState {
  order: string[];
  weights: Record<string, number>;
}

const STORAGE_KEY = 'hcanvas.sidebar.sections.v1';
const DEFAULT_WEIGHTS: Record<string, number> = { canvases: 0.9, pages: 2.0, files: 0.78, plugins: 0.4 };
const MIN_WEIGHT = 0.16;
const DRAG_THRESHOLD = 4;

function readState(): SidebarLayoutState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as SidebarLayoutState;
    if (parsed && Array.isArray(parsed.order) && parsed.weights) return parsed;
  } catch { /* defaults */ }
  return { order: [], weights: {} };
}

/** VS Code-like resizable, reorderable sidebar sections. */
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
    if (!head || head.querySelector('.section-drag-grip')) continue;
    const grip = document.createElement('span');
    grip.className = 'section-drag-grip';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag to reorder';
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Drag to reorder section');
    grip.addEventListener('pointerdown', event => beginReorder(event, section));
    head.insertBefore(grip, head.firstChild);
    const title = head.querySelector<HTMLElement>('.section-title');
    const collapse = head.querySelector<HTMLElement>('.section-collapse-btn');
    if (title && collapse) head.insertBefore(collapse, title);
    title?.addEventListener('pointerdown', event => beginReorder(event, section));
    title?.style.setProperty('cursor', 'grab');
  }

  function totalWeight(): number {
    return sections.reduce((sum, section) => sum + (weights[section.dataset.sidebarSection || ''] || 1), 0);
  }

  function applyWeights(): void {
    const total = totalWeight();
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
      splitter.title = 'Drag to resize';
      splitter.setAttribute('role', 'separator');
      splitter.setAttribute('aria-orientation', 'horizontal');
      splitter.addEventListener('pointerdown', event => beginResize(event, index));
      splitter.addEventListener('dblclick', () => {
        for (const section of sections) {
          const id = section.dataset.sidebarSection || '';
          weights[id] = DEFAULT_WEIGHTS[id] || 1;
        }
        applyWeights();
        persist();
      });
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
    if (event.button !== 0) return;
    event.preventDefault();
    const splitter = event.currentTarget as HTMLElement;
    const before = sections[index];
    const after = sections[index + 1];
    if (!before || !after) return;
    const beforeId = before.dataset.sidebarSection || '';
    const afterId = after.dataset.sidebarSection || '';
    const startY = event.clientY;
    const startBefore = before.getBoundingClientRect().height;
    const startAfter = after.getBoundingClientRect().height;
    const pairHeight = Math.max(1, startBefore + startAfter);
    const pairWeight = (weights[beforeId] || 1) + (weights[afterId] || 1);
    const minHeight = Math.min(44, pairHeight / 2);
    let moved = false;

    const move = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientY - startY;
      if (!moved && Math.abs(delta) < 1) return;
      moved = true;
      document.body.classList.add('sidebar-section-resizing');
      splitter.classList.add('active');
      const nextBefore = Math.max(minHeight, Math.min(pairHeight - minHeight, startBefore + delta));
      const nextAfter = pairHeight - nextBefore;
      weights[beforeId] = pairWeight * (nextBefore / pairHeight);
      weights[afterId] = pairWeight * (nextAfter / pairHeight);
      applyWeights();
    };
    const finish = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', finish);
      splitter.removeEventListener('pointercancel', finish);
      document.body.classList.remove('sidebar-section-resizing');
      splitter.classList.remove('active');
      if (moved) persist();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', finish);
    splitter.addEventListener('pointercancel', finish);
    splitter.setPointerCapture?.(event.pointerId);
  }

  function clearDropHints(): void {
    for (const section of sections) section.classList.remove('section-drop-before', 'section-drop-after');
  }

  function beginReorder(event: PointerEvent, section: HTMLElement): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, .section-collapse-btn, .side-head-actions')) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    let moved = false;
    let target: HTMLElement | null = null;
    let position: 'before' | 'after' = 'before';

    const clear = (): void => {
      section.classList.remove('section-dragging');
      clearDropHints();
      document.body.classList.remove('sidebar-section-reordering');
    };
    const update = (moveEvent: PointerEvent): void => {
      if (!moved && Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      document.body.classList.add('sidebar-section-reordering');
      section.classList.add('section-dragging');
      const candidate = (document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-sidebar-section]')) as HTMLElement | null;
      clearDropHints();
      target = candidate && candidate !== section ? candidate : null;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      position = moveEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      target.classList.add(position === 'before' ? 'section-drop-before' : 'section-drop-after');
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (moved && target) {
        const targetIndex = sections.indexOf(target);
        const sourceIndex = sections.indexOf(section);
        sections.splice(sourceIndex, 1);
        let insertIndex = targetIndex + (position === 'after' ? 1 : 0);
        if (sourceIndex < insertIndex) insertIndex -= 1;
        sections.splice(insertIndex, 0, section);
        rebuildDom();
        persist();
      }
      clear();
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  rebuildDom();
  window.addEventListener('resize', applyWeights);
}
