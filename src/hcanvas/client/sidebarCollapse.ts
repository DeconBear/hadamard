import { installSidebarLayout } from './sidebarLayout.js';

export function bindSidebarSections(): void {
  const sections = document.getElementById('sidebarSections');
  if (sections) installSidebarLayout(sections);
}
