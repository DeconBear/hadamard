import { EditorState, Prec, type Extension } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { hoverTooltip, keymap } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { octave } from '@codemirror/legacy-modes/mode/octave';

export type NotebookRunMode = 'advance' | 'stay' | 'insert';

export interface NotebookCodeEditorOptions {
  parent: HTMLElement;
  source: string;
  language: string;
  readOnly?: boolean;
  onChange(source: string): void;
  onRun(mode: NotebookRunMode): void;
  onEscape(): void;
  onFocus?(): void;
  onBlur?(): void;
  complete?(source: string, position: number): Promise<{ matches: string[]; cursorStart: number; cursorEnd: number } | null>;
  inspect?(source: string, position: number): Promise<{ name?: string; signature?: string; documentation?: string } | null>;
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
      '.cm-notebook-doc': { padding: '8px 12px', maxWidth: '460px', font: '12px/1.55 Inter, sans-serif', whiteSpace: 'pre-wrap' },
      '.cm-notebook-doc strong': { display: 'block', marginBottom: '4px', color: '#c8b8f5', fontFamily: 'ui-monospace, monospace' },
    }),
    Prec.highest(keymap.of([
      { key: 'Shift-Enter', mac: 'Shift-Enter', run: () => { options.onRun('advance'); return true; } },
      { key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => { options.onRun('stay'); return true; } },
      { key: 'Alt-Enter', mac: 'Alt-Enter', run: () => { options.onRun('insert'); return true; } },
      { key: 'Escape', run: () => { options.onEscape(); return true; } },
    ])),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.focusChanged && update.view.hasFocus) options.onFocus?.();
      if (update.focusChanged && !update.view.hasFocus) options.onBlur?.();
    }),
  ];
  if (options.complete) {
    extensions.push(autocompletion({
      override: [async context => {
        const result = await options.complete!(context.state.doc.toString(), context.pos);
        return result ? { from: result.cursorStart, to: result.cursorEnd, options: result.matches.map(label => ({ label })) } : null;
      }],
    }));
  }
  if (options.inspect) {
    extensions.push(hoverTooltip(async (view, position) => {
      const line = view.state.doc.lineAt(position);
      const match = /[A-Za-z_][A-Za-z0-9_.]*$/u.exec(line.text.slice(0, position - line.from));
      if (!match) return null;
      const info = await options.inspect!(view.state.doc.toString(), position);
      if (!info) return null;
      const dom = document.createElement('div');
      dom.className = 'cm-notebook-doc';
      const title = document.createElement('strong');
      title.textContent = info.signature || info.name || match[0];
      dom.appendChild(title);
      if (info.documentation) dom.append(document.createTextNode(info.documentation));
      return { pos: position - match[0].length, end: position, above: true, create: () => ({ dom }) };
    }));
  }
  return new EditorView({ doc: options.source, extensions, parent: options.parent });
}
