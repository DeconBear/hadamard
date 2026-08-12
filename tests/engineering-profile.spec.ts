import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DesignDocumentStore, EngineeringProfileService } from '../src/design/index.js';

describe('Engineering Profile proposal and confirmation', () => {
  it('keeps Design, AGENTS, policy, and validators as independent reviewable patches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-profile-'));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const store = new DesignDocumentStore(work);
    await store.write('# System\n\nInitial design.\n');
    const service = new EngineeringProfileService(work, store);

    const proposal = await service.propose('software.general');
    expect(Object.keys(proposal.diffs).sort()).toEqual(['agents', 'design', 'policy', 'validators']);
    expect(proposal.sourceConstraintIds).toContain('ENG-SW-TEST-001');
    await expect(service.apply(proposal, ['design'], false)).rejects.toThrow(/confirmation/u);
    await expect(readFile(path.join(work, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await service.apply(proposal, ['design', 'agents'], true)).toEqual(['design', 'agents']);
    expect(await readFile(store.designPath(), 'utf8')).toContain('ENG-SW-TEST-001');
    expect(await readFile(path.join(work, 'AGENTS.md'), 'utf8')).toContain('[ENG-SW-TEST-001]');
    await expect(readFile(path.join(work, '.hadamard', 'policy.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const partialDrift = await service.audit('software.general');
    expect(partialDrift.expressedNotExecuted).toContain('ENG-SW-TEST-001');
    const second = await service.propose('software.general');
    await service.apply(second, ['policy', 'validators'], true);
    const policy = JSON.parse(await readFile(path.join(work, '.hadamard', 'policy.json'), 'utf8'));
    expect(policy.settings.engineeringProfile.sourceConstraintIds).toContain('ENG-SW-TEST-001');
    const validators = JSON.parse(await readFile(path.join(work, '.hadamard', 'validators.json'), 'utf8'));
    expect(validators.validators.find((item: { id: string }) => item.id === 'test')).toBeTruthy();
    const drift = await service.audit('software.general');
    expect(drift.expressedNotExecuted).toEqual([]);
    expect(drift.executedNotDesigned).toEqual([]);
    const stable = await service.propose('software.general');
    expect(Object.values(stable.diffs).every(candidate => !candidate.changed)).toBe(true);
  });
});
