import { A, stringWidth, truncateToWidth } from './ansi.js';
import type { InputEditor } from './editor.js';
import { filterTuiSelectionItems } from './selection.js';
import type {
  PermissionDialogState,
  SelectionDialogState,
  TextInputDialogState,
} from './tuiTypes.js';

const PROMPT_GLYPH = '❯';

function boxRow(content: string, borderColor: string, width: number): string {
  const inner = Math.max(width - 4, 8);
  const contentWidth = stringWidth(content);
  const padded = contentWidth > inner
    ? truncateToWidth(content, inner)
    : content + ' '.repeat(inner - contentWidth);
  return `${borderColor}│${A.reset} ${padded} ${borderColor}│${A.reset}`;
}

function boxTop(borderColor: string, width: number): string {
  return `${borderColor}╭${'─'.repeat(Math.max(width - 2, 2))}╮${A.reset}`;
}

function boxBottom(borderColor: string, width: number): string {
  return `${borderColor}╰${'─'.repeat(Math.max(width - 2, 2))}╯${A.reset}`;
}

function promptDivider(width: number): string {
  return `${A.gray}${'─'.repeat(Math.max(width, 8))}${A.reset}`;
}

export function withTuiCaret(line: string, caretCol: number): string {
  let width = 0;
  let index = 0;
  for (const char of line) {
    if (width >= caretCol) break;
    width += stringWidth(char);
    index += char.length;
  }
  const before = line.slice(0, index);
  const rest = line.slice(index);
  const caretChar = rest.length > 0 ? [...rest][0]! : ' ';
  const after = rest.length > 0 ? rest.slice(caretChar.length) : '';
  return `${before}${A.inverse}${caretChar}${A.reset}${after}`;
}

export function buildTuiPromptBar(editor: InputEditor, width: number): string[] {
  const editorWidth = Math.max(width - 4, 8);
  const lines: string[] = [promptDivider(width)];
  if (editor.isEmpty()) {
    const placeholder = truncateToWidth('Try "write a test for <filepath>"', editorWidth - 4);
    lines.push(`${A.magenta}${PROMPT_GLYPH}${A.reset} ${A.inverse} ${A.reset} ${A.dim}${placeholder}${A.reset}`);
  } else {
    const visual = editor.visualLines(editorWidth - 1);
    visual.lines.forEach((line, row) => {
      const prefix = row === 0 ? `${A.magenta}${PROMPT_GLYPH}${A.reset} ` : '  ';
      const body = row === visual.cursorRow ? withTuiCaret(line, visual.cursorCol) : line;
      lines.push(`${prefix}${body}`);
    });
  }
  lines.push(promptDivider(width));
  return lines;
}

export function tuiPromptCursorPosition(
  editor: InputEditor,
  width: number,
  promptStartLine: number,
): { line: number; column: number } {
  if (editor.isEmpty()) return { line: promptStartLine + 1, column: 2 };
  const visual = editor.visualLines(Math.max(width - 5, 7));
  return {
    line: promptStartLine + 1 + visual.cursorRow,
    column: 2 + visual.cursorCol,
  };
}

export function buildTuiPermissionDialog(
  dialog: PermissionDialogState,
  width: number,
): string[] {
  const inner = Math.max(width - 4, 8);
  const options = [
    'Yes',
    `Always ${dialog.toolName} (project)`,
    `Always ${dialog.toolName} (user)`,
    'No (esc)',
  ];
  const lines = [
    boxTop(A.yellow, width),
    boxRow(`${A.bold}Permission required · ${dialog.toolName}${A.reset}`, A.yellow, width),
    boxRow(`${A.dim}${truncateToWidth(dialog.summary || '(no arguments)', inner)}${A.reset}`, A.yellow, width),
  ];
  options.forEach((option, index) => {
    const selected = index === dialog.selected;
    lines.push(boxRow(selected ? `${A.inverse} ${option} ${A.reset}` : `  ${option}`, A.yellow, width));
  });
  lines.push(boxBottom(A.yellow, width));
  lines.push(`${A.dim}  y/enter approve · a always (project) · n/esc deny · ↑↓ select${A.reset}`);
  return lines;
}

export function buildTuiSelectionDialog(
  dialog: SelectionDialogState,
  width: number,
  terminalRows: number,
): { lines: string[]; selected: number } {
  const filtered = filterTuiSelectionItems(dialog.items, dialog.query);
  const selected = dialog.selected >= filtered.length
    ? Math.max(filtered.length - 1, 0)
    : dialog.selected;
  const lines = [
    boxTop(A.cyan, width),
    boxRow(`${A.bold}${dialog.title}${A.reset}`, A.cyan, width),
  ];
  if (dialog.subtitle) lines.push(boxRow(`${A.dim}${dialog.subtitle}${A.reset}`, A.cyan, width));
  if (dialog.searchable) {
    const query = dialog.query || 'type to filter';
    lines.push(boxRow(
      `${A.magenta}›${A.reset} ${dialog.query ? query : `${A.dim}${query}${A.reset}`}`,
      A.cyan,
      width,
    ));
  }
  if (filtered.length === 0) {
    lines.push(boxRow(`${A.dim}No matching items${A.reset}`, A.cyan, width));
  } else {
    const visibleRows = Math.min(10, Math.max(terminalRows - 10, 4));
    const start = Math.max(0, Math.min(
      selected - Math.floor(visibleRows / 2),
      filtered.length - visibleRows,
    ));
    for (let index = start; index < Math.min(start + visibleRows, filtered.length); index += 1) {
      const item = filtered[index]!;
      const description = item.description ? ` · ${item.description}` : '';
      const label = truncateToWidth(`${item.label}${description}`, Math.max(width - 8, 8));
      lines.push(boxRow(
        index === selected ? `${A.inverse} ${label} ${A.reset}` : `  ${label}`,
        A.cyan,
        width,
      ));
    }
  }
  lines.push(boxBottom(A.cyan, width));
  lines.push(`${A.dim}  ↑↓ select · enter confirm · esc cancel${dialog.searchable ? ' · type to filter' : ''}${A.reset}`);
  return { lines, selected };
}

export function buildTuiTextInputDialog(
  dialog: TextInputDialogState,
  width: number,
): string[] {
  const value = dialog.secret ? '•'.repeat(dialog.editor.text.length) : dialog.editor.text;
  const displayed = withTuiCaret(value, dialog.editor.cursor);
  const lines = [
    boxTop(A.cyan, width),
    boxRow(`${A.bold}${dialog.title}${A.reset}`, A.cyan, width),
  ];
  if (dialog.description) lines.push(boxRow(`${A.dim}${dialog.description}${A.reset}`, A.cyan, width));
  lines.push(boxRow(`${dialog.label}: ${displayed}`, A.cyan, width));
  lines.push(boxBottom(A.cyan, width));
  lines.push(`${A.dim}  enter confirm · esc cancel${dialog.secret ? ' · value hidden' : ''}${A.reset}`);
  return lines;
}

export function tuiSelectionDialogCursorPosition(
  dialog: SelectionDialogState | null,
  startLine: number,
): { line: number; column: number } | undefined {
  if (!dialog?.searchable) return undefined;
  return {
    line: startLine + 2 + (dialog.subtitle ? 1 : 0),
    column: 4 + stringWidth(dialog.query),
  };
}

export function tuiTextInputDialogCursorPosition(
  dialog: TextInputDialogState | null,
  startLine: number,
): { line: number; column: number } | undefined {
  if (!dialog) return undefined;
  const valueBeforeCursor = dialog.secret
    ? '•'.repeat(dialog.editor.cursor)
    : dialog.editor.text.slice(0, dialog.editor.cursor);
  return {
    line: startLine + 2 + (dialog.description ? 1 : 0),
    column: 2 + stringWidth(`${dialog.label}: `) + stringWidth(valueBeforeCursor),
  };
}
