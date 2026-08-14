import { describe, expect, it } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import { formatSessionHistory } from '../src/tui/tuiSessionHistory.js';
import { buildSessionTranscriptEvents } from '../src/ui/sessionTranscriptView.js';

describe('session transcript replay', () => {
  it('pairs tool_use with tool_result and keeps user/assistant text', () => {
    const events = buildSessionTranscriptEvents([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan the edit' },
          { type: 'text', text: 'I will edit the file.' },
          { type: 'tool_use', id: 'call-1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'updated a.ts' }],
      },
    ], { includeThinking: true });
    expect(events).toEqual([
      { type: 'user', text: 'hello' },
      { type: 'thinking', text: 'plan the edit' },
      { type: 'assistant', text: 'I will edit the file.' },
      {
        type: 'tool',
        id: 'call-1',
        name: 'Edit',
        input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
        ok: true,
        text: 'updated a.ts',
      },
    ]);
  });

  it('formats stored history into TUI scrollback lines', () => {
    const plain = formatSessionHistory([
      { role: 'user', content: 'nihao' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello — how can I help?' }] },
    ], 80).map(stripAnsi).join('\n');
    expect(plain).toContain('nihao');
    expect(plain).toContain('Hello — how can I help?');
  });

  it('hides only provenance-marked project context from restored history', () => {
    const internal = {
      role: 'user',
      content: '<system-reminder>\n# Project instructions\nInternal.\n</system-reminder>',
      __hadamardContext: { kind: 'project-instructions' },
    } as never;
    const pasted = {
      role: 'user',
      content: '<system-reminder>\n# Project instructions\nUser pasted this.\n</system-reminder>',
    } as const;
    const events = buildSessionTranscriptEvents([internal, pasted]);
    expect(events).toEqual([{ type: 'user', text: pasted.content }]);
  });
});
