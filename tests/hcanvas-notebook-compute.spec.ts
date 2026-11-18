import { describe, expect, it } from 'vitest';
import { latexToComputation } from '../src/hcanvas/notebook/latexCompute.js';
import { isNotebookVariableName, normalizeNotebookVariables, NOTEBOOK_VARIABLES_MIME, parseNotebookVariable, variableValueText, variablesFromEvents, visibleKernelEvents } from '../src/hcanvas/notebook/variables.js';
import { parseFrontmatter, parseNotebook } from '../src/hcanvas/notebook/format.js';

describe('notebook shared variables', () => {
  it('accepts portable JSON values and rejects ambiguous names', () => {
    expect(parseNotebookVariable('distance', '120.5')).toBe(120.5);
    expect(parseNotebookVariable('enabled', 'true')).toBe(true);
    expect(parseNotebookVariable('route', '["Hotel", "Beach"]')).toEqual(['Hotel', 'Beach']);
    expect(parseNotebookVariable('label', 'Yangjiang')).toBe('Yangjiang');
    expect(() => parseNotebookVariable('class', '1')).toThrow(/portable name/u);
    expect(() => parseNotebookVariable('not valid!', '1')).toThrow(/portable name/u);
  });

  it('normalizes nested JSON but rejects non-finite numbers', () => {
    expect(normalizeNotebookVariables({ total: 42, route: ['A', 'B'], options: { scenic: true } })).toEqual({ total: 42, route: ['A', 'B'], options: { scenic: true } });
    expect(normalizeNotebookVariables({ bad: Number.POSITIVE_INFINITY, class: 1, valid: 2 })).toEqual({ valid: 2 });
  });

  it('rejects kernel helper names and language keywords', () => {
    for (const name of ['hc_get', 'hc_set', 'hc_vars', 'hc_display', 'main', 'true', 'false', 'nullptr', 'concept', 'match', 'endfunction']) {
      expect(isNotebookVariableName(name), name).toBe(false);
    }
    expect(isNotebookVariableName('distance')).toBe(true);
  });

  it('preserves a string value when the variable panel displays and reparses it', () => {
    const original = parseNotebookVariable('label', '"42"');
    const displayed = variableValueText(original);
    expect(displayed).toBe('"42"');
    expect(parseNotebookVariable('label', displayed)).toBe('42');
  });

  it('reads variable snapshots without exposing protocol events as outputs', () => {
    const events = [
      { kind: 'stream', text: 'calculating\n' },
      { kind: 'display', data: { [NOTEBOOK_VARIABLES_MIME]: { total: 42 } } },
    ];
    expect(variablesFromEvents(events)).toEqual({ total: 42 });
    expect(visibleKernelEvents(events)).toEqual([events[0]]);
  });

  it('round-trips variables through notebook frontmatter', () => {
    const source = '---\nhcanvas: notebook\nvariables: {"distance":120.5,"scenic":true}\n---\n\n# Demo\n';
    const parsed = parseNotebook(source);
    expect(parsed.frontmatter.values.variables).toBe('{"distance":120.5,"scenic":true}');
    expect(JSON.parse(parsed.frontmatter.values.variables!)).toEqual({ distance: 120.5, scenic: true });
    expect(parseFrontmatter(source.split('\n')).frontmatter.values.variables).toContain('distance');
  });
});

describe('LaTeX to notebook code', () => {
  it('converts implicit multiplication and exponentiation to Python', () => {
    const result = latexToComputation('E = mc^2', 'python');
    expect(result.target).toBe('E');
    expect(result.symbols).toEqual(['m', 'c']);
    expect(result.code).toContain('E = (m * ((c) ** (2)))');
    expect(result.code).toContain('hc_set("E", E)');
    expect(result.code).toContain('print(E)');
  });

  it('uses known shared variable names instead of splitting them into letters', () => {
    const result = latexToComputation('\\frac{distance}{2} + \\sqrt{9}', 'octave', { distance: 120 });
    expect(result.symbols).toEqual(['distance']);
    expect(result.code).toContain('distance');
    expect(result.code).toContain('sqrt(9)');
    expect(result.code).toContain('hc_set("formula_result", formula_result)');
  });

  it('emits C++ double literals for fractions and roots', () => {
    const fraction = latexToComputation('\\frac{1}{2} + \\sqrt[3]{x}', 'cpp');
    expect(fraction.code).toContain('1.0 / 2.0');
    expect(fraction.code).toContain('1.0 / 3.0');
  });

  it('creates inspectable C++ with shared-variable reads', () => {
    const result = latexToComputation('total = price * count', 'cpp', { price: 12, count: 3 });
    expect(result.code).toContain('hc_get("price", 0.0)');
    expect(result.code).toContain('hc_get("count", 0.0)');
    expect(result.code).toContain('const double total');
    expect(result.code).toContain('std::cout << total');
  });

  it('supports roots, negative powers and common functions', () => {
    expect(latexToComputation('\\sqrt[3]{x}', 'python').code).toContain('(1 / 3)');
    expect(latexToComputation('2^{-1}', 'octave').code).toContain('(-1)');
    expect(latexToComputation('\\ln(x) + \\sin(x)', 'python').code).toContain('math.log');
  });

  it('rejects unsupported or non-assignment LaTeX instead of executing it', () => {
    expect(() => latexToComputation('\\begin{matrix}1&2\\end{matrix}', 'python')).toThrow(/Unsupported|Expected/u);
    expect(() => latexToComputation('a = b = c', 'python')).toThrow(/multiple equals/u);
    expect(() => latexToComputation('\\write18{rm -rf /}', 'python')).toThrow(/Unsupported|Expected/u);
    expect(() => latexToComputation('\\operatorname{unknown}(x)', 'python')).toThrow(/Unsupported|Expected/u);
  });
});
