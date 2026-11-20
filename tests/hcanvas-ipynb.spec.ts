import { describe, expect, it } from 'vitest';
import { parseIpynb, serializeIpynb } from '../src/hcanvas/notebook/ipynb.js';

const sample = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python' },
    hcanvas: { defaultKernelId: 'python', variables: { distance: 12 } },
  },
  cells: [
    { cell_type: 'markdown', id: 'intro', source: ['# Demo\n'], metadata: {} },
    {
      cell_type: 'code', id: 'calc', source: ['print(distance)\n'], metadata: {}, execution_count: 3,
      outputs: [
        { output_type: 'stream', name: 'stdout', text: '12\n' },
        { output_type: 'display_data', data: { 'text/latex': 'x^2' }, metadata: {} },
      ],
    },
  ],
};

describe('Jupyter notebook interoperability', () => {
  it('reads code, markdown, outputs, counts and shared variables', () => {
    const { data } = parseIpynb(JSON.stringify(sample));
    expect(data.cells).toHaveLength(2);
    expect(data.cells[0]).toMatchObject({ kind: 'markdown', source: '# Demo\n' });
    expect(data.cells[1]).toMatchObject({ kind: 'code', executionCount: 3, kernelId: 'python' });
    expect(data.cells[1]?.outputs).toHaveLength(2);
    expect(data.variables).toEqual({ distance: 12 });
  });

  it('round-trips nbformat data and output MIME bundles', () => {
    const first = parseIpynb(JSON.stringify(sample));
    const serialized = serializeIpynb(first.data, first.metadata);
    const second = parseIpynb(serialized);
    expect(second.data.cells[1]?.executionCount).toBe(3);
    expect(second.data.cells[1]?.outputs?.[0]).toMatchObject({ kind: 'stream', text: '12\n' });
    expect(second.data.cells[1]?.outputs?.[1]).toMatchObject({ kind: 'math', tex: 'x^2' });
    expect(second.data.variables).toEqual({ distance: 12 });
    expect(JSON.parse(serialized).metadata.kernelspec.name).toBe('python3');
  });

  it('keeps editable initial values separate from computed current values', () => {
    const parsed = parseIpynb(JSON.stringify(sample));
    parsed.data.initialVariables = { distance: 12 };
    parsed.data.variables = { distance: 24, answer: 42 };
    parsed.data.variablesInitialized = true;
    const roundTrip = parseIpynb(serializeIpynb(parsed.data, parsed.metadata));
    expect(roundTrip.data.initialVariables).toEqual({ distance: 12 });
    expect(roundTrip.data.variables).toEqual({ distance: 24, answer: 42 });
    expect(roundTrip.data.variablesInitialized).toBe(true);
  });

  it('rejects non-nbformat documents', () => {
    expect(() => parseIpynb('{"nbformat":3,"cells":[]}')).toThrow(/nbformat 4/u);
  });
});
