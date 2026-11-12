const STORAGE_KEY = 'hcanvas.sidebar.navigator.v1';
const DEFAULT_SECTION = 'pages';

const SECTION_ICONS: Record<string, string> = {
  canvases: '<rect x="3" y="4" width="12" height="10" rx="2"/><path d="M7 16v2m5-7h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2"/>',
  pages: '<path d="M5 3h8l4 4v11H5z"/><path d="M13 3v5h4M8 11h6m-6 4h6"/>',
  files: '<path d="M3 7V4h6l2 3h7v11H3z"/><path d="M3 9h15"/>',
  assets: '<rect x="3" y="3" width="16" height="16" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 3 3 3-5 3 4"/>',
  plugins: '<path d="M8 3v4m6-4v4M6 7h10v4a5 5 0 0 1-10 0zM11 16v3"/>',
};

export function nextSidebarSection(current: number, key: string, count: number): number {
  if (!count) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

export function installSidebarLayout(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const sidebar = container.parentElement;
  if (!sidebar) return;
  const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-section]'));
  const ids = sections.map(section => section.dataset.sidebarSection || '').filter(Boolean);
  let active = DEFAULT_SECTION;
  try {
    const saved = doc.defaultView?.localStorage.getItem(STORAGE_KEY);
    if (saved && ids.includes(saved)) active = saved;
  } catch { /* use the default section */ }
  if (!ids.includes(active)) active = ids[0] || DEFAULT_SECTION;
  const queries: Record<string, string> = {};

  const navigation = doc.createElement('nav');
  navigation.className = 'workspace-nav';
  navigation.setAttribute('aria-label', 'Workspace sections');
  navigation.setAttribute('role', 'tablist');
  navigation.innerHTML = ids.map(id => {
    const label = sections.find(section => section.dataset.sidebarSection === id)?.querySelector('.section-title')?.textContent || id;
    return '<button type="button" role="tab" class="workspace-nav-item" data-sidebar-target="' + id + '" aria-controls="sidebar-panel-' + id + '" title="' + label + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (SECTION_ICONS[id] || SECTION_ICONS.pages) + '</svg>' +
      '<span class="workspace-nav-label">' + label + '</span><span class="workspace-nav-count"></span></button>';
  }).join('');
  container.before(navigation);

  const filter = doc.createElement('div');
  filter.className = 'sidebar-filter';
  filter.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8.5" cy="8.5" r="5"/><path d="m12.5 12.5 4 4"/></svg><input type="search" aria-label="Filter sidebar items" autocomplete="off" spellcheck="false"><kbd>Ctrl F</kbd>';
  navigation.after(filter);
  const filterInput = filter.querySelector<HTMLInputElement>('input')!;
  const resultCount = doc.createElement('span');
  resultCount.className = 'sidebar-result-count';
  resultCount.setAttribute('aria-live', 'polite');
  filter.appendChild(resultCount);

  const items = (): HTMLElement[] => {
    const panel = sections.find(section => section.dataset.sidebarSection === active);
    if (!panel) return [];
    const selector = active === 'canvases' ? '.doc-item' : active === 'pages' ? '.page-open' : '';
    return selector ? Array.from(panel.querySelectorAll<HTMLElement>(selector)) : [];
  };

  const applyFilter = (): void => {
    const query = (queries[active] || '').trim().toLocaleLowerCase();
    let visible = 0;
    for (const item of items()) {
      const show = !query || (item.textContent || '').toLocaleLowerCase().includes(query);
      const row = item.closest<HTMLElement>('.page-item') || item;
      row.hidden = !show;
      item.tabIndex = show ? 0 : -1;
      if (show) visible += 1;
    }
    filterInput.value = queries[active] || '';
    resultCount.textContent = query ? String(visible) : '';
  };

  const updateCounts = (): void => {
    for (const button of Array.from(navigation.querySelectorAll<HTMLButtonElement>('[data-sidebar-target]'))) {
      const id = button.dataset.sidebarTarget;
      const count = id === 'pages' ? container.querySelectorAll('.page-item').length : id === 'canvases' ? container.querySelectorAll('.doc-item').length : 0;
      const badge = button.querySelector<HTMLElement>('.workspace-nav-count')!;
      badge.textContent = count ? String(count) : '';
      badge.hidden = !count;
    }
  };

  const activate = (id: string): void => {
    if (!ids.includes(id)) return;
    active = id;
    for (const section of sections) {
      const selected = section.dataset.sidebarSection === id;
      section.hidden = !selected;
      section.classList.toggle('sidebar-panel-active', selected);
      section.id = 'sidebar-panel-' + section.dataset.sidebarSection;
      section.setAttribute('role', 'tabpanel');
    }
    for (const button of Array.from(navigation.querySelectorAll<HTMLButtonElement>('[data-sidebar-target]'))) {
      const selected = button.dataset.sidebarTarget === id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    filter.hidden = id !== 'canvases' && id !== 'pages';
    filterInput.placeholder = id === 'pages' ? 'Find a page…' : 'Find a canvas…';
    applyFilter();
    try { doc.defaultView?.localStorage.setItem(STORAGE_KEY, id); } catch { /* preferences are optional */ }
  };

  navigation.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sidebar-target]');
    if (button?.dataset.sidebarTarget) activate(button.dataset.sidebarTarget);
  });
  navigation.addEventListener('keydown', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sidebar-target]');
    if (!button) return;
    const next = nextSidebarSection(ids.indexOf(button.dataset.sidebarTarget || ''), event.key, ids.length);
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    activate(ids[next]!);
    navigation.querySelectorAll<HTMLButtonElement>('[data-sidebar-target]')[next]?.focus();
  });
  filterInput.addEventListener('input', () => { queries[active] = filterInput.value; applyFilter(); });
  filter.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      queries[active] = '';
      applyFilter();
      navigation.querySelector<HTMLButtonElement>('[data-sidebar-target="' + active + '"]')?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items().find(item => item.tabIndex === 0)?.focus();
    }
  });
  container.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.matches('input,textarea,[contenteditable="true"]')) return;
    const list = items().filter(item => !item.hidden && !(item.closest('.page-item') as HTMLElement | null)?.hidden);
    const current = list.indexOf(target.closest('.doc-item, .page-open') as HTMLElement);
    const next = nextSidebarSection(current < 0 ? 0 : current, event.key, list.length);
    if (next < 0 || !list[next]) return;
    event.preventDefault();
    event.stopPropagation();
    list[next].focus();
  });
  sidebar.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || filter.hidden) return;
    event.preventDefault();
    filterInput.focus();
    filterInput.select();
  });
  let refreshFrame = 0;
  const observer = new MutationObserver(() => {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; updateCounts(); applyFilter(); });
  });
  for (const id of ['docsList', 'pagesList']) {
    const root = doc.getElementById(id);
    if (root) observer.observe(root, { childList: true, subtree: true });
  }
  activate(active);
}
