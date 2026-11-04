# Hadamard Canvas (hcanvas)

Hadamard Canvas is a standalone, AI-native canvas application. It runs independently from the desktop GUI (`hadamard-gui`) and exposes one document model to humans and agents:

- **HTML pages** are rendered in a sandbox and can be edited directly in place (text, element styles) or through a full HTML/CSS source editor.
- **Canvas pages** mix HTML, text, Markdown, code, image, shape, native freehand, curve and arrow blocks. Use the **Curve (C)** tool to drag a smooth cubic Bezier; curves have tight selectable bounds (unlike full-page freehand strokes), editable stroke color/width/dash and move/resize handles. Selecting a curve exposes four native node handles (start, two Bezier controls, end); drag a handle to reshape the curve in place.
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

## Legacy whiteboard preview

Whiteboard pages are **legacy read-only pages**. hcanvas renders their stored Excalidraw scene through the native block renderer — no Excalidraw bundle or runtime is loaded or served. The Inspector exposes **Convert to native Infinite**; converted pages become normal editable Infinite pages.

## Page thumbnails and deck management

The left page rail renders live thumbnails: HTML pages are previewed in a sandboxed iframe, canvas/infinite pages render their blocks, and legacy whiteboard pages render a native conversion of their scene. Hovering a page reveals **move up / move down / duplicate / delete** actions, so a deck can be reordered and duplicated like a slide sorter.

## Page types and local HTML

Page modes: **HTML** (one editable HTML document per page), **Canvas** (fixed-size block layout), **Infinite** (boundless block surface; blocks live in world coordinates, the viewport paints the grid) and **Whiteboard** (legacy Excalidraw scene; new pages use native Infinite). Canvas/infinite pages use **HTML, text, Markdown, code, image, shape, freehand and arrow blocks**. Select blocks with **drag-marquee**, **Shift+click**, or by clicking a grouped block; **Ctrl/Cmd+G** groups / **Ctrl/Cmd+Shift+G** ungroups, and dragging any selected block moves the whole selection. Frames contain converted Excalidraw children: dragging a frame moves its `frameId` children with it. **Arrow (A)** snaps its endpoints to shapes, text, images and frames when dropped on them; bindings are stored as `startBinding` / `endBinding` and the arrow follows when a bound block is moved or resized. Text blocks can be dragged by their body after selection or by the small **label handle** above the block; double-click edits in place, `Esc` finishes. When blocks overlap, **Alt+click** cycles through the stacked blocks. On Infinite pages, choosing an insert type (HTML/Text/Markdown/Code/Shape) enters **click-to-place** mode: the next canvas click creates the block at that world coordinate. Infinite coordinates are unbounded (negative x/y are valid) and frames never clip or constrain blocks; a frame can be **dissolved** from its Inspector while keeping its children. **Pen (P)**, **Arrow (A)** and **Eraser (E)** draw/erase native vectors directly on Infinite pages; freehand strokes are smoothed into paths, stored in the document JSON as block points, resizable, and use stroke color/width from the Inspector. **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** undo and redo block edits, **Ctrl/Cmd+C/V** copy and paste the selected block. Add Page also provides 19 presets: blank/HTML slides, Cover/Section/Two columns/Quote/Agenda, Canvas PPT cover/content, A4/square canvas, HTML A4, Résumé Classic/Modern/ATS, Event/... (line truncated to 2000 chars)

Import a local HTML file from the desktop with **Import HTML** in the top bar (max 5MB) or:

```bash
hcanvas import ~/Desktop/page.html <doc-id> --title "Imported page" --width 1280 --height 720
```

The HTML is embedded into a new HTML page; editing it inside hcanvas does not modify the original file. Re-import to pick up external changes.

## Direct HTML editing

HTML pages and HTML blocks render in a sandboxed iframe:

- **Visual mode**: double-click text to edit it in place; hover any element to see its hit outline and click to inspect it. The edit banner's **Insert +** opens a compact element palette (heading, paragraph, button, link, image, list, quote, card, divider); the Inspector also shows the element path, element tree, quick actions and a live style panel. Style changes apply automatically (no Apply button); Title/Body/Muted/Accent/Card presets cover common typography and surface styles, with color, background, size, weight, spacing, padding, radius and alignment controls. Changes are patched back to the HTML source with stable `data-hc-id` targets.
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
| Image | Drop an image file from a folder, or paste an image from the clipboard; URL still editable in Inspector |
| Shape | Rectangle, ellipse, diamond, triangle, parallelogram, trapezoid, hexagon, octagon, star, cross, line or frame; fill, stroke, stroke style, radius; optional centered text label |

Hover the left-rail **Shape** tool to open a categorized flyout with 60+ PowerPoint-like shapes (Basic, Lines, Flowchart, Stars & Banners, Callouts, Action Buttons). Select a rectangle or polygon and use **Slice** in the selection toolbar to draw a cutting line; the shape becomes two editable polygon blocks (undo restores it). A **Components** section in the page Inspector adds style-linked components such as the Slider, whose label/value/min/max/accent/track/text can be adjusted in the Inspector. Click a shape in the flyout, then click/drag on the canvas to place it. The same flyout opens from the Shape click/6 shortcut.

Markdown supports blockquotes (`> quote`), GFM, and LaTeX math: inline `$E=mc^2# Hadamard Canvas (hcanvas)

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

## Legacy whiteboard preview

Whiteboard pages are **legacy read-only pages**. hcanvas renders their stored Excalidraw scene through the native block renderer — no Excalidraw bundle or runtime is loaded or served. The Inspector exposes **Convert to native Infinite**; converted pages become normal editable Infinite pages.

## Page thumbnails and deck management

The left page rail renders live thumbnails: HTML pages are previewed in a sandboxed iframe, canvas/infinite pages render their blocks, and legacy whiteboard pages render a native conversion of their scene. Hovering a page reveals **move up / move down / duplicate / delete** actions, so a deck can be reordered and duplicated like a slide sorter.

## Page types and local HTML

Page modes: **HTML** (one editable HTML document per page), **Canvas** (fixed-size block layout), **Infinite** (boundless block surface; blocks live in world coordinates, the viewport paints the grid) and **Whiteboard** (legacy Excalidraw scene; new pages use native Infinite). Canvas/infinite pages use **HTML, text, Markdown, code, image, shape, freehand and arrow blocks**. Select blocks with **drag-marquee**, **Shift+click**, or by clicking a grouped block; **Ctrl/Cmd+G** groups / **Ctrl/Cmd+Shift+G** ungroups, and dragging any selected block moves the whole selection. Frames contain converted Excalidraw children: dragging a frame moves its `frameId` children with it. **Arrow (A)** snaps its endpoints to shapes, text, images and frames when dropped on them; bindings are stored as `startBinding` / `endBinding` and the arrow follows when a bound block is moved or resized. Text blocks can be dragged by their body after selection or by the small **label handle** above the block; double-click edits in place, `Esc` finishes. When blocks overlap, **Alt+click** cycles through the stacked blocks. On Infinite pages, choosing an insert type (HTML/Text/Markdown/Code/Shape) enters **click-to-place** mode: the next canvas click creates the block at that world coordinate. Infinite coordinates are unbounded (negative x/y are valid) and frames never clip or constrain blocks; a frame can be **dissolved** from its Inspector while keeping its children. **Pen (P)**, **Arrow (A)** and **Eraser (E)** draw/erase native vectors directly on Infinite pages; freehand strokes are smoothed into paths, stored in the document JSON as block points, resizable, and use stroke color/width from the Inspector. **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** undo and redo block edits, **Ctrl/Cmd+C/V** copy and paste the selected block. Add Page also provides 19 presets: blank/HTML slides, Cover/Section/Two columns/Quote/Agenda, Canvas PPT cover/content, A4/square canvas, HTML A4, Résumé Classic/Modern/ATS, Event/... (line truncated to 2000 chars)

Import a local HTML file from the desktop with **Import HTML** in the top bar (max 5MB) or:

```bash
hcanvas import ~/Desktop/page.html <doc-id> --title "Imported page" --width 1280 --height 720
```

The HTML is embedded into a new HTML page; editing it inside hcanvas does not modify the original file. Re-import to pick up external changes.

## Direct HTML editing

HTML pages and HTML blocks render in a sandboxed iframe:

- **Visual mode**: double-click text to edit it in place; hover any element to see its hit outline and click to inspect it. The edit banner's **Insert +** opens a compact element palette (heading, paragraph, button, link, image, list, quote, card, divider); the Inspector also shows the element path, element tree, quick actions and a live style panel. Style changes apply automatically (no Apply button); Title/Body/Muted/Accent/Card presets cover common typography and surface styles, with color, background, size, weight, spacing, padding, radius and alignment controls. Changes are patched back to the HTML source with stable `data-hc-id` targets.
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
| Image | Drop an image file from a folder, or paste an image from the clipboard; URL still editable in Inspector |
| Shape | Rectangle, ellipse, diamond, triangle, parallelogram, trapezoid, hexagon, octagon, star, cross, line or frame; fill, stroke, stroke style, radius; optional centered text label |

Hover the left-rail **Shape** tool to open a categorized flyout with 60+ PowerPoint-like shapes (Basic, Lines, Flowchart, Stars & Banners, Callouts, Action Buttons). Select a rectangle or polygon and use **Slice** in the selection toolbar to draw a cutting line; the shape becomes two editable polygon blocks (undo restores it). A **Components** section in the page Inspector adds style-linked components such as the Slider, whose label/value/min/max/accent/track/text can be adjusted in the Inspector. Click a shape in the flyout, then click/drag on the canvas to place it. The same flyout opens from the Shape click/6 shortcut.

 / `\(x^2\)`, display `$...$` / `\[...\]`. Math is rendered through KaTeX to MathML, so it also works in exports and Present. The left-rail **∑ Formula** tool (or key `7`) inserts a dedicated LaTeX block; double-click or **Edit formula** opens a source + live-math editor.

Images are inserted by dragging a file from the filesystem directly onto a Canvas/Infinite page, or by pasting an image from the clipboard. The old sidebar Image insertion button has been removed; selecting an existing image still lets you replace its URL in the Inspector.

Shapes behave like PowerPoint/Figma objects: select one to get eight resize handles (corners and edges), drag the label to move, double-click the shape to edit its centered text, and use the Inspector for text font/size/color. Lines are different: they expose two endpoint handles so either end can be moved freely instead of scaling a bounding box. While dragging, edge/center smart guides snap the block to other blocks and page centers.

Selecting a block directly on the canvas exposes **Opacity**, **Color**, eyedropper and (for images) **Cutout** controls in the floating selection toolbar. Opacity is a 0–100% live style control with reset to 100%. Images have a built-in **Remove image background** cutout: right-click an image or use **Cutout**, adjust background tolerance/soft edges, preview the transparent result on a checkerboard, then apply it as a new PNG data URL. The cutout samples the border color and works best on solid backgrounds; cross-origin images must be uploaded locally first. Right-click any block for a context menu with Edit, Duplicate, Bring forward / Send backward / Bring to front / Send to back, Change color, Stroke color, Pick color from screen, and Delete. Color and layer changes are native edits with undo; the eyedropper uses Chromium's EyeDropper API when available.

The right-side **Layers** tab is a user-layer tree. A page starts with one implicit **Default layer** containing every block; create new layers with **+**, delete non-default layers with **−** (contents are removed after confirmation), double-click a layer name to rename it, and click a layer header to make it the active layer for new blocks. Each layer has eye and lock toggles; hidden layers are omitted from the editor/export/Present, and locked layers cannot be selected or filled. Layers can be reordered by dragging their headers, and objects can be dragged from one layer to another. Within a layer blocks keep their own `z` order; the layer stack and block order both support undo/redo.

Use **Color** for solid fills or pick a **Fill / gradient** preset in the same popover to apply a linear gradient fill to shapes and closed curves. The rail **▣ Fill** tool fills a closed shape/path directly on the canvas; selecting an element and using **Fill / gradient…** in the right-click menu does the same. Gradient paint is rendered natively in SVG, Present and exports.

Pages can use slide (16:9), A4, poster (4:5), square and custom sizes. Present mode shows pages full screen; exports support HTML, PDF and PNG (local Chrome/Edge/Chromium). Page master/layout templates and editable PPTX export are future work.

### Undo / redo

`Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (or `Ctrl/Cmd+Y`) undo and redo block transforms, text edits, HTML element patches, grouping, page reordering and shape changes. Mutations are serialized, inverses are captured before local state is changed, and rapid repeated shortcuts queue their history steps instead of racing.

## Infinite canvas and tools

Choose **Infinite canvas** when adding a page (or use the demo's Infinite canvas page). It has no page bounds: pan with the Hand tool, hold Space, or middle-drag; zoom with the mouse wheel at the pointer or the zoom controls, and place any block anywhere. The dot grid and 8px snapping can be toggled from the tool rail. Exports and Present crop infinite pages to their content bounds.

## Presentation workflow

- **Slide templates**: Cover, Section, Two columns, Quote and Agenda (16:9 HTML pages), plus blank slide/A4/poster.
- **Speaker notes**: edit per-page notes in the Inspector; Present mode has a Notes toggle and PPTX export writes notes into the deck.
- **Present**: full-screen page navigation with notes; click the screen or scroll the wheel to go forward/back, right-click for previous/next/laser/notes/exit, and press L to toggle the laser pointer. Legacy whiteboard pages render through the native conversion.
- **PowerPoint export**: `hcanvas export <doc> --format pptx` produces a 16:9 PPTX with one slide per page and speaker notes.
  - **Canvas pages** with text/shape/image blocks become **editable PowerPoint** text boxes and shapes (no HTML blocks).
  - `format=pptx-editable` additionally maps HTML headings, paragraphs, lists, inline labels and background cards to native PowerPoint text boxes/shapes using real browser layout data; pages with no extractable text fall back to images.
  - HTML, infinite and Excalidraw whiteboard pages are embedded as high-fidelity slide images in the default visual deck.
  - Create a **Canvas · 16:9** page from **+ Page**; add text/shape blocks for editable PowerPoint output.
  - Legacy whiteboard pages are converted to native blocks before image/PPTX rendering; no Excalidraw CLI is used.

## Documents, résumés and posters

Use the generic **Canvas · A4** size for documents and résumés, and **Canvas · 4:5** for posters. These are ordinary canvas pages: add text/shape/image blocks, edit directly, then export. The purpose comes from the size and content, not a separate “Résumé” or “Slide” page type.

- **PDF / PNG / HTML**: vector print via the local browser; A4 and poster page sizes are preserved.
- **Print PDF**: Export → **Print PDF · 3mm bleed** (or `--format pdf --bleed-mm 3 --crop-marks`) adds a 3mm bleed and crop marks in a slug area. Output is RGB PDF; CMYK conversion is not performed.
- **DOCX (ATS)**: export a semantic HTML page or an HTML-page document with `format=docx` (UI: **Word résumé (.docx)**). The exporter walks semantic HTML (headings, paragraphs, lists) and writes a single-column A4 Word document with selectable text, suitable for ATS submission. Use a single-column, plain-text layout for the safest ATS result.
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

## Legacy Excalidraw whiteboard pages

Legacy documents may still contain **Excalidraw whiteboard** pages. New pages cannot be created from this preset, and hcanvas no longer loads or serves the Excalidraw runtime. A legacy page is shown as a read-only native preview (shapes, arrows, freehand, text, images, frames, rotation, opacity, dashed strokes); use **Convert to native Infinite** to make it editable. The raw scene is still stored in the document for migration:

```bash
hcanvas read <doc> --format scene --page <whiteboard-page-id>
hcanvas apply <doc> --ops-file scene-ops.json --base-revision <rev> --actor your-agent
```

```json
[{ "op": "set_whiteboard_scene", "pageId": "page_...", "scene": { "elements": [], "appState": {}, "files": {} } }]
```

`Download .excalidraw` in the page inspector exports the raw scene. HTML/PDF/PNG/PPTX export converts legacy whiteboard pages to native blocks internally before rendering, so those exports no longer depend on Excalidraw.

### Migrating a whiteboard to native Infinite

Click **Convert to native Infinite** in a whiteboard page's Inspector. hcanvas converts Excalidraw elements into native Infinite blocks (freehand strokes, arrows and bindings, text, rectangles, ellipses, diamonds, frames, rotated/opacity/dashed elements and image data URLs) and opens the new page. The source whiteboard is left untouched.

The same conversion is available from the CLI, together with native scene import/export:

```bash
hcanvas migrate-whiteboards <doc> --delete-source
hcanvas convert-whiteboard <doc> --page <whiteboardPageId> --title "Board · Native"
hcanvas import-scene ./board.excalidraw <doc> --title "Imported board"
hcanvas export-scene <doc> --page <infinitePageId> --out ./exports/board.excalidraw
```

Infinite pages also expose **Export → Excalidraw scene** in the top bar. Elements that have no native representation yet (rare embeds) are skipped and reported in the page notes.

For an A4 résumé, build a Canvas page (794×1123) from native text/shape/image blocks, then export PDF/PNG for a fixed-fidelity copy, visual PPTX for a deck containing whole-page images, editable PPTX for native shapes/text, or DOCX for a semantic text version. PPTX exports keep the page aspect ratio (A4 stays A4) instead of forcing 16:9.

### Multi-agent presence

Create a session per agent and keep it alive; hcanvas shows live actors in the **Agent** tab and as avatars in the top bar:

```bash
hcanvas sessions create <doc> --actor your-agent
export HCANVAS_SESSION=session_...
hcanvas context --json          # heartbeats automatically
hcanvas read <doc> --format outline
hcanvas apply <doc> --ops-file ops.json --base-revision <rev>
hcanvas sessions list           # all live/stale sessions
hcanvas sessions heartbeat <id> --doc <doc> --page <page> --block <block>
hcanvas sessions delete <id>
```

The Agent tab is an onboarding and observability surface: status chips for the current document/page and connected sessions, a **Copy agent prompt** action that puts workspace, document, page and revision into a ready-to-paste prompt for any coding agent's chat, live session cards, recent edits, context JSON, and a CLI reference. No vendor-specific agent name is hard-coded. It never starts an agent itself; stale sessions are dimmed after 10 minutes.

Agents with a session on the current page appear as colored cursors inside the canvas. Canvas/infinite cursors anchor to their block; HTML cursors are measured against the rendered page and anchored to the reported `data-hc-id` element; Excalidraw whiteboard cursors are projected from the scene element's position through the whiteboard scroll/zoom state. Click a cursor to **follow** that agent: hcanvas opens its document/page and selects the reported block or HTML element.


## Agent protocol (CLI-first)

The CLI prints JSON by default, uses stdin/stdout, has structured errors and exit codes, and is the primary interface for agents (Claude Code, Kimi Code, DSH, Hadamard, Codex, ...):

```bash
hcanvas context --json                         # active document/page/selection + sessions
hcanvas read <doc> --format outline            # semantic outline
hcanvas read <doc> --format html --page <id>   # exact HTML source
hcanvas apply <doc> --ops-file ops.json --base-revision 7 --actor your-agent
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

The **Projects** button opens a full-screen project manager page backed by the global registry (`~/.hcanvas/projects.json`). From the canvas, the top-bar **Open folder** button opens the current project root, and the Page Inspector's **Open page files** button opens `<workspace>/docs` where document JSON lives. In the project manager, each project is a card with its paths and running state; **📁 Open folder** reveals the project folder in the system file manager (the same button is available in the Workspace dialog). In the desktop app, clicking a project opens it in a **separate native window** (multiple projects can stay open); **New Project…** opens a native folder picker and creates/opens `<project>/.hcanvas`. In browser mode cards open a project whose local service is already running in a new tab. Clicking the current project's card returns to its canvas. Clicking the workspace path in the bottom-left opens a Workspace dialog with the resolved paths, the generated CLI guide and a copy button. Initialization is non-destructive and creates:

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
## Workspace panels

The left **Canvases / Pages** sidebar and the right inspector sidebar can both be resized by dragging their inner edge. Drag a splitter to set the width; double-click it to collapse the panel. The top-bar ▤ / ▥ buttons toggle the left and right sidebars; widths and collapsed state are remembered per browser profile.

The right sidebar has four tabs:

- **Inspector** — page/block properties, layout, styles, grouping, history and export controls.
- **Agent** — onboarding + live sessions + recent edits + context JSON + CLI quick start. It is the observability surface for external CLI agents, not a chat box.
- **Proposals** — review queue for changes proposed by agents; accept or reject before they are applied to the document.
## Plugin blocks

hcanvas can load declarative block plugins without executing a JavaScript bundle. A plugin is a folder with a `manifest.json`:

```text
<project>/.hcanvas/plugins/<plugin-id>/manifest.json
~/.hadamard/hcanvas/plugins/<plugin-id>/manifest.json
```

Project plugins take precedence; duplicate block types are skipped and reported. The minimal manifest is:

```json
{
  "schema": "hcanvas-plugin/1",
  "id": "sticky-notes",
  "name": "Sticky Notes",
  "version": "1.0.0",
  "apiVersion": "hcanvas-plugin/1",
  "blocks": [{
    "type": "sticky-note",
    "label": "Sticky note",
    "hint": "A small paper note",
    "defaultSize": { "w": 280, "h": 200 },
    "defaultData": { "title": "Sticky note", "body": "Write something here." },
    "fields": [
      { "key": "title", "label": "Title", "kind": "text" },
      { "key": "body", "label": "Body", "kind": "textarea" }
    ],
    "render": "<div style=\"padding:18px;background:#fff7d6\">{{title}}<br>{{body}}</div>"
  }]
}
```

`render` is an HTML template; `{{fieldKey}}` placeholders are HTML-escaped. Inline scripts, iframes, event-handler attributes and `javascript:` URLs are rejected. Supported field kinds are `text`, `textarea`, `color`, `select` and `number`. After adding or editing a manifest, open a Canvas/Infinite page Inspector and click **Reload plugins**; plugin blocks appear under **Plugin blocks**.

Open **Manage** next to the Plugin blocks section to enable/disable installed plugins and use **Create block sample** / **Create page sample** to generate a valid manifest under `.hcanvas/plugins/`. **Gallery** installs the bundled samples (Sticky Notes, Starter Pages); **Import JSON** accepts a pasted or selected manifest and installs it into the project. Project plugins can be removed from the manager with **Remove** (user-level plugins are never removed from a project). Toggle state is persisted in `.hcanvas/plugin-settings.json`; disabled plugins are not registered, so their blocks show the safe unknown-block fallback. A working sample lives at [examples/hcanvas-plugins/sticky-notes/manifest.json](https://github.com/DeconBear/hadamard/blob/main/examples/hcanvas-plugins/sticky-notes/manifest.json). Plugin blocks are stored in the document as normal blocks with a `data` payload, so they survive save/reload, undo/redo, copy/paste and Present. Declarative templates are local, trusted UI content; only install manifests you understand.
### Page-template plugins

A plugin can also contribute whole page templates. Add `pagePresets` to the same manifest:

```json
{
  "pagePresets": [{
    "id": "project-brief",
    "label": "Project brief",
    "mode": "canvas",
    "width": 1280,
    "height": 720,
    "background": "#fffdf8",
    "blocks": [
      { "type": "text", "x": 72, "y": 56, "w": 900, "h": 80, "text": "Project brief", "style": { "fontSize": 48, "fontWeight": 700 } },
      { "type": "shape", "x": 72, "y": 250, "w": 340, "h": 220, "shape": "rect", "text": "Goals" }
    ]
  }]
}
```

Modes: `canvas`, `infinite` and `html`. Canvas/infinite templates provide blocks; HTML templates provide an `html` string. Open **Add a page** and use **Plugin page templates**; the new page is created through the normal document operation path and supports undo/redo. A page-template-only manifest does not need a `blocks` array. Sample: [examples/hcanvas-plugins/starter-pages/manifest.json](https://github.com/DeconBear/hadamard/blob/main/examples/hcanvas-plugins/starter-pages/manifest.json).