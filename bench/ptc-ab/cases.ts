import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PtcAbArmConfig, PtcAbCase } from './types.js';

export { PTC_AB_ARMS } from './types.js';

/**
 * P4 A/B local scenario cases: deterministic end-state graders, no hidden
 * grader/gold content in the agent-visible prompt (harness rule). Each case
 * exercises one capability family the plan calls out for Native/PTC/CodeAct
 * comparison.
 */

async function write(workDir: string, name: string, content: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, name), content, 'utf8');
}

async function readTrim(workDir: string, name: string): Promise<string> {
  try {
    return (await readFile(path.join(workDir, name), 'utf8')).trim();
  } catch {
    // A missing output file is a normal fail state, not a grader exception.
    return '';
  }
}

const DEFAULT_MAX_TOOL_ITERATIONS = 12;

export const PTC_AB_CASES: readonly PtcAbCase[] = [
  {
    id: 'serial-dependency',
    family: 'serial-dependency',
    runtimeTarget: 'clean-sdk',
    prompt: 'Read the file input.txt (one number per line), compute the sum of all numbers, then write the sum as a single integer to output.txt. Do not write anything else into output.txt.',
    setup: async (workDir) => {
      await write(workDir, 'input.txt', '3\n5\n9\n17\n');
    },
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'output.txt')) === '34',
      detail: 'output.txt must contain exactly the sum 34',
    }),
  },
  {
    id: 'parallel-reads',
    family: 'parallel-reads',
    runtimeTarget: 'clean-sdk',
    prompt: 'The files a.txt, b.txt, and c.txt each contain one integer. Read all three and write their product as a single integer to product.txt.',
    setup: async (workDir) => {
      await write(workDir, 'a.txt', '7');
      await write(workDir, 'b.txt', '11');
      await write(workDir, 'c.txt', '13');
    },
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'product.txt')) === '1001',
      detail: 'product.txt must contain exactly 1001',
    }),
  },
  {
    id: 'large-result-filtering',
    family: 'large-result-filtering',
    runtimeTarget: 'clean-sdk',
    prompt: 'The file big.txt has thousands of lines; exactly one contains the text MARKER. Find that line and write ONLY that exact line to found.txt. Do not copy the whole file anywhere.',
    setup: async (workDir) => {
      const lines: string[] = [];
      for (let index = 0; index < 3000; index += 1) {
        lines.push(index === 1999 ? 'MARKER-LINE-42' : `filler line ${index} with some padding content to make the file large`);
      }
      await write(workDir, 'big.txt', `${lines.join('\n')}\n`);
    },
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'found.txt')) === 'MARKER-LINE-42',
      detail: 'found.txt must contain exactly MARKER-LINE-42',
    }),
  },
  {
    id: 'permission-denial',
    family: 'permission-denial',
    runtimeTarget: 'clean-sdk',
    prompt: 'Create a file named result.txt containing exactly the text hello-world. The Bash tool is disabled for this task, so use the file tools instead.',
    setup: async () => undefined,
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'result.txt')) === 'hello-world',
      detail: 'result.txt must contain exactly hello-world',
    }),
  },
  {
    id: 'tool-failure-recovery',
    family: 'tool-failure-recovery',
    runtimeTarget: 'clean-sdk',
    prompt: 'Try to read the file missing-xyz.txt (it does not exist and the attempt will fail). After observing the failure, write exactly the text RECOVERED to recovered.txt.',
    setup: async () => undefined,
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'recovered.txt')) === 'RECOVERED',
      detail: 'recovered.txt must contain exactly RECOVERED',
    }),
  },
  {
    id: 'mutating-barrier',
    family: 'mutating-barrier',
    runtimeTarget: 'clean-sdk',
    prompt: 'Append the letter A to order.txt, then append the letter B to order.txt (A before B). The final file must contain exactly AB with no newline.',
    setup: async (workDir) => {
      await write(workDir, 'order.txt', '');
    },
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'order.txt')) === 'AB',
      detail: 'order.txt must contain exactly AB',
    }),
  },
  {
    id: 'context-compaction',
    family: 'context-compaction',
    runtimeTarget: 'clean-sdk',
    prompt: 'There are five files: fact-1.txt .. fact-5.txt. Each contains padding followed by a FACT at the very end. Read them all, collect the five facts, and write them one per line in file order to facts.txt.',
    setup: async (workDir) => {
      const facts = ['FACT-ALPHA', 'FACT-BRAVO', 'FACT-CHARLIE', 'FACT-DELTA', 'FACT-ECHO'];
      for (let index = 0; index < 5; index += 1) {
        const padding = Array.from({ length: 150 }, (_, line) => `padding line ${line} of fact file ${index + 1}`).join('\n');
        await write(workDir, `fact-${index + 1}.txt`, `${padding}\nFACT: ${facts[index]}\n`);
      }
    },
    grader: async (workDir) => ({
      passed: (await readTrim(workDir, 'facts.txt')) === 'FACT-ALPHA\nFACT-BRAVO\nFACT-CHARLIE\nFACT-DELTA\nFACT-ECHO',
      detail: 'facts.txt must list the five facts in order',
    }),
    maxToolIterations: 14,
    contextWindowTokens: 12_000,
  },
];

export function caseMaxToolIterations(testCase: PtcAbCase): number {
  return testCase.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
}

