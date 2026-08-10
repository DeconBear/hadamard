import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('source architecture', () => {
  it('keeps production source free of circular imports', async () => {
    const root = path.resolve(import.meta.dirname, '..');
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(root, 'scripts', 'check-source-cycles.mjs'), path.join(root, 'src')],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toMatchObject({ passed: true, cycles: [] });
  });
});
