import type { HcBlock, HcConnectorPort } from '../types.js';
import { esc } from './utils.js';

export function arrowInspectorMarkup(block: HcBlock): string {
  const route = block.connectorRoute || 'straight';
  const ports = ['auto', 'top', 'right', 'bottom', 'left', 'center'];
  const options = (value?: string) => ports.map(port => '<option value="' + port + '"' + ((value || 'auto') === port ? ' selected' : '') + '>' + port + '</option>').join('');
  let html = '<div class="field"><span>Arrowhead</span><select id="blockArrowhead"><option value="arrow"' + ((block.arrowhead ?? 'arrow') === 'arrow' ? ' selected' : '') + '>Arrow</option><option value="none"' + (block.arrowhead === 'none' ? ' selected' : '') + '>None</option></select></div>';
  html += '<div class="field"><span>Route</span><select id="blockConnectorRoute"><option value="straight"' + (route === 'straight' ? ' selected' : '') + '>Straight</option><option value="orthogonal"' + (route === 'orthogonal' ? ' selected' : '') + '>Orthogonal</option></select></div>';
  html += '<div class="field-row"><div class="field"><span>Start anchor</span><select id="blockStartPort">' + options(block.startPort) + '</select></div><div class="field"><span>End anchor</span><select id="blockEndPort">' + options(block.endPort) + '</select></div></div>';
  html += '<div class="field"><span>Label</span><input id="blockArrowLabel" type="text" value="' + esc(block.label || '') + '"></div>';
  return html;
}

export function bindArrowInspector(block: HcBlock, root: HTMLElement, update: (patch: Partial<HcBlock>) => void): void {
  const arrowhead = root.querySelector<HTMLSelectElement>('#blockArrowhead');
  const route = root.querySelector<HTMLSelectElement>('#blockConnectorRoute');
  const startPort = root.querySelector<HTMLSelectElement>('#blockStartPort');
  const endPort = root.querySelector<HTMLSelectElement>('#blockEndPort');
  const label = root.querySelector<HTMLInputElement>('#blockArrowLabel');
  if (arrowhead) arrowhead.addEventListener('change', () => update({ arrowhead: arrowhead.value === 'none' ? 'none' : 'arrow' }));
  if (route) route.addEventListener('change', () => update({ connectorRoute: route.value === 'orthogonal' ? 'orthogonal' : 'straight' }));
  if (startPort) startPort.addEventListener('change', () => update({ startPort: startPort.value as HcConnectorPort }));
  if (endPort) endPort.addEventListener('change', () => update({ endPort: endPort.value as HcConnectorPort }));
  if (label) label.addEventListener('change', () => update({ label: label.value }));
}
