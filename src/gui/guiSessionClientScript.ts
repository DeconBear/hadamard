export const GUI_SESSION_CREATE_CLIENT_SCRIPT = String.raw`
async function performCreateSession(requestSequence, projectPath) {
  try {
    if (requestSequence !== sessionResumeSequence) return;
    const res = await api('/api/session/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(projectPath ? { projectPath } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (requestSequence !== sessionResumeSequence) return;
    if (!res.ok) {
      const message = (await res.text()) || 'Could not create a new conversation.';
      flashStatus(message);
      return;
    }
    const snapshot = await res.json();
    if (requestSequence !== sessionResumeSequence) return;
    const nextSessionId = snapshot?.session?.id;
    if (!nextSessionId) throw new Error('The server did not report a new conversation.');
    // Brand-new conversations must never inherit a stale transcript cache entry.
    delete state.transcriptCache[nextSessionId];
    await activateResumedSession(snapshot, requestSequence);
  } catch {
    // The server may already have switched even if the create response failed.
    try {
      const activeRes = await api('/api/session/active', { signal: AbortSignal.timeout(8_000) });
      if (!activeRes.ok || requestSequence !== sessionResumeSequence) {
        flashStatus('Could not finish creating a new conversation.');
        return;
      }
      const payload = await activeRes.json();
      const activeSession = payload?.session;
      if (!activeSession?.id) {
        flashStatus('Could not finish creating a new conversation.');
        return;
      }
      delete state.transcriptCache[activeSession.id];
      await activateResumedSession(
        Object.assign({}, state.snapshot || {}, { session: activeSession }),
        requestSequence,
      );
      void loadState();
    } catch {
      flashStatus('Could not finish creating a new conversation.');
    }
  } finally {
    if (requestSequence === sessionResumeSequence) setSessionResumePending(false);
  }
}
function createNewSession(projectPath) {
  if (state.sessionResumePending) {
    flashStatus('A conversation switch is already in progress.');
    return sessionResumeQueue;
  }
  const requestSequence = ++sessionResumeSequence;
  setSessionResumePending(true);
  const pending = sessionResumeQueue
    .catch(() => undefined)
    .then(() => performCreateSession(requestSequence, projectPath));
  sessionResumeQueue = pending.catch(() => undefined);
  return pending;
}
`;

export const GUI_SESSION_CENTER_OPEN_CLIENT_SCRIPT = String.raw`
async function openSessionCenterItem(item) {
  try {
    if (state.sessionResumePending) {
      flashStatus('A conversation switch is already in progress.');
      return;
    }
    const requestSequence = ++sessionResumeSequence;
    setSessionResumePending(true);
    try {
      const payload = await sessionCenterAction('open', item);
      if (requestSequence !== sessionResumeSequence) return;
      if (item.type === 'agent') {
        switchProjectView('detail');
        setProjectDetailTab('agents');
        return;
      }
      if (item.type === 'assistant-global' || item.type === 'assistant-project') {
        if (item.type === 'assistant-project') switchProjectView('detail');
        setAssistantScope(item.type === 'assistant-global' ? 'global' : 'project', { refresh: false, force: true });
        setManagerUiMode('compact');
        await refreshManagerState(true);
        return;
      }
      if (payload.state) {
        await activateResumedSession(payload.state, requestSequence);
      } else {
        await loadState();
        switchProjectView('conversation');
      }
    } finally {
      if (requestSequence === sessionResumeSequence) setSessionResumePending(false);
    }
  } catch (error) {
    flashStatus('Open failed: ' + (error.message || error));
  }
}
`;
