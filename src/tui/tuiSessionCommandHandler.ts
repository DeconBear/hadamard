import type {
  CheckpointPreview,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  FileCheckpoint,
} from '../checkpoint/types.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiSessionListItem {
  id: string;
  title: string;
  model: string;
  status: string;
  kind?: string;
}

export interface TuiSessionCatalogItem {
  sessionId: string;
  projectName: string;
  type: string;
  title: string;
  archived: boolean;
  pinned: boolean;
}

export interface TuiSessionTreeNode {
  id: string;
  title: string;
  branchName?: string;
  children: TuiSessionTreeNode[];
}

export interface TuiSessionCommandPort {
  current(): { id: string; title: string; model: string; messageCount: number };
  checkpoints: {
    list(): Promise<FileCheckpoint[]>;
    preview(checkpointId: string): Promise<CheckpointPreview>;
    restore(checkpointId: string, mode: CheckpointRestoreMode): Promise<CheckpointRestoreResult>;
    restoreConversation(checkpointId: string): Promise<void>;
  };
  rewind(messageCount: number): Promise<string>;
  listStoredSessions(): Promise<TuiSessionListItem[]>;
  querySessions(filters: {
    types: string[];
    archived: 'active' | 'archived' | 'all';
    project?: string;
    status?: string;
    query?: string;
  }): Promise<TuiSessionCatalogItem[]>;
  resume(sessionId?: string): Promise<void>;
  tree(): Promise<TuiSessionTreeNode[]>;
  ensureMessageIds(): Promise<Array<{ id: string; role: string }>>;
  fork(messageId: string, label?: string): Promise<string>;
  clone(label?: string): Promise<string>;
  label(value: string): Promise<void>;
  catalogAction(
    action: 'rename' | 'pin' | 'archive' | 'restore' | 'delete',
    targetId: string,
    value?: string | boolean,
  ): Promise<boolean>;
  appendStatic(lines: readonly string[]): void;
}

function optionValue(args: string, flag: string): string | undefined {
  return args.match(new RegExp(`(?:^|\\s)--${flag}\\s+("[^"]+"|\\S+)`))?.[1]?.replace(/^"|"$/g, '');
}

export async function runTuiSessionCommand(
  name: string,
  args: string,
  port: TuiSessionCommandPort,
): Promise<boolean> {
  switch (name) {
    case 'checkpoint': {
      const [action = 'list', checkpointId, modeValue, ...flags] = args.trim().split(/\s+/u).filter(Boolean);
      if (action === 'list') {
        const checkpoints = await port.checkpoints.list();
        port.appendStatic(checkpoints.length > 0
          ? [
              `${A.bold}Checkpoints${A.reset}`,
              ...checkpoints.map(item =>
                `  ${item.id}  ${A.dim}${item.status} · ${item.entries.length} file(s) · ${item.createdAt}${A.reset}`
              ),
              '',
            ]
          : [...formatInfoLine('no checkpoints for this Session'), '']);
        return true;
      }
      if (!checkpointId) {
        port.appendStatic([...formatErrorLine('usage: /checkpoint show <id> | restore <id> [files|conversation|both] --confirm'), '']);
        return true;
      }
      if (action === 'show') {
        const preview = await port.checkpoints.preview(checkpointId);
        port.appendStatic([
          `${A.bold}Checkpoint ${checkpointId}${A.reset}`,
          ...preview.files.map(file => `  ${file.action.padEnd(13)} ${file.path}${file.binary ? ' · binary' : ''}`),
          ...(preview.conflicts.length > 0
            ? ['', `${A.red}Conflicts${A.reset}`, ...preview.conflicts.map(conflict => `  ${conflict.path}: ${conflict.message}`)]
            : ['', `${A.dim}No restore conflicts detected.${A.reset}`]),
          '',
        ]);
        return true;
      }
      if (action === 'restore') {
        const mode = ['files', 'conversation', 'both'].includes(modeValue ?? '')
          ? modeValue as CheckpointRestoreMode
          : 'both';
        const confirmed = flags.includes('--confirm') || modeValue === '--confirm';
        if (!confirmed) {
          port.appendStatic([...formatErrorLine(`preview first, then run /checkpoint restore ${checkpointId} ${mode} --confirm`), '']);
          return true;
        }
        const preview = await port.checkpoints.preview(checkpointId);
        const result = await port.checkpoints.restore(checkpointId, mode);
        if (result.conflicts.length > 0) {
          port.appendStatic([
            ...result.conflicts.flatMap(conflict => formatErrorLine(`${conflict.path}: ${conflict.message}`)),
            '',
          ]);
          return true;
        }
        if (result.conversationRestored && preview.checkpoint.conversationCheckpointId) {
          await port.checkpoints.restoreConversation(preview.checkpoint.conversationCheckpointId);
        }
        port.appendStatic([
          ...formatInfoLine(`checkpoint restored · ${result.restoredFiles.length} file(s)${result.conversationRestored ? ' · conversation' : ''}`),
          '',
        ]);
        return true;
      }
      port.appendStatic([...formatErrorLine('usage: /checkpoint list|show|restore'), '']);
      return true;
    }
    case 'rewind': {
      const count = parseInt(args, 10);
      if (!count || count < 1) {
        port.appendStatic([...formatErrorLine('usage: /rewind <N> — drops the last N messages (best-effort, no file restore)'), '']);
        return true;
      }
      if (count >= port.current().messageCount) {
        port.appendStatic([...formatErrorLine('cannot rewind beyond session start'), '']);
        return true;
      }
      const sessionId = await port.rewind(count);
      port.appendStatic([...formatInfoLine(`rewound ${count} message${count === 1 ? '' : 's'} (session ${sessionId}), files unchanged`), '']);
      return true;
    }
    case 'sessions': {
      if (args) {
        const rawType = optionValue(args, 'type') || 'user';
        const types = rawType === 'all'
          ? ['user', 'assistant-global', 'assistant-project', 'agent']
          : [rawType];
        const archived = optionValue(args, 'archived') || 'active';
        const items = await port.querySessions({
          types,
          archived: archived === 'all' ? 'all' : archived === 'archived' ? 'archived' : 'active',
          project: optionValue(args, 'project'),
          status: optionValue(args, 'status'),
          query: optionValue(args, 'query'),
        });
        port.appendStatic([
          ...(items.length
            ? items.map(item => `${item.pinned ? '★' : ' '} ${item.sessionId} · ${item.projectName} · ${item.type} · ${item.title}${item.archived ? ' · archived' : ''}`)
            : formatInfoLine('no matching Sessions')),
          '',
        ]);
        return true;
      }
      const sessions = await port.listStoredSessions();
      port.appendStatic([
        ...(sessions.length > 0
          ? sessions.map(item =>
              `${item.id === port.current().id ? A.green : A.dim}${item.id}${A.reset} ${item.title} · ${item.model} · ${item.status}`,
            )
          : formatInfoLine('no stored sessions')),
        '',
      ]);
      return true;
    }
    case 'resume':
      await port.resume(args || undefined);
      return true;
    case 'session': {
      const [action, ...rest] = args.split(/\s+/u);
      if (!action) {
        port.appendStatic([...formatErrorLine('usage: /session tree | fork <message-id> [label] | clone [label] | label <name> | rename <title> | pin [on|off] | archive | restore <id> | delete <id>'), '']);
        return true;
      }
      if (action === 'tree') {
        const roots = await port.tree();
        const lines: string[] = [`${A.bold}Session Tree${A.reset}`];
        const visit = (node: TuiSessionTreeNode, depth: number) => {
          const marker = node.id === port.current().id ? `${A.green}*${A.reset}` : '-';
          lines.push(`${'  '.repeat(depth)}${marker} ${node.branchName || node.title} ${A.dim}${node.id}${A.reset}`);
          node.children.forEach(child => visit(child, depth + 1));
        };
        roots.forEach(root => visit(root, 0));
        port.appendStatic([...lines, '']);
        return true;
      }
      if (action === 'fork') {
        const messageId = rest.shift();
        if (!messageId) {
          const refs = await port.ensureMessageIds();
          port.appendStatic([
            ...formatErrorLine('usage: /session fork <message-id> [label]'),
            ...refs.map(ref => `  ${A.dim}${ref.id}${A.reset} · ${ref.role}`),
            '',
          ]);
          return true;
        }
        const id = await port.fork(messageId, rest.join(' ').trim() || undefined);
        port.appendStatic([...formatInfoLine(`Session branch created: ${id}`), '']);
        return true;
      }
      if (action === 'clone') {
        const id = await port.clone(rest.join(' ').trim() || undefined);
        port.appendStatic([...formatInfoLine(`Session cloned: ${id}`), '']);
        return true;
      }
      if (action === 'label') {
        const label = rest.join(' ').trim();
        if (!label) {
          port.appendStatic([...formatErrorLine('usage: /session label <name>'), '']);
          return true;
        }
        await port.label(label);
        port.appendStatic([...formatInfoLine(`Session branch labeled: ${label}`), '']);
        return true;
      }
      const targetId = action === 'restore' || action === 'delete' ? rest[0] ?? '' : port.current().id;
      let value: string | boolean | undefined;
      if (action === 'rename') {
        value = rest.join(' ').trim();
        if (!value) {
          port.appendStatic([...formatErrorLine('usage: /session rename <title>'), '']);
          return true;
        }
      } else if (action === 'pin') {
        value = rest[0] === 'off' ? false : rest[0] === 'on' ? true : undefined;
      } else if (!['archive', 'restore', 'delete'].includes(action)) {
        port.appendStatic([...formatErrorLine(`unknown /session action: ${action}`), '']);
        return true;
      }
      const found = await port.catalogAction(
        action as 'rename' | 'pin' | 'archive' | 'restore' | 'delete',
        targetId,
        value,
      );
      if (!found) {
        port.appendStatic([...formatErrorLine(`Session not found: ${targetId}`), '']);
        return true;
      }
      port.appendStatic([...formatInfoLine(`Session ${action} complete.`), '']);
      return true;
    }
    default:
      return false;
  }
}
