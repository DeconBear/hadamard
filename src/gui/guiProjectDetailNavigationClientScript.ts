export const GUI_PROJECT_DETAIL_NAVIGATION_CLIENT_SCRIPT = String.raw`
function setProjectDetailTab(tab) {
  const allowed = { document: 1, issues: 1, agents: 1, research: 1, settings: 1 };
  const next = allowed[tab] ? tab : 'document';
  if (state.projectDetailTab === next) {
    if (next === 'research') void mountResearchPanel();
    else if (next === 'agents') void refreshAgentExecutions(true);
    else if (next === 'settings') void mountProjectSettingsPanel(false);
    return;
  }
  if (state.projectDetailTab === 'document' && state.projectDocDirty) void saveProjectDocNow();
  if (state.projectDetailTab === 'settings' && state.projectSettingsDirty) void saveProjectSettingsNow();
  if (next !== 'agents') stopAgentExecutionPolling();
  if (next !== 'research') stopResearchPolling();
  state.projectDetailTab = next;
  let activeTab = null;
  document.querySelectorAll('.project-detail-tab').forEach((btn) => {
    const active = btn.dataset.detailTab === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    if (active) activeTab = btn;
  });
  if (activeTab) requestAnimationFrame(revealActiveProjectDetailTab);
  const panels = {
    document: el('projectDocumentPanel'),
    issues: el('projectIssuesPanel'),
    agents: el('agentExecutionsPanel'),
    research: el('projectResearchPanel'),
    settings: el('projectSettingsPanel'),
  };
  for (const key of Object.keys(panels)) {
    if (panels[key]) panels[key].classList.toggle('hidden', key !== next);
  }
  if (next === 'document') void mountProjectDoc(false);
  else if (next === 'issues') void loadProjectIssues(false);
  else if (next === 'agents') void refreshAgentExecutions(true);
  else if (next === 'settings') void mountProjectSettingsPanel(false);
  else if (next === 'research') void mountResearchPanel();
}
`;
