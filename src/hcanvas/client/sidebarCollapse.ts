import { installSidebarLayout } from './sidebarLayout.js';

export function bindSidebarSections(): void {
  const bindings: Array<[string, string, string]> = [
    ['collapseDocsBtn', 'docsList', 'canvases'],
    ['collapsePagesBtn', 'pagesList', 'pages'],
  ];
  for (const [buttonId, listId, label] of bindings) {
    const button = document.getElementById(buttonId);
    const list = document.getElementById(listId);
    if (!button || !list) continue;
    button.addEventListener('click', () => {
      list.classList.toggle('hidden');
      const collapsed = list.classList.contains('hidden');
      list.closest('.side-section')?.classList.toggle('section-collapsed', collapsed);
      button.textContent = collapsed ? '▸' : '▾';
      button.title = (collapsed ? 'Expand ' : 'Collapse ') + label;
    });
  }
  const sections = document.getElementById('sidebarSections');
  if (sections) installSidebarLayout(sections);
}
