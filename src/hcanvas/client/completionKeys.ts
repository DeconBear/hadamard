import { acceptCompletion, completionStatus, currentCompletions, selectedCompletionIndex, setSelectedCompletion, startCompletion } from '@codemirror/autocomplete';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Tab accepts the visible completion. If the completion widget opened without
 * a selected row, select the first option first. With no active widget, Tab
 * starts completion; editors without a completion source keep normal indent
 * behavior because startCompletion returns false.
 */
export function tabCompletionKeymap(): Extension {
  return Prec.highest(keymap.of([
    {
      key: 'Tab',
      run: view => {
        if (completionStatus(view.state) === 'active') {
          if (selectedCompletionIndex(view.state) === null && currentCompletions(view.state).length) {
            view.dispatch({ effects: setSelectedCompletion(0) });
          }
          return acceptCompletion(view);
        }
        return startCompletion(view);
      },
    },
  ]));
}
