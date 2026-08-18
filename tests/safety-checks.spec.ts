import { describe, expect, it } from 'vitest';

import { decideHadamardToolPermission } from '../src/runtime/hadamardPermissions.js';
import { checkSafety, detectCatastrophicShellCommand } from '../src/runtime/safetyChecks.js';

function check(filePath: string) {
  return checkSafety({
    toolName: 'Write',
    publicName: 'Write',
    toolInput: { file_path: filePath },
    workDir: process.cwd(),
  });
}

describe('safety checks', () => {
  it('blocks protected directories with slash or backslash paths', () => {
    expect(check('C:/repo/.git/config').blocked).toBe(true);
    expect(check('C:\\repo\\.hadamard\\settings.json').blocked).toBe(true);
  });

  it('blocks nested shell configuration files on Windows-style paths', () => {
    const result = check('C:/Users/demo/.config/fish/config.fish');

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('fish/config.fish');
  });

  it('does not let tool-specific allow bypass safety checks', async () => {
    const result = await decideHadamardToolPermission({
      mode: 'default',
      rules: [],
      adapter: {
        checkPermissions: () => 'allow',
      },
      runId: 'run-test',
      workDir: process.cwd(),
      toolName: 'Write',
      publicName: 'Write',
      prompt: 'test prompt',
      toolInput: { file_path: 'C:/repo/.git/config' },
      iteration: 1,
    });

    expect(result.behavior).toBe('deny');
    expect(result.reason).toContain('.git');
  });

  it('detects system-disk and active-workspace deletion across shells', () => {
    const workDir = process.platform === 'win32' ? 'E:\\repo\\project' : '/repo/project';

    expect(detectCatastrophicShellCommand('rm -rf /', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rm -rf .', workDir)).toContain('active workspace');
    expect(detectCatastrophicShellCommand(`rm -rf "${workDir}"`, workDir)).toContain('active workspace');
    expect(detectCatastrophicShellCommand('Remove-Item -LiteralPath C:\\ -Recurse -Force', workDir))
      .toContain('explicit approval');
    expect(detectCatastrophicShellCommand('format C:', workDir)).toContain('entire disk');
    expect(detectCatastrophicShellCommand('rm -rf node_modules', workDir)).toBeNull();
  });

  it('detects catastrophic commands hidden behind wrappers and shell -c scripts', () => {
    const workDir = process.platform === 'win32' ? 'E:\\repo\\project' : '/repo/project';

    expect(detectCatastrophicShellCommand('sudo rm -rf /', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('sudo -u root rm -rf /', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('env FOO=1 rm -rf /', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('bash -c "rm -rf /"', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand("sh -lc 'rm -rf .'", workDir)).toContain('active workspace');
    expect(detectCatastrophicShellCommand('bash -c "ls -la"', workDir)).toBeNull();
  });

  it('detects home-directory wipes', () => {
    const workDir = process.platform === 'win32' ? 'E:\\repo\\project' : '/repo/project';

    expect(detectCatastrophicShellCommand('rm -rf ~', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rm -rf ~/', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rm -rf $HOME', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rm -rf ${HOME}', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('Remove-Item -Recurse -Force $env:USERPROFILE', workDir))
      .toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rd /s /q %USERPROFILE%', workDir)).toContain('explicit approval');
    expect(detectCatastrophicShellCommand('rm -rf ~/Downloads', workDir)).toBeNull();
  });

  it('stays safe when wrappers nest past the unwrap depth cap', () => {
    const workDir = process.platform === 'win32' ? 'E:\\repo\\project' : '/repo/project';
    const nested = `${'sudo '.repeat(12)}rm -rf /`;

    expect(() => detectCatastrophicShellCommand(nested, workDir)).not.toThrow();
  });

  it('allows catastrophic commands without prompting in true full-access mode', async () => {
    const base = {
      mode: 'bypassPermissions' as const,
      rules: [],
      runId: 'run-catastrophic-delete',
      workDir: process.cwd(),
      toolName: 'Bash',
      publicName: 'Bash',
      prompt: 'delete the workspace',
      toolInput: { command: 'rm -rf .' },
      iteration: 1,
    };

    const allowed = await decideHadamardToolPermission(base);
    expect(allowed).toMatchObject({
      behavior: 'allow',
      source: 'mode',
      // Marks the call as explicitly approved so the Bash/PowerShell
      // self-check does not re-block it downstream.
      safetyCritical: true,
    });
  });

  it('requires a one-time manual approval for catastrophic commands in approve-for-me mode', async () => {
    const base = {
      mode: 'approveForMe' as const,
      rules: [],
      runId: 'run-approve-for-me-catastrophic',
      workDir: process.cwd(),
      toolName: 'Bash',
      publicName: 'Bash',
      prompt: 'delete the workspace',
      toolInput: { command: 'rm -rf .' },
      iteration: 1,
    };

    const denied = await decideHadamardToolPermission(base);
    expect(denied.behavior).toBe('deny');
    expect(denied.reason).toContain('explicit approval');
    expect(denied.safetyCritical).toBe(true);

    let sawSafetyCritical = false;
    const approved = await decideHadamardToolPermission({
      ...base,
      approver: context => {
        sawSafetyCritical = context.safetyCritical === true;
        return { behavior: 'allow', reason: 'The user explicitly approved this exact deletion.' };
      },
    });
    expect(sawSafetyCritical).toBe(true);
    expect(approved).toMatchObject({
      behavior: 'allow',
      source: 'approver',
      safetyCritical: true,
    });
  });

  it('auto-allows ordinary edits and shell commands in approve-for-me mode', async () => {
    const shared = {
      mode: 'approveForMe' as const,
      rules: [],
      adapter: { isDestructive: () => true },
      runId: 'run-approve-for-me-ordinary',
      workDir: process.cwd(),
      prompt: 'do work',
      iteration: 1,
    };

    const edit = await decideHadamardToolPermission({
      ...shared,
      toolName: 'Write',
      publicName: 'Write',
      toolInput: { file_path: 'README.md', content: 'test' },
    });
    const shell = await decideHadamardToolPermission({
      ...shared,
      toolName: 'Bash',
      publicName: 'Bash',
      toolInput: { command: 'npm test' },
    });

    expect(edit.behavior).toBe('allow');
    expect(shell.behavior).toBe('allow');
  });

  it('still hard-denies protected paths in approve-for-me and full-access modes', async () => {
    for (const mode of ['approveForMe', 'bypassPermissions'] as const) {
      const result = await decideHadamardToolPermission({
        mode,
        rules: [],
        runId: `run-protected-${mode}`,
        workDir: process.cwd(),
        toolName: 'Write',
        publicName: 'Write',
        prompt: 'write git config',
        toolInput: { file_path: 'C:/repo/.git/config', content: 'x' },
        iteration: 1,
      });

      expect(result.behavior).toBe('deny');
      expect(result.reason).toContain('.git');
    }
  });
});

describe('permission modes', () => {
  const destructiveAdapter = {
    isDestructive: () => true,
  };

  it('requires approval for destructive tools in default mode', async () => {
    let approvalCalls = 0;
    const result = await decideHadamardToolPermission({
      mode: 'default',
      rules: [],
      adapter: destructiveAdapter,
      approver: () => {
        approvalCalls += 1;
        return { behavior: 'allow', reason: 'Approved for this test.' };
      },
      runId: 'run-default-approval',
      workDir: process.cwd(),
      toolName: 'Bash',
      publicName: 'Bash',
      prompt: 'run a command',
      toolInput: { command: 'npm test' },
      iteration: 1,
    });

    expect(approvalCalls).toBe(1);
    expect(result).toMatchObject({
      behavior: 'allow',
      source: 'approver',
    });
  });

  it('does not silently allow destructive tools without an approver', async () => {
    const result = await decideHadamardToolPermission({
      mode: 'default',
      rules: [],
      adapter: destructiveAdapter,
      runId: 'run-default-no-approval',
      workDir: process.cwd(),
      toolName: 'Bash',
      publicName: 'Bash',
      prompt: 'run a command',
      toolInput: { command: 'npm test' },
      iteration: 1,
    });

    expect(result).toMatchObject({
      behavior: 'deny',
      source: 'mode',
    });
    expect(result.reason).toContain('no approver');
  });

  it('acceptEdits allows file edits but still requires approval for shell commands', async () => {
    const edit = await decideHadamardToolPermission({
      mode: 'acceptEdits',
      rules: [],
      adapter: destructiveAdapter,
      runId: 'run-accept-edits',
      workDir: process.cwd(),
      toolName: 'Write',
      publicName: 'Write',
      prompt: 'write a file',
      toolInput: { file_path: 'README.md', content: 'test' },
      iteration: 1,
    });
    const shell = await decideHadamardToolPermission({
      mode: 'acceptEdits',
      rules: [],
      adapter: destructiveAdapter,
      runId: 'run-accept-edits',
      workDir: process.cwd(),
      toolName: 'Bash',
      publicName: 'Bash',
      prompt: 'run a command',
      toolInput: { command: 'npm test' },
      iteration: 1,
    });

    expect(edit.behavior).toBe('allow');
    expect(shell.behavior).toBe('deny');
    expect(shell.reason).toContain('no approver');
  });
});
