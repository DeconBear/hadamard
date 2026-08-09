import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('release workflows', () => {
  it('publishes npm once from a published GitHub release', () => {
    const workflow = readFileSync(
      path.join(root, '.github', 'workflows', 'publish-npm.yml'),
      'utf8',
    );

    expect(workflow).toMatch(/^on:\r?\n\s+release:\r?$/mu);
    expect(workflow).toContain('types:\n      - published');
    expect(workflow).not.toMatch(/^\s+push:\r?$/mu);
    expect(workflow).toContain('RELEASE_TAG="${{ github.event.release.tag_name }}"');
  });
});
