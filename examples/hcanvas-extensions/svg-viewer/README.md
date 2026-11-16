# SVG Viewer (Hcanvas extension)

Sandboxed file viewer for `.svg` files. It reads the opened file through the
host SDK, creates a blob URL and renders it in an `<img>`; no network or
process capability is required.

## Usage

1. Copy this folder to `<workspace>/extensions/svg-viewer` (for a project
   workspace: `.hcanvas/extensions/svg-viewer`).
2. Open any `.svg` file from the Files panel; it opens in a workspace tab.

## Files

- `manifest.json` — format + iframe viewer, `file` surface.
- `ui/entry.html` — viewer entry (host SDK `hc.files.read`).
