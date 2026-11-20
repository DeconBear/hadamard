import { describe, expect, it } from 'vitest';
import { notebookTableFromJson, notebookTableToCsv, renderNotebookTableHtml } from '../src/hcanvas/notebook/table.js';
import { parseVariablesCsv, parseVariablesJson, serializeVariablesJson } from '../src/hcanvas/notebook/variablesImport.js';

describe('notebook table output', () => {
  it('turns object arrays into columns and CSV', () => {
    const table = notebookTableFromJson([{ city: 'Yangjiang', distance: 120.5 }, { city: 'Zhuhai', distance: 230 }])!;
    expect(table.columns).toEqual(['city', 'distance']);
    expect(notebookTableToCsv(table)).toContain('"Yangjiang","120.5"');
  });

  it('supports matrices and quote escaping', () => {
    const table = notebookTableFromJson([[1, 'a,b'], [2, 'say "hello"']])!;
    expect(notebookTableToCsv(table)).toContain('"a,b"');
    expect(notebookTableToCsv(table)).toContain('"say ""hello"""');
  });

  it('renders bounded native tables with working action hooks', () => {
    const html = renderNotebookTableHtml(Array.from({ length: 120 }, (_, index) => ({ index })));
    expect(html).toContain('data-hc-table-copy');
    expect(html).toContain('data-hc-table-download');
    expect(html).toContain('first 100 shown');
  });
});

describe('notebook variable import/export', () => {
  it('parses JSON objects', () => {
    expect(parseVariablesJson('{"distance":12,"scenic":true}')).toEqual({ distance: 12, scenic: true });
    expect(serializeVariablesJson({ distance: 12 })).toContain('"distance": 12');
  });

  it('parses CSV headers, quoted values and JSON values', () => {
    const variables = parseVariablesCsv('name,value\ndistance,120.5\nlabel,"Yangjiang, Guangdong"\nflags,"[true,false]"\n');
    expect(variables.distance).toBe(120.5);
    expect(variables.label).toBe('Yangjiang, Guangdong');
    expect(variables.flags).toEqual([true, false]);
  });
});
