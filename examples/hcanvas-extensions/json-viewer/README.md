# JSON Viewer (Hcanvas extension)

File viewer for `.json` documents with formatted output. The viewer receives
the file context through `HcanvasView.acquire()` and reads it with
`hc.files.read`; invalid JSON is reported inline instead of failing the tab.

## Usage

Copy the folder into `<workspace>/extensions/json-viewer` and open a `.json`
file. JSON files are also still readable by the built-in text preview when the
extension is disabled.

## Files

- `manifest.json` — `.json` format and iframe viewer.
- `ui/entry.html` — formatted rendering with an error state.
