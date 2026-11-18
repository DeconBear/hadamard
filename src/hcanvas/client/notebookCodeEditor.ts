import { EditorState, Prec, type Extension } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { octave } from '@codemirror/legacy-modes/mode/octave';

export interface NotebookCodeEditorOptions {
  parent: HTMLElement;
  source: string;
  language: string;
  readOnly?: boolean;
  onChange(source: string): void;
  onRun(): void;
  onInsert(): void;
  onFocus?(): void;
}

function languageSupport(language: string): Extension {
  const normalized = language.toLowerCase();
  if (normalized === 'python' || normalized === 'py') return python();
  if (normalized === 'cpp' || normalized === 'c++' || normalized === 'cc') return cpp();
  if (normalized === 'octave' || normalized === 'matlab') return StreamLanguage.define(octave);
  if (normalized === 'javascript' || normalized === 'js' || normalized === 'typescript') return javascript({ typescript: normalized === 'typescript' });
  return [];
}

export function mountNotebookCodeEditor(options: NotebookCodeEditorOptions): EditorView {
  const extensions: Extension[] = [
    basicSetup,
    oneDark,
    EditorView.lineWrapping,
    languageSupport(options.language),
    EditorState.readOnly.of(options.readOnly === true),
    EditorView.editable.of(options.readOnly !== true),
    EditorView.contentAttributes.of({ 'aria-label': 'Notebook code cell', spellcheck: 'false' }),
    EditorView.theme({
      '&': { backgroundColor: '#181b23', fontSize: '13px' },
      '.cm-content': { padding: '13px 0', caretColor: '#d8ceff' },
      '.cm-line': { padding: '0 17px' },
      '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, Consolas, monospace', lineHeight: '1.55', overflow: 'visible' },
      '.cm-editor.cm-focused': { outline: 'none' },
      '.cm-gutters': { display: 'none' },
    }),
    Prec.highest(keymap.of([
      { key: 'Shift-Enter', mac: 'Shift-Enter', run: () => { options.onRun(); return true; } },
      { key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => { options.onRun(); return true; } },
      { key: 'Alt-Enter', mac: 'Alt-Enter', run: () => { options.onInsert(); return true; } },
    ])),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.focusChanged && update.view.hasFocus) options.onFocus?.();
    }),
  ];
  return new EditorView({ doc: options.source, extensions, parent: options.parent });
}
