import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const gui = readFileSync(path.join(root, 'src/gui/hadamardGui.ts'), 'utf8');
const effective = readFileSync(path.join(root, 'src/runtime/effectiveAgentRunOptions.ts'), 'utf8');
const runtime = readFileSync(path.join(root, 'src/runtime/agentClient.ts'), 'utf8');
const targetResolver = readFileSync(path.join(root, 'src/manager/resolveTargetRef.ts'), 'utf8');

describe('Agents UI option contract', () => {
  const effectiveOptions = [
    ['agentProfilePromptMode', 'promptMode', 'source?.promptMode'],
    ['agentProfileSystemPrompt', 'systemPromptAppend', 'source?.systemPromptAppend'],
    ['agentProfilePermission', 'permissionMode', 'source?.permissionMode'],
    ['agentProfileEffort', 'effort', 'source?.effort'],
    ['agentProfileMaxTokens', 'maxTokens', 'source?.maxTokens'],
    ['agentProfileTemperature', 'temperature', 'source?.temperature'],
    ['agentProfileTopP', 'topP', 'source?.topP'],
    ['agentProfileMaxIterations', 'maxIterations', 'source?.maxIterations'],
    ['agentProfileTimeoutMs', 'timeoutMs', 'source?.timeoutMs'],
    ['agentProfileWorkspace', 'workspaceAccess', 'source?.workspaceAccess'],
    ['agentProfileTools', 'allowedTools', 'source?.allowedTools'],
    ['agentProfileSubagent', 'subagent', 'source?.subagent'],
  ] as const;

  it.each(effectiveOptions)(
    '%s persists %s and has an effective runtime consumer',
    (controlId, persistedField, runtimeNeedle) => {
      expect(gui).toContain(`id="${controlId}"`);
      expect(gui).toContain(`${persistedField}:`);
      expect(effective).toContain(runtimeNeedle);
    },
  );

  it('maps the configuration/model picker to both persisted identity fields and target resolution', () => {
    expect(gui).toContain("configSelect.id = 'agentProfileConfigPicker'");
    expect(gui).toContain("modelSelect.id = 'agentProfileModelSelect'");
    expect(gui).toContain("missing.textContent = selectedConfig + ' (missing)'");
    expect(gui).toContain("option.textContent = config ? 'No models configured' : 'Configuration is missing'");
    expect(gui).toContain('bridgeConfig: inherit ? \'\' : selectedAgentProfileConfig()');
    expect(gui).toContain('model: inherit ? \'\' : model');
    expect(gui).toContain('configModelPickerValue(g.config, model)');
    expect(targetResolver).toContain('ref.config');
    expect(targetResolver).toContain('ref.model');
  });

  it('uses description for delegated-agent discovery and excludes main-chat-only Agents', () => {
    expect(gui).toContain('description: el(\'agentProfileDescription\').value.trim()');
    expect(gui).toContain('>Description<input id="agentProfileDescription"');
    expect(gui).not.toContain('Description *');
    expect(gui).not.toContain('Description is required.');
    expect(runtime).toContain('definition.description');
    expect(runtime).toContain('definition.subagent !== false');
  });

  it('does not recursively re-enter the Agents region while an Agent editor is already open', () => {
    expect(gui).toContain("if (state.activeRegion !== 'team') await switchRegion('team')");
    expect(gui).toContain("if (kind !== 'profile' && kind !== 'agent-md') closeAgentProfileEditor()");
  });

  it('creates engine-valid Parallel nodes and saves dirty definitions before running them', () => {
    expect(gui).toContain("nodeType === 'branch' || nodeType === 'parallel'");
    expect(gui).toContain('? [wfDefaultChild(), wfDefaultChild()]');
    expect(gui).toContain('if (state.teamDirty && state.teamDefinition?.name === name)');
    expect(gui).toContain('const saved = await saveTeamDefinition()');
    expect(gui).toContain('const input = await promptTeamRun(name)');
    expect(gui).not.toContain("window.prompt('Run agent");
  });

  it('does not expose retired node-level runtime or reconnect controls', () => {
    expect(gui).not.toContain('id="agentProfileRuntime"');
    expect(gui).not.toContain('id="agentProfileReconnectAttempts"');
    expect(gui).not.toContain('Reconnect attempts');
  });
});
