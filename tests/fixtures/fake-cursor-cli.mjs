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
  // Real cursor-agent events carry a stable call_id on both started and
  // completed tool_call events; the normalizer pairs them via that id.
  const writeId = 'call-fixture-0\nfc_write_0';
  const shellId = 'call-fixture-1\nfc_shell_0';
  emit({
    type: 'tool_call',
    subtype: 'started',
    call_id: writeId,
    toolCallId: writeId,
    model_call_id: 'mc-0',
    timestamp_ms: 2,
    tool_call: { writeToolCall: { args: { path: 'README.md' } } },
  });
  emit({
    type: 'tool_call',
    subtype: 'completed',
    call_id: writeId,
    toolCallId: writeId,
    model_call_id: 'mc-0',
    timestamp_ms: 3,
    tool_call: {
      writeToolCall: { args: { path: 'README.md' }, result: { success: true } },
    },
  });
  emit({
    type: 'tool_call',
    subtype: 'started',
    call_id: shellId,
    toolCallId: shellId,
    model_call_id: 'mc-1',
    timestamp_ms: 4,
    tool_call: { shellToolCall: { args: { command: 'printf cursor-tool' } } },
  });
  emit({
    type: 'tool_call',
    subtype: 'completed',
    call_id: shellId,
    toolCallId: shellId,
    model_call_id: 'mc-1',
    timestamp_ms: 5,
    tool_call: {
      shellToolCall: {
        args: { command: 'printf cursor-tool' },
        result: { success: { output: 'cursor-tool' } },
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

// Verified against real cursor-agent 2026.08.11 output: thinking deltas come
// first, then assistant text as timestamped deltas (no model_call_id), then a
// turn-end recap carrying NEITHER timestamp_ms NOR model_call_id; the
// normalizer must drop the recap so the text is not duplicated.
emit({ type: 'thinking', subtype: 'delta', text: 'thinking...', timestamp_ms: 0, session_id: sessionId });
emit({ type: 'thinking', subtype: 'completed', timestamp_ms: 0, session_id: sessionId });
emit({
  type: 'assistant',
  timestamp_ms: 1,
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
emit({
  type: 'assistant',
  session_id: sessionId,
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
