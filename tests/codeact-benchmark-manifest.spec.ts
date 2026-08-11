import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('CodeAct benchmark manifest', () => {
  it('covers four engineering domains on the clean SDK with CodeAct and Hybrid', async () => {
    const cases = JSON.parse(
      await readFile(new URL('../bench/codeact/cases.json', import.meta.url), 'utf8'),
    ) as Array<Record<string, unknown>>;
    expect(cases.map(item => item.domain)).toEqual([
      'math-modeling', 'data-processing', 'ai4s', 'electronics',
    ]);
    expect(new Set(cases.map(item => item.agentMode))).toEqual(new Set(['codeact', 'hybrid']));
    expect(cases.every(item => item.runtimeTarget === 'clean-sdk')).toBe(true);
    expect(cases.every(item => typeof item.python === 'string' && item.python.length > 20)).toBe(true);
  });
});
