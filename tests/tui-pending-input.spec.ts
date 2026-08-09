import { describe, expect, it, vi } from 'vitest';

import {
  recallLatestFollowUp,
  restoreAbandonedFollowUp,
  submitActiveInput,
} from '../src/tui/pendingInput.js';

describe('TUI pending input policy', () => {
  it('maps Enter to follow-up and Shift+Enter to steering', () => {
    const port = {
      followUp: vi.fn(),
      steer: vi.fn(),
      cancelLatestFollowUp: vi.fn(() => 'queued'),
    };

    submitActiveInput(port, 'later', 'follow-up');
    submitActiveInput(port, 'now', 'steer');

    expect(port.followUp).toHaveBeenCalledWith('later');
    expect(port.steer).toHaveBeenCalledWith('now');
    expect(recallLatestFollowUp(port)).toBe('queued');
  });

  it('restores an abandoned recalled follow-up to the queue', () => {
    const port = {
      followUp: vi.fn(),
      steer: vi.fn(),
      cancelLatestFollowUp: vi.fn(() => 'queued later'),
    };

    const recalled = recallLatestFollowUp(port);
    expect(recalled).toBe('queued later');
    restoreAbandonedFollowUp(port, recalled);

    expect(port.followUp).toHaveBeenCalledWith('queued later');
  });

  it('ignores empty abandoned recalls', () => {
    const port = {
      followUp: vi.fn(),
      steer: vi.fn(),
      cancelLatestFollowUp: vi.fn(),
    };

    restoreAbandonedFollowUp(port, '   ');
    restoreAbandonedFollowUp(port, null);
    expect(port.followUp).not.toHaveBeenCalled();
  });
});
