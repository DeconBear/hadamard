import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('release workflows', () => {
  it('publishes the npm package after a GitHub Release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish-npm.yml'), 'utf8').replaceAll('\r\n', '\n');

    expect(workflow).toContain('release:');
    expect(workflow).toContain('types:');
    expect(workflow).toContain('- published');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('- Publish GitHub Release');
    expect(workflow).toContain("github.event_name == 'workflow_run'");
    expect(workflow).not.toMatch(/^\s+push:\r?$/mu);
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('steps.tag.outputs.tag');
    expect(workflow).toContain("steps.npm_version.outputs.exists != 'true'");
    expect(workflow).toContain('npm publish --access public');
  });

  it('publishes the independent Hcanvas package after its installer workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish-hcanvas-npm.yml'), 'utf8').replaceAll('\r\n', '\n');

    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('- Publish Hcanvas');
    expect(workflow).toContain('publish-hcanvas-npm.yml');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish --access public');
    expect(workflow).toContain('working-directory: packages/hadamard-canvas');
  });
});
