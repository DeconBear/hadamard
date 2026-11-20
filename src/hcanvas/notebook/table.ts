export interface NotebookTable {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function notebookTableFromJson(value: unknown): NotebookTable | null {
  if (!Array.isArray(value) || !value.length) return null;
  const source = value.slice(0, 1000);
  if (source.every(row => Array.isArray(row))) {
    const width = Math.min(20, Math.max(...source.map(row => row.length)));
    return {
      columns: Array.from({ length: width }, (_, index) => String(index + 1)),
      rows: source.map(row => Array.from({ length: width }, (_, index) => row[index] ?? null)),
      totalRows: value.length,
    };
  }
  if (source.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
    const columns: string[] = [];
    for (const row of source) for (const key of Object.keys(row)) if (!columns.includes(key) && columns.length < 20) columns.push(key);
    return { columns, rows: source.map(row => columns.map(column => (row as Record<string, unknown>)[column] ?? null)), totalRows: value.length };
  }
  return { columns: ['value'], rows: source.map(row => [row]), totalRows: value.length };
}

export function notebookTableToCsv(table: NotebookTable): string {
  const quote = (value: unknown): string => '"' + cellText(value).replace(/"/g, '""') + '"';
  return [table.columns, ...table.rows].map(row => row.map(quote).join(',')).join('\r\n');
}

function escapeHtml(value: unknown): string {
  return cellText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderNotebookTableHtml(value: unknown): string {
  const table = notebookTableFromJson(value);
  if (!table) return '';
  const rows = table.rows.slice(0, 100).map(row => '<tr>' + row.map(cell => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>').join('');
  return '<div class="hc-data-table" data-hc-table-json="' + escapeHtml(JSON.stringify(table)) + '">' +
    '<div class="hc-data-table-actions"><span>' + table.totalRows + ' rows' + (table.totalRows > 100 ? ' · first 100 shown' : '') + '</span><button type="button" data-hc-table-copy>Copy CSV</button><button type="button" data-hc-table-download>Download CSV</button></div>' +
    '<div class="hc-data-table-scroll"><table><thead><tr>' + table.columns.map(column => '<th>' + escapeHtml(column) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}
