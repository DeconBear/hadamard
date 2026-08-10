import type { MessageParam } from '../provider/types.js';
import type { ConversationPersistenceOptions } from './conversationPorts.js';
import { deepClone } from './helpers.js';

export async function appendRawTranscript(
  options: Pick<ConversationPersistenceOptions, 'onTranscriptMessages'>,
  messages: readonly MessageParam[],
): Promise<void> {
  if (!options.onTranscriptMessages || messages.length === 0) return;
  try {
    await options.onTranscriptMessages([...deepClone(messages)]);
  } catch {
    // Raw transcript durability must not turn a successful model/tool step into a failed turn.
  }
}
