import { describe, expect, it, vi } from 'vitest';

import { InputEditor } from '../src/tui/editor.js';
import {
  TuiInputController,
  type TuiInputControllerOptions,
} from '../src/tui/tuiInputController.js';
import type {
  PermissionDialogState,
  SelectionDialogState,
  TextInputDialogState,
} from '../src/tui/tuiTypes.js';

function createHarness(overrides: {
  running?: boolean;
  recalled?: string;
  permission?: PermissionDialogState | null;
  selection?: SelectionDialogState | null;
  textInput?: TextInputDialogState | null;
} = {}) {
  const editor = new InputEditor();
  let running = overrides.running ?? false;
  let permission = overrides.permission ?? null;
  let selection = overrides.selection ?? null;
  let textInput = overrides.textInput ?? null;
  let menuSelected = 0;
  let atSelected = 0;
  const submit = vi.fn();
  const shutdown = vi.fn();
  const abort = vi.fn(() => true);
  const render = vi.fn();
  const setRecalledFollowUp = vi.fn();
  const restoreAbandonedRecall = vi.fn();
  const options: TuiInputControllerOptions = {
    editor,
    dialogs: {
      permission: () => permission,
      selection: () => selection,
      setSelection: value => { selection = value; },
      textInput: () => textInput,
      setTextInput: value => { textInput = value; },
    },
    run: {
      isRunning: () => running,
      isShuttingDown: () => false,
      abort,
      shutdown,
      submit,
      recallFollowUp: () => overrides.recalled,
      setRecalledFollowUp,
      restoreAbandonedRecall,
    },
    completions: {
      atCompletions: () => [],
      applyAtCompletion: () => false,
      menuSelected: () => menuSelected,
      setMenuSelected: value => { menuSelected = value; },
      atSelected: () => atSelected,
      setAtSelected: value => { atSelected = value; },
    },
    view: { render, clearTerminal: vi.fn() },
  };
  return {
    editor,
    controller: new TuiInputController(options),
    submit,
    shutdown,
    abort,
    render,
    setRecalledFollowUp,
    restoreAbandonedRecall,
    selection: () => selection,
    textInput: () => textInput,
    setRunning: (value: boolean) => { running = value; },
  };
}

describe('TuiInputController', () => {
  it('steers on Shift+Return during a run and inserts a newline while idle', () => {
    const running = createHarness({ running: true });
    running.editor.insert('extra context');
    running.controller.handleKey(undefined, { name: 'return', shift: true });
    expect(running.submit).toHaveBeenCalledWith('steer');

    const idle = createHarness();
    idle.editor.insert('first');
    idle.controller.handleKey(undefined, { name: 'return', shift: true });
    expect(idle.editor.text).toBe('first\n');
    expect(idle.submit).not.toHaveBeenCalled();
  });

  it('recalls the latest queued follow-up with Up while running', () => {
    const harness = createHarness({ running: true, recalled: 'queued question' });
    harness.controller.handleKey(undefined, { name: 'up' });

    expect(harness.editor.text).toBe('queued question');
    expect(harness.setRecalledFollowUp).toHaveBeenCalledWith('queued question');
  });

  it('filters and confirms a selection dialog without leaking state into the editor', () => {
    const resolve = vi.fn();
    const harness = createHarness({
      selection: {
        title: 'Model',
        items: [{ id: 'a', label: 'alpha' }, { id: 'b', label: 'beta' }],
        selected: 0,
        query: '',
        searchable: true,
        resolve,
      },
    });
    harness.controller.handleKey('b', { name: 'b', sequence: 'b' });
    harness.controller.handleKey(undefined, { name: 'return' });

    expect(resolve).toHaveBeenCalledWith('b');
    expect(harness.selection()).toBeNull();
    expect(harness.editor.text).toBe('');
  });

  it('submits text-input dialogs and supports Ctrl+C interruption/exit', () => {
    const inputEditor = new InputEditor();
    inputEditor.insert('secret');
    const resolve = vi.fn();
    const dialogHarness = createHarness({
      textInput: {
        title: 'API key',
        label: 'Key',
        editor: inputEditor,
        secret: true,
        resolve,
      },
    });
    dialogHarness.controller.handleKey(undefined, { name: 'return' });
    expect(resolve).toHaveBeenCalledWith('secret');
    expect(dialogHarness.textInput()).toBeNull();

    const runHarness = createHarness({ running: true });
    runHarness.controller.handleKey(undefined, { name: 'c', ctrl: true });
    expect(runHarness.abort).toHaveBeenCalledTimes(1);
    runHarness.controller.handleKey(undefined, { name: 'c', ctrl: true });
    expect(runHarness.shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps the bare /model option until the user types a trailing space', () => {
    const harness = createHarness();
    harness.editor.insert('/model');
    harness.controller.handleKey(undefined, { name: 'tab' });
    expect(harness.editor.text).toBe('/model ');
  });
});
