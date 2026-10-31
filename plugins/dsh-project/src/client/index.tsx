import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import { ProjectPage } from './projectHome.js';

export const inject = ['slots', 'connection'];
export const PANEL_ID = 'hadamard-project';

export function apply(ctx: Context): void {
  // Host and client Context merges differ; keep the browser face explicit here.
  const rpc = ctx.connection.rpc as unknown as ClientConnectionRpc;
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID,
  }, () => <ProjectPage rpc={rpc} />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: '项目管理',
  }, ({ size }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M3 9h18M9 9v11M13 13h4M13 16h3" />
  </svg>));
}
