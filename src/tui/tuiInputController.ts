import { InputEditor } from './editor.js';
import { activeAtToken, filterSlashCommands } from './tuiTextPresenter.js';
import {
  filterTuiSelectionItems,
  moveTuiSelection,
} from './selection.js';
import type {
  PermissionDialogState,
  SelectionDialogState,
  TextInputDialogState,
  TuiKey,
} from './tuiTypes.js';
import type { ActiveInputMode } from './pendingInput.js';

const CTRL_C_EXIT_WINDOW_MS = 600;

export interface TuiInputDialogPort {
  permission(): PermissionDialogState | null;
  selection(): SelectionDialogState | null;
  setSelection(value: SelectionDialogState | null): void;
  textInput(): TextInputDialogState | null;
  setTextInput(value: TextInputDialogState | null): void;
}

export interface TuiInputRunPort {
  isRunning(): boolean;
  isShuttingDown(): boolean;
  abort(): boolean;
  shutdown(): void;
  submit(mode?: ActiveInputMode): void;
  /** Whether queued messages exist in the session (steering/follow-up/inject). */
  hasQueuedInputs(): boolean;
  /** Discard queued inputs after the user presses ESC again. */
  discardQueuedInputs(): void;
  /**
   * Toggle the "stopped, queued message awaiting confirmation" state.
   * The frame renders a persistent hint while it is active.
   */
  setQueuedConfirm(active: boolean): void;
  recallFollowUp(): string | undefined;
  setRecalledFollowUp(value: string): void;
  restoreAbandonedRecall(): void;
}

export interface TuiInputCompletionPort {
  atCompletions(token: string): string[];
  applyAtCompletion(): boolean;
  menuSelected(): number;
  setMenuSelected(value: number): void;
  atSelected(): number;
  setAtSelected(value: number): void;
}

export interface TuiInputViewPort {
  render(): void;
  clearTerminal(): void;
}

export interface TuiInputControllerOptions {
  editor: InputEditor;
  dialogs: TuiInputDialogPort;
  run: TuiInputRunPort;
  completions: TuiInputCompletionPort;
  view: TuiInputViewPort;
}

export class TuiInputController {
  private ctrlCCount = 0;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a stopped task left the editor (or the session queue) awaiting Enter confirmation. */
  private queuedConfirm = false;

  constructor(private readonly options: TuiInputControllerOptions) {}

  handleKey(char: string | undefined, key: TuiKey): void {
    const { dialogs, run } = this.options;
    if (run.isShuttingDown()) return;
    const name = key.name ?? '';

    if (name !== 'c' || !key.ctrl) this.ctrlCCount = 0;

    if (dialogs.permission()) {
      this.handlePermissionDialogKey(key);
      return;
    }
    if (dialogs.selection()) {
      this.handleSelectionKey(char, key);
      return;
    }
    if (dialogs.textInput()) {
      this.handleTextInputKey(char, key);
      return;
    }

    if (key.ctrl) {
      this.handleControlKey(name, key);
      return;
    }
    this.handleEditorKey(char, key);
  }

  private handlePermissionDialogKey(key: TuiKey): void {
    const dialog = this.options.dialogs.permission();
    if (!dialog) return;
    const name = key.name ?? '';
    if (name === 'up') {
      dialog.selected = (dialog.selected + 3) % 4;
    } else if (name === 'down' || name === 'tab') {
      dialog.selected = (dialog.selected + 1) % 4;
    } else if (name === 'return' || name === 'enter') {
      dialog.resolve(dialog.selected === 0 ? 'allow' : dialog.selected === 1 ? 'always' : dialog.selected === 2 ? 'always-user' : 'deny');
      return;
    } else if (name === 'y') {
      dialog.resolve('allow');
      return;
    } else if (name === 'a') {
      dialog.resolve('always');
      return;
    } else if (name === 'n' || name === 'escape' || (name === 'c' && key.ctrl)) {
      dialog.resolve('deny');
      return;
    }
    this.options.view.render();
  }

  private finishSelection(value: string | string[] | undefined): void {
    const active = this.options.dialogs.selection();
    if (!active) return;
    this.options.dialogs.setSelection(null);
    this.options.view.render();
    active.resolve(value);
  }

  private handleSelectionKey(char: string | undefined, key: TuiKey): void {
    const dialog = this.options.dialogs.selection();
    if (!dialog) return;
    const name = key.name ?? '';
    const filtered = filterTuiSelectionItems(dialog.items, dialog.query);
    if (name === 'up') {
      dialog.selected = moveTuiSelection(dialog.selected, filtered.length, -1);
    } else if (name === 'down' || name === 'tab') {
      dialog.selected = moveTuiSelection(dialog.selected, filtered.length, 1);
    } else if (name === 'pageup') {
      dialog.selected = Math.max(dialog.selected - 8, 0);
    } else if (name === 'pagedown') {
      dialog.selected = Math.max(Math.min(dialog.selected + 8, filtered.length - 1), 0);
    } else if (name === 'space' || key.sequence === ' ') {
      if (dialog.multiple) {
        const id = filtered[dialog.selected]?.id;
        if (id) {
          dialog.checkedIds ??= new Set<string>();
          if (dialog.checkedIds.has(id)) dialog.checkedIds.delete(id);
          else dialog.checkedIds.add(id);
        }
      }
    } else if (name === 'return' || name === 'enter') {
      this.finishSelection(dialog.multiple
        ? [...(dialog.checkedIds ?? [])]
        : filtered[dialog.selected]?.id);
      return;
    } else if (name === 'escape' || (name === 'c' && key.ctrl)) {
      this.finishSelection(undefined);
      return;
    } else if (dialog.searchable && name === 'backspace') {
      dialog.query = dialog.query.slice(0, -1);
      dialog.selected = 0;
    } else if (dialog.searchable && name === 'u' && key.ctrl) {
      dialog.query = '';
      dialog.selected = 0;
    } else if (dialog.searchable && !key.ctrl && !key.meta) {
      const sequence = key.sequence ?? char ?? '';
      const cleaned = sequence.replace(/[\x00-\x1f\x7f]/g, '');
      if (cleaned) {
        dialog.query += cleaned;
        dialog.selected = 0;
      }
    }
    this.options.view.render();
  }

  private finishTextInput(value: string | undefined): void {
    const active = this.options.dialogs.textInput();
    if (!active) return;
    this.options.dialogs.setTextInput(null);
    this.options.view.render();
    active.resolve(value);
  }

  private handleTextInputKey(char: string | undefined, key: TuiKey): void {
    const dialog = this.options.dialogs.textInput();
    if (!dialog) return;
    const name = key.name ?? '';
    const editor = dialog.editor;
    if (name === 'return' || name === 'enter') {
      this.finishTextInput(editor.text);
      return;
    }
    if (name === 'escape' || (name === 'c' && key.ctrl)) {
      this.finishTextInput(undefined);
      return;
    }
    if (key.ctrl) {
      if (name === 'a') editor.moveHome();
      else if (name === 'e') editor.moveEnd();
      else if (name === 'u') editor.clear();
      else if (name === 'w') editor.deleteWordLeft();
    } else if (name === 'backspace') editor.backspace();
    else if (name === 'delete') editor.deleteForward();
    else if (name === 'left') editor.moveLeft();
    else if (name === 'right') editor.moveRight();
    else if (name === 'home') editor.moveHome();
    else if (name === 'end') editor.moveEnd();
    else {
      const sequence = key.sequence ?? char ?? '';
      const cleaned = sequence.replace(/[\x00-\x1f\x7f]/g, '');
      if (cleaned) editor.insert(cleaned);
    }
    this.options.view.render();
  }

  private handleControlKey(name: string, _key: TuiKey): void {
    const { editor, run, completions, view } = this.options;
    switch (name) {
      case 'c': {
        this.ctrlCCount += 1;
        if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
        this.ctrlCTimer = setTimeout(() => { this.ctrlCCount = 0; }, CTRL_C_EXIT_WINDOW_MS);
        if (this.ctrlCCount >= 2) {
          run.shutdown();
          return;
        }
        if (run.isRunning() && run.abort()) {
          // Active request interrupted; a typed/queued message awaits Enter.
          if (!editor.isEmpty() || run.hasQueuedInputs()) {
            this.queuedConfirm = true;
            run.setQueuedConfirm(true);
          }
        } else if (this.queuedConfirm) {
          this.queuedConfirm = false;
          run.setQueuedConfirm(false);
          run.discardQueuedInputs();
          editor.clear();
          completions.setMenuSelected(0);
          run.restoreAbandonedRecall();
        } else if (!editor.isEmpty()) {
          editor.clear();
          completions.setMenuSelected(0);
          run.restoreAbandonedRecall();
        }
        view.render();
        return;
      }
      case 'd':
        if (editor.isEmpty()) {
          run.shutdown();
          return;
        }
        editor.deleteForward();
        run.restoreAbandonedRecall();
        break;
      case 'a': editor.moveHome(); break;
      case 'e': editor.moveEnd(); break;
      case 'k': editor.killToEnd(); run.restoreAbandonedRecall(); break;
      case 'u': editor.killToStart(); run.restoreAbandonedRecall(); break;
      case 'w': editor.deleteWordLeft(); run.restoreAbandonedRecall(); break;
      case 'left': editor.moveWordLeft(); break;
      case 'right': editor.moveWordRight(); break;
      case 'l': view.clearTerminal(); break;
      case 'j': editor.insert('\n'); break;
      default: break;
    }
    view.render();
  }

  private handleEditorKey(char: string | undefined, key: TuiKey): void {
    const { editor, run, completions, view } = this.options;
    const name = key.name ?? '';
    switch (name) {
      case 'return':
        // ESC has requested cancellation, but the run has not settled yet.
        // Keep the confirmation state so an early Enter cannot strand or
        // duplicate queued input while `running` is still true.
        if (this.queuedConfirm && run.isRunning()) {
          view.render();
          return;
        }
        if (key.shift) {
          if (run.isRunning()) run.submit('steer');
          else editor.insert('\n');
          return;
        }
        if (key.meta) {
          editor.insert('\n');
          break;
        }
        run.submit();
        this.queuedConfirm = false;
        run.setQueuedConfirm(false);
        return;
      case 'enter':
        if (key.shift && run.isRunning()) {
          run.submit('steer');
          return;
        }
        editor.insert('\n');
        break;
      case 'escape':
        if (run.isRunning() && run.abort()) {
          // Active request interrupted. A message already typed (or queued
          // in the session) is kept and marked as awaiting confirmation.
          if (!editor.isEmpty() || run.hasQueuedInputs()) {
            this.queuedConfirm = true;
            run.setQueuedConfirm(true);
          }
        } else if (this.queuedConfirm) {
          // Second ESC cancels the queued confirmation and clears the editor.
          this.queuedConfirm = false;
          run.setQueuedConfirm(false);
          run.discardQueuedInputs();
          editor.clear();
          completions.setMenuSelected(0);
          run.restoreAbandonedRecall();
        } else if (!editor.isEmpty()) {
          editor.clear();
          completions.setMenuSelected(0);
          run.restoreAbandonedRecall();
        }
        break;
      case 'backspace':
        editor.backspace();
        completions.setMenuSelected(0);
        completions.setAtSelected(0);
        run.restoreAbandonedRecall();
        break;
      case 'delete': editor.deleteForward(); run.restoreAbandonedRecall(); break;
      case 'left': key.meta ? editor.moveWordLeft() : editor.moveLeft(); break;
      case 'right': key.meta ? editor.moveWordRight() : editor.moveRight(); break;
      case 'home': editor.moveHome(); break;
      case 'end': editor.moveEnd(); break;
      case 'up': {
        if (run.isRunning() && editor.isEmpty()) {
          const recalled = run.recallFollowUp();
          if (recalled) {
            run.setRecalledFollowUp(recalled);
            editor.setText(recalled);
            break;
          }
        }
        if (editor.isBrowsingHistory()) {
          editor.historyPrev();
          break;
        }
        const atToken = activeAtToken(editor.text, editor.cursor);
        const atCount = atToken ? completions.atCompletions(atToken.token).length : 0;
        const menu = filterSlashCommands(editor.text);
        if (atCount > 0) completions.setAtSelected((completions.atSelected() + atCount - 1) % atCount);
        else if (menu.length > 0) completions.setMenuSelected((completions.menuSelected() + menu.length - 1) % menu.length);
        else if (!editor.onFirstLine()) editor.moveUp();
        else editor.historyPrev();
        break;
      }
      case 'down': {
        if (editor.isBrowsingHistory()) {
          editor.historyNext();
          break;
        }
        const atToken = activeAtToken(editor.text, editor.cursor);
        const atCount = atToken ? completions.atCompletions(atToken.token).length : 0;
        const menu = filterSlashCommands(editor.text);
        if (atCount > 0) completions.setAtSelected((completions.atSelected() + 1) % atCount);
        else if (menu.length > 0) completions.setMenuSelected((completions.menuSelected() + 1) % menu.length);
        else if (!editor.onLastLine()) editor.moveDown();
        else editor.historyNext();
        break;
      }
      case 'tab': {
        if (completions.applyAtCompletion()) break;
        const menu = filterSlashCommands(editor.text);
        if (menu.length > 0) {
          const selected = menu[Math.min(completions.menuSelected(), menu.length - 1)]!;
          editor.setText(`/${selected} `);
        }
        break;
      }
      default: {
        const sequence = key.sequence ?? char ?? '';
        if (sequence) {
          const cleaned = sequence
            .replace(/\x1b\[20[01]~/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, match => (match === '\n' ? '\n' : ''));
          if (cleaned) {
            editor.insert(cleaned);
            completions.setMenuSelected(0);
            completions.setAtSelected(0);
          }
        }
        break;
      }
    }
    view.render();
  }
}
