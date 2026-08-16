export function getGuiBridgeContextClientScript(
  contextWindows: readonly number[],
): string {
  return String.raw`
function pickerConfigModels(config) {
  const names = [];
  const add = (value) => {
    const name = String(value || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };
  add(config?.model);
  for (const item of config?.models || []) add(item?.name);
  return names;
}

function pickerTargetModel(target) {
  if (target?.kind === 'agent') return target.agent.model;
  const active = state.snapshot?.bridgeState?.activeConfig;
  if (active?.name === target?.name && active.model) return active.model;
  return pickerConfigModels(target?.config)[0] || target?.config?.model || '';
}

function pickerModelMetadata(target, modelName) {
  const config = target?.kind === 'agent'
    ? (state.snapshot?.bridgeState?.configs || []).find(item => item.name === target.agent.bridgeConfig)
    : target?.config;
  return (config?.models || []).find(item => item.name === modelName) || null;
}

function pickerContextOptions() {
  return ${JSON.stringify(contextWindows)};
}

function formatPickerContextWindow(tokens) {
  if (tokens >= 1000000 && tokens % 1000000 === 0) return (tokens / 1000000) + 'M';
  if (tokens >= 1000 && tokens % 1000 === 0) return (tokens / 1000) + 'k';
  return Number(tokens).toLocaleString();
}

function appendBridgeUseButton(footer, cfg, isActive, bridgeEnabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = isActive ? 'Current' : (cfg.isDefault ? 'Use default' : 'Use');
  button.disabled = isActive || (!cfg.isDefault && !bridgeEnabled);
  if (!cfg.isDefault && !bridgeEnabled) {
    button.title = 'Enable Bridge mode above before selecting this config.';
  }
  button.addEventListener('click', () => {
    if (cfg.isDefault) void disableBridge();
    else void activateBridgeConfig(cfg.name);
  });
  footer.appendChild(button);
}
`;
}
