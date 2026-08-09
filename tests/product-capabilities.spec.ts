import { describe, expect, it } from 'vitest';

import {
  getProductCapability,
  productCapabilities,
  searchProductCapabilities,
} from '../src/help/productCapabilities.js';
import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
} from '../src/ui/commandSurface.js';

describe('product capability registry', () => {
  it('covers every shared GUI/TUI command and subcommand', () => {
    for (const command of Object.keys(HADAMARD_INTERACTIVE_COMMANDS)) {
      const capability = getProductCapability(`command.${command}`);
      expect(capability, `missing /${command}`).not.toBeNull();
      expect(capability?.commands.some(item => item.startsWith(`/${command}`))).toBe(true);
      for (const subcommand of SUBCOMMANDS[command] ?? []) {
        expect(capability?.commands).toContain(`/${command} ${subcommand}`);
      }
    }
  });

  it('covers every top-level desktop surface', () => {
    for (const id of ['gui.projects', 'gui.agents', 'gui.automation', 'gui.customize', 'gui.assistant', 'gui.settings']) {
      const capability = getProductCapability(id);
      expect(capability, id).not.toBeNull();
      expect(capability?.uiLocations.length).toBeGreaterThan(0);
      expect(capability?.steps.length).toBeGreaterThan(0);
      expect(capability?.limitations).toBeDefined();
    }
  });

  it('grounds common beginner questions in current UI instructions', () => {
    const workflow = searchProductCapabilities('create workflow choose agent model configuration');
    expect(workflow.some(item => item.id === 'gui.agents')).toBe(true);
    const assistant = getProductCapability('gui.assistant')!;
    expect(assistant.uiLocations).toContain('Bottom-right Assistant > Global');
    expect(assistant.steps.join(' ')).toMatch(/Preview and apply/i);
    expect(productCapabilities.length).toBeGreaterThan(Object.keys(HADAMARD_INTERACTIVE_COMMANDS).length);
  });
});
