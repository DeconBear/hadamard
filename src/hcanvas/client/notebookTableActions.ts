import { notebookTableToCsv, type NotebookTable } from '../notebook/table.js';

function downloadCsv(table: NotebookTable): void {
  const url = URL.createObjectURL(new Blob([notebookTableToCsv(table)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'notebook-table.csv';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function installNotebookTableActions(toast: (message: string, kind?: 'info' | 'success' | 'error') => void): void {
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-hc-table-copy], [data-hc-table-download]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const host = button.closest<HTMLElement>('[data-hc-table-json]');
    if (!host) return;
    try {
      const table = JSON.parse(host.dataset.hcTableJson || '') as NotebookTable;
      if (button.hasAttribute('data-hc-table-download')) downloadCsv(table);
      else if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(notebookTableToCsv(table)).then(() => toast('CSV copied to clipboard.', 'success'), () => toast('Could not access the clipboard.', 'error'));
      else {
        const textarea = document.createElement('textarea');
        textarea.value = notebookTableToCsv(table);
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        toast(copied ? 'CSV copied to clipboard.' : 'Could not access the clipboard.', copied ? 'success' : 'error');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}
