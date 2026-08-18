/**
 * One-time risk acknowledgment for true full-access mode (bypassPermissions).
 *
 * Full access runs every tool call — including catastrophic commands such as
 * `rm -rf /` or disk reformatting — without any prompt. Surfaces that enable
 * it must show FULL_ACCESS_WARNING_TEXT once and persist the acknowledgment
 * in `~/.hadamard/settings.json` (Codex `hide_full_access_warning` style).
 */
import {
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from './hadamardSettingsStore.js';

export const FULL_ACCESS_WARNING_TEXT =
  'Full access runs every command without asking — including commands that can ' +
  'delete your system, wipe a disk, or destroy this entire project. Only use ' +
  'it when you fully trust the model, the prompt, and the workspace.';

const ACKNOWLEDGMENT_KEY = 'fullAccessWarningAcknowledged';

export async function isFullAccessWarningAcknowledged(homeDir?: string): Promise<boolean> {
  try {
    const store = await resolveHadamardSettingsStore({ homeDir });
    return store.raw[ACKNOWLEDGMENT_KEY] === true;
  } catch {
    return false;
  }
}

export async function acknowledgeFullAccessWarning(homeDir?: string): Promise<void> {
  try {
    const store = await resolveHadamardSettingsStore({ homeDir });
    if (store.raw[ACKNOWLEDGMENT_KEY] === true) return;
    store.raw[ACKNOWLEDGMENT_KEY] = true;
    await persistHadamardSettingsStore(store.configPath, store.raw);
  } catch {
    // Best-effort: failing to persist the acknowledgment must not break the UI.
  }
}

/**
 * Returns the warning text when full access is enabled and the risk has not
 * been acknowledged yet; acknowledges it for next time. Returns null when no
 * warning is needed.
 */
export async function consumeFullAccessWarning(homeDir?: string): Promise<string | null> {
  if (await isFullAccessWarningAcknowledged(homeDir)) return null;
  await acknowledgeFullAccessWarning(homeDir);
  return FULL_ACCESS_WARNING_TEXT;
}
