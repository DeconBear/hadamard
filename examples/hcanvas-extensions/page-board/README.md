# Board Page (Hcanvas extension)

Custom page format rendered by an extension viewer. Pages created with this
format store `{ mode: "extension", extension: { format: "board-page", data } }`;
the viewer receives the page data through `hc.context.page` and
`hc.document.read()`. The sample board appears when `data.columns` is absent.

## Usage

1. Copy the folder into `<workspace>/extensions/page-board`.
2. Command palette → **Page: Add extension page** → **Board page**.
3. The page participates in the page list, undo/redo and Present (read-only).
   Export is intentionally rejected with a readable message until capture is
   implemented.

## Files

- `manifest.json` — `.board.json` format/viewer with `file` and `page` surfaces.
- `ui/entry.html` — Kanban-style board renderer.
