# Hadamard Canvas (hcanvas)

Hadamard Canvas is a standalone, AI-native canvas application. It runs independently from the desktop GUI (`hadamard-gui`) and exposes one document model to humans and agents:

- **HTML pages** are rendered in a sandbox and can be edited directly in place (text, element styles) or through a full HTML/CSS source editor.
- **Canvas pages** mix HTML, text, Markdown, code, image, shape, native freehand and arrow blocks.
- **Agents** read and patch the same document through a small JSON-first CLI; no MCP or browser automation is required.

## Run it

```bash
# Start the app (local server + browser UI)
npx hcanvas app --workspace ~/.hcanvas

# Or start the headless service for agents/UI clients
npx hcanvas serve --workspace /path/to/workspace --port 4319
```

In this repository, build and run from source:

```bash
npm run build          # compiles the service/CLI and bundles the UI
node bin/hcanvas.js app --workspace plan/hcanvas-demo
```

### Standalone desktop app

Hadamard Canvas can run as its own Electron window, not just a browser tab:

```bash
hcanvas desktop --workspace <dir> [--port 4319]
# or: npm run hcanvas:desktop -- --workspace <dir>
# or: node bin/hcanvas-desktop.js --workspace <dir>
```

The desktop entry starts the local hcanvas service, opens a native window and closes the server when the window closes; the browser workflow (`hcanvas app`) remains available.

Package a Windows portable build with the Canvas icon:

```bash
npm run build:hcanvas:desktop
# dist_electron/canvas/Hadamard-Canvas-0.4.22-portable.exe
```

Run the portable exe with an explicit workspace when you want a self-contained copy:

```powershell
.\Hadamard-Canvas-0.4.22-portable.exe --workspace C:\Users\me\hcanvas --port 4319
```

Build the Windows installer instead of the portable exe:

```bash
npm run build:hcanvas:installer
# dist_electron/canvas/Hadamard-Canvas-Setup-0.4.22.exe
```

The installer is a normal NSIS wizard: choose the install directory, creates Start Menu and desktop shortcuts, and includes an uninstaller. It does not require a system-wide install.

The workspace stores documents, state and exports:

```
<workspace>/docs/<docId>.json     # document model (pages, blocks, HTML)
<workspace>/state.json            # active document/page/block and agent sessions
<workspace>/daemon.json           # URL + token for the running local service
<workspace>/exports/              # HTML/PDF/PNG output
```

## Whiteboard workspace

Interactive canvas controls: **mouse wheel zooms at the pointer**, **middle-drag pans**, Space/Hand pans. Whiteboard pages use the same wheel-zoom and middle-drag contract, applied to the Excalidraw viewport.

Whiteboard pages are full-workspace surfaces: the Excalidraw canvas fills the entire canvas viewport, while the hcanvas tool rail and page zoom controls are hidden. The full Excalidraw toolbar is available inside this page.

## Page thumbnails and deck management

The left page rail renders live thumbnails: HTML pages are previewed in a sandboxed iframe, canvas/infinite pages render their blocks, and whiteboard pages show a scene placeholder. Hovering a page reveals **move up / move down / duplicate / delete** actions, so a deck can be reordered and duplicated like a slide sorter.

## Page types and local HTML

Page modes: **HTML** (one editable HTML document per page), **Canvas** (fixed-size block layout), **Infinite** (boundless block surface; blocks live in world coordinates, the viewport paints the grid) and **Whiteboard** (Excalidraw scene as a full-workspace surface). Canvas/infinite pages use **HTML, text, Markdown, code, image, shape, freehand and arrow blocks**. Select blocks with **drag-marquee**, **Shift+click**, or by clicking a grouped block; **Ctrl/Cmd+G** groups / **Ctrl/Cmd+Shift+G** ungroups, and dragging any selected block moves the whole selection. Frames contain converted Excalidraw children: dragging a frame moves its `frameId` children with it. **Arrow (A)** snaps its endpoints to shapes, text, images and frames when dropped on them; bindings are stored as `startBinding` / `endBinding` and the arrow follows when a bound block is moved or resized. **Pen (P)**, **Arrow (A)** and **Eraser (E)** draw/erase native vectors directly on Infinite pages; freehand strokes are smoothed into paths, stored in the document JSON as block points, resizable, and use stroke color/width from the Inspector. **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** undo and redo block edits, **Ctrl/Cmd+C/V** copy and paste the selected block. Add Page also provides 20 presets: blank/HTML slides, Cover/Section/Two columns/Quote/Agenda, Canvas PPT cover/content, A4/square canvas, HTML A4, Résumé Classic/Modern/ATS, Event/Product posters, Infinite canvas and Excalidraw whiteboard.

Import a local HTML file from the desktop with **Import HTML** in the top bar (max 5MB) or:

```bash
hcanvas import ~/Desktop/page.html <doc-id> --title "Imported page" --width 1280 --height 720
```

The HTML is embedded into a new HTML page; editing it inside hcanvas does not modify the original file. Re-import to pick up external changes.

## Direct HTML editing

HTML pages and HTML blocks render in a sandboxed iframe:

- **Visual mode**: double-click text to edit it in place; click any element to inspect it. The inspector shows the element tree and controls for text color, background, font size, padding and alignment. Changes are patched back to the HTML source with stable `data-hc-id` targets.
- **Source mode**: open the source editor (CodeMirror) for full HTML/CSS editing with a live preview.
- Stable IDs mean an agent can patch one element without rewriting the page.
- In edit mode scripts are disabled; in preview mode the iframe runs with a sandboxed opaque origin.

## Canvas pages

Canvas pages contain absolutely positioned blocks:

| Block | Content |
|---|---|
| HTML | Sandboxed HTML fragment, directly editable |
| Text | Plain text with font/color controls |
| Markdown | Markdown source rendered on the canvas |
| Code | Syntax-preserved code preview |
| Image | Image URL |
| Shape | Rectangle/ellipse with fill, stroke, radius |

Pages can use slide (16:9), A4, poster (4:5), square and custom sizes. Present mode shows pages full screen; exports support HTML, PDF and PNG (local Chrome/Edge/Chromium). Page master/layout templates and editable PPTX export are future work.

## Infinite canvas and tools

Choose **Infinite canvas** when adding a page (or use the demo's Infinite canvas page). It has no page bounds: pan with the Hand tool, hold Space, or middle-drag; zoom with the mouse wheel at the pointer or the zoom controls, and place any block anywhere. The dot grid and 8px snapping can be toggled from the tool rail. Exports and Present crop infinite pages to their content bounds.

## Presentation workflow

- **Slide templates**: Cover, Section, Two columns, Quote and Agenda (16:9 HTML pages), plus blank slide/A4/poster.
- **Speaker notes**: edit per-page notes in the Inspector; Present mode has a Notes toggle and PPTX export writes notes into the deck.
- **Present**: full-screen page navigation with notes; Excalidraw whiteboard pages open in clean read-only view mode.
- **PowerPoint export**: `hcanvas export <doc> --format pptx` produces a 16:9 PPTX with one slide per page and speaker notes.
  - **Canvas pages** with text/shape/image blocks become **editable PowerPoint** text boxes and shapes (no HTML blocks).
  - `format=pptx-editable` additionally maps HTML headings, paragraphs, lists, inline labels and background cards to native PowerPoint text boxes/shapes using real browser layout data; pages with no extractable text fall back to images.
  - HTML, infinite and Excalidraw whiteboard pages are embedded as high-fidelity slide images in the default visual deck.
  - Canvas PPT templates (Canvas · PPT cover / content) are in **+ Page**.
  - Whiteboard images are rendered through the official Excalidraw CLI.

## Résumés and posters

Page templates for A4 résumés (Classic / Modern / ATS minimal) and 4:5 posters (Event / Product) are available from **+ Page**. They are ordinary editable HTML pages: direct-edit text, switch to source for layout changes, then export.

- **PDF / PNG / HTML**: vector print via the local browser; A4 and poster page sizes are preserved.
- **Print PDF**: Export → **Print PDF · 3mm bleed** (or `--format pdf --bleed-mm 3 --crop-marks`) adds a 3mm bleed and crop marks in a slug area. Output is RGB PDF; CMYK conversion is not performed.
- **DOCX (ATS)**: export the current HTML page with `format=docx` (UI: **Word résumé (.docx)**). The exporter walks semantic HTML (headings, paragraphs, lists) and writes a single-column A4 Word document with selectable text, suitable for ATS submission. Use the **ATS minimal** template for the safest result.
- **PPTX**: résumé/poster pages can also be embedded into a PPTX deck as full-page slides.

## Page masters

Any page (HTML, canvas, infinite or Excalidraw whiteboard) can be saved as a **workspace-scoped page master** and reused as a starting point:

- UI: Page inspector → **Save as master**; **+ Page** → **My page masters** shows live thumbnails of saved HTML/canvas layouts, with **Use** and **Delete** actions.
- CLI:
```bash
hcanvas masters save <doc> --page <pageId> --name "Title slide"
hcanvas masters list
hcanvas masters apply <masterId> <doc> --base-revision <rev>
hcanvas masters delete <masterId>
```

Masters are stored in `<workspace>/masters.json`; applying a master creates a new page with fresh page/block IDs and the original mode, size, background, HTML/blocks/scene and speaker notes. Editing the new page never changes the master.

## Excalidraw whiteboard pages

The **Excalidraw whiteboard** page preset embeds the full locally bundled Excalidraw editor: shapes, arrows, freehand, text, images, frames, hand-drawn styling, layers, zoom/pan, undo/redo and the Excalidraw toolbar. The page is stored as an Excalidraw scene in the document:

```bash
hcanvas read <doc> --format scene --page <whiteboard-page-id>
hcanvas apply <doc> --ops-file scene-ops.json --base-revision <rev> --actor claude-code
```

```json
[{ "op": "set_whiteboard_scene", "pageId": "page_...", "scene": { "elements": [], "appState": {}, "files": {} } }]
```

Edits are autosaved with revision checks. `Download .excalidraw` in the page inspector exports the scene; HTML/PDF/PNG/PPTX export renders whiteboard pages locally through the bundled Excalidraw CLI.

### Migrating a whiteboard to native Infinite

Click **Convert to native Infinite** in a whiteboard page's Inspector. hcanvas converts Excalidraw elements into native Infinite blocks (freehand strokes, arrows and bindings, text, rectangles, ellipses, diamonds, frames, rotated/opacity/dashed elements and image data URLs) and opens the new page. The source whiteboard is left untouched.

The same conversion is available from the CLI, together with native scene import/export:

```bash
hcanvas convert-whiteboard <doc> --page <whiteboardPageId> --title "Board · Native"
hcanvas import-scene ./board.excalidraw <doc> --title "Imported board"
hcanvas export-scene <doc> --page <infinitePageId> --out ./exports/board.excalidraw
```

Infinite pages also expose **Export → Excalidraw scene** in the top bar. Elements that have no native representation yet (rare embeds) are skipped and reported in the page notes.

### Multi-agent presence

Create a session per agent and keep it alive; hcanvas shows live actors in the **Agent** tab and as avatars in the top bar:

```bash
hcanvas sessions create <doc> --actor claude-code
export HCANVAS_SESSION=session_...
hcanvas context --json          # heartbeats automatically
hcanvas read <doc> --format outline
hcanvas apply <doc> --ops-file ops.json --base-revision <rev>
hcanvas sessions list           # all live/stale sessions
hcanvas sessions heartbeat <id> --doc <doc> --page <page> --block <block>
hcanvas sessions delete <id>
```

The Agent tab shows actor, current document/page, selection, last heartbeat, recent document activity (history), agent context JSON and copy-paste CLI snippets. Stale sessions are dimmed after 10 minutes.

Agents with a session on the current page appear as colored cursors inside the canvas. Canvas/infinite cursors anchor to their block; HTML cursors are measured against the rendered page and anchored to the reported `data-hc-id` element; Excalidraw whiteboard cursors are projected from the scene element's position through the whiteboard scroll/zoom state. Click a cursor to **follow** that agent: hcanvas opens its document/page and selects the reported block or HTML element.

## Canvas Copilot (in-app AI)

The **Copilot** tab embeds an agent that can read and edit the current canvas without a terminal. It uses an OpenAI-compatible chat-completions endpoint and two tools: `canvas_read` (outline/html/page/scene + revision) and `canvas_apply` (hcanvas ops with revision CAS).

Configure a model with environment variables before starting hcanvas:

```bash
export HCANVAS_LLM_BASE_URL="https://api.openai.com/v1"
export HCANVAS_LLM_API_KEY="..."
export HCANVAS_LLM_MODEL="gpt-4o-mini"
hcanvas app --workspace ~/.hcanvas
```

Or create `<workspace>/agent.json` (never commit it):

```json
{ "baseUrl": "https://api.openai.com/v1", "apiKey": "...", "model": "gpt-4o-mini" }
```

Copilot reads before writing, applies changes with revision checks, and reloads the canvas after edits. If no model is configured the tab shows setup instructions; the CLI protocol remains available without any model.

## Agent protocol (CLI-first)

The CLI prints JSON by default, uses stdin/stdout, has structured errors and exit codes, and is the primary interface for agents (Claude Code, Kimi Code, DSH, Hadamard, Codex, ...):

```bash
hcanvas context --json                         # active document/page/selection + sessions
hcanvas read <doc> --format outline            # semantic outline
hcanvas read <doc> --format html --page <id>   # exact HTML source
hcanvas apply <doc> --ops-file ops.json --base-revision 7 --actor claude-code
hcanvas propose <doc> --ops-file ops.json --base-revision 7 --intent "Add a slide"
hcanvas proposal list <doc>
hcanvas proposal accept <doc> <proposalId>
hcanvas export <doc> --format pdf --out deck.pdf
```

Addressing rules:

1. explicit document id / title / `hcanvas://doc/<id>` reference;
2. `HCANVAS_DOC` / session context;
3. unique document in the workspace;
4. otherwise the CLI returns candidates and the agent should ask, never guess for writes.

Writes are revision-checked with `--base-revision`. A stale revision fails with exit code `2` and the latest revision. Agent sessions can be bound to a document/page/selection with `HCANVAS_SESSION`; the service records active context for `hcanvas context`.

### Patch example

```json
[
  {
    "op": "html_patch",
    "pageId": "page_...",
    "patches": [
      { "op": "set_text", "target": "el_...", "text": "New heading" },
      { "op": "set_style", "target": "el_...", "styles": { "color": "#6d28d9", "font-size": "20px" } },
      { "op": "set_html", "target": "el_...", "html": "Hello <em>world</em>" }
    ]
  }
]
```

Proposals are the review path: an agent submits ops with `hcanvas propose`, and a human accepts or rejects them in the Proposals tab. Accepted proposals become a new revision; conflicts are surfaced, not overwritten.

### HTTP API

`hcanvas serve` also exposes the same API:

- `GET /api/state`, `GET /api/context`, `GET /api/docs`
- `GET /api/docs/:id/read?format=outline|html|json|page`
- `POST /api/docs/:id/apply`
- `POST /api/docs/:id/proposals`, `POST .../proposals/:proposalId/accept|reject`
- `POST /api/export`, `GET /api/export/download`
- `GET /api/events` (SSE change stream)

Requests require the `x-hcanvas-token` header (or `?token=` for SSE), and the service binds localhost by default.

## Security

- Localhost-only server with a per-process token; `daemon.json` stores URL/token for CLI discovery.
- HTML rendering is sandboxed: edit iframes use `allow-same-origin` without scripts; preview iframes use scripts without same-origin.
- No remote CDN is required; source editor and UI assets are bundled locally.
- Writes are serialized per document, revision-checked and recorded in history.

## Limits

- hcanvas is currently a local web app (Electron packaging and multi-window are future work).
- Visual HTML editing focuses on text and style; structural edits use the source editor.
- No real-time multi-user CRDT yet; multiple agents/hosts coordinate through revisions and proposals.
- PPTX visual deck keeps HTML pages as images; the separate editable deck maps HTML text to native PowerPoint objects (layout is approximate; complex CSS effects are not reconstructed). Page masters, assets library and vector PDF remain extensions.
- DOCX export is intentionally text-first/ATS-oriented; it does not reproduce visual layout, cards or decorative graphics.
## Project workspaces

Select a project folder and let hcanvas initialize it; all product data lives inside `<project>/.hcanvas`:

```bash
hcanvas workspace init ~/projects/my-deck
hcanvas projects list
hcanvas app --project ~/projects/my-deck
hcanvas desktop --project ~/projects/my-deck
```

The **Projects ▾** menu lists every initialized project from the global registry (`~/.hcanvas/projects.json`). In the desktop app, choosing a project opens it in a **separate native window** (multiple projects can be open at once); **Open Project…** opens a native folder picker and creates/opens `<project>/.hcanvas`. In browser mode, the menu can open another project whose local service is already running. Clicking the workspace path in the bottom-left opens a Workspace dialog with the resolved paths, the generated CLI guide and a copy button. Initialization is non-destructive and creates:

```text
<project>/.hcanvas/
  CLI.md          # generated CLI guide
  workspace.json  # project identity / schema
  docs/           # documents
  exports/        # exported files
  .gitignore      # daemon.json + exports/
```

## Storage format

A workspace (usually `<project>/.hcanvas`) is a plain directory:

```
<workspace>/docs/<docId>.json   # document: pages, html/blocks/scene, history, proposals
<workspace>/state.json         # active canvas/page and agent sessions
<workspace>/masters.json        # reusable page masters
<workspace>/daemon.json         # local URL + token for the running service
<workspace>/exports/            # HTML/PDF/PNG/PPTX/DOCX outputs
```

Documents use the JSON schema `hadamard-canvas/1`. HTML pages store their full source in `page.html`; canvas/infinite pages store `page.blocks`; Excalidraw pages store `page.scene`. Without a project, the desktop app falls back to `~/.hcanvas`; `--workspace <dir>` still addresses a store root directly. `--project <dir>` is the recommended project-scoped mode.