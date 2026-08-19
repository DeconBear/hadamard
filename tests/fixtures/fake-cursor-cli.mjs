#!/usr/bin/env node
// Fake `cursor-agent` CLI for directCli-mode tests. Emits the cursor-agent
// stream-json wire format (system/init → assistant deltas + recaps →
// tool_call started/completed → result with usage) so the CursorNormalizer in
// bridgeProviders.ts can translate it into system/assistant/result events.
//
// Invocation shapes mirror real cursor-agent headless mode:
//   cursor-agent --trust --output-format stream-json --stream-partial-output \
//     [--mode plan|--force] [--model <id>] [--resume <id>|--continue] -p <prompt>
import process from 'node:process';

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf('-p');
const prompt = promptIndex !== -1 ? argv[promptIndex + 1] ?? '' : '';
const modelIndex = argv.indexOf('--model');
const modelFlag = modelIndex !== -1 ? argv[modelIndex + 1] : undefined;
const resumeIndex = argv.indexOf('--resume');
const resumeId = resumeIndex !== -1 ? argv[resumeIndex + 1] : undefined;

// Env echo for provider-isolation assertions.
const cursorKey = process.env.CURSOR_API_KEY ?? undefined;

const sessionId = 'cursor-fixture-session';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  session_id: sessionId,
  model: modelFlag ?? 'auto',
});

// Failure path: emit an error result when the prompt asks for it.
if (prompt === 'force-fail') {
  emit({
    type: 'result',
    subtype: 'error',
    is_error: true,
    duration_ms: 3,
    result: 'cursor usage limit reached',
    session_id: sessionId,
  });
  process.exit(0);
}

if (prompt === 'exercise-tools') {
  emit({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { writeToolCall: { args: { path: 'README.md' } } },
  });
  emit({
    type: 'tool_call',
    subtype: 'completed',
    tool_call: {
      writeToolCall: { args: { path: 'README.md' }, result: { success: true } },
    },
  });
  emit({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { shellToolCall: { args: { command: 'printf cursor-tool' } } },
  });
  emit({
    type: 'tool_call',
    subtype: 'completed',
    tool_call: {
      shellToolCall: {
        args: { command: 'printf cursor-tool' },
        result: { output: 'cursor-tool' },
      },
    },
  });
}

const text = prompt === 'who-am-i'
  ? `cursor:agent:${modelFlag ?? 'inherit'}`
  : prompt === 'check-permissions'
    ? `cursor:args:${argv.join('|')}`
    : prompt === 'check-resume'
      ? `cursor:${resumeId ? 'resume' : 'new'}:${resumeId ?? 'none'}`
      : prompt === 'check-env'
        ? `cursor:env:${cursorKey ?? 'none'}`
        : `cursor:${prompt}`;

// Assistant text arrives as timestamped deltas (no model_call_id) followed by
// a turn-end recap carrying model_call_id; the normalizer must drop the recap
// so the text is not duplicated.
emit({
  type: 'assistant',
  timestamp_ms: 1,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
emit({
  type: 'assistant',
  model_call_id: 'call-1',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 5,
  result: text,
  session_id: sessionId,
  usage: { inputTokens: 10, outputTokens: text.length, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
