# Canvas module (optional)

Hadamard can load optional product **modules**. A module decides whether a capability exists at all; when it is not loaded, its UI surface, agent tools and session context are not registered.

Canvas is the first module and ships **disabled by default**. The editing surface is **[Excalidraw](https://github.com/excalidraw/excalidraw) (MIT)**, bundled locally into the desktop GUI.

## Enable / disable

1. Open the desktop GUI.
2. Go to **Settings → Personalization → Modules**.
3. Toggle **Canvas**. Hadamard persists `modules.canvas.enabled` in `~/.hadamard/settings.json` and reloads the runtime.
4. Open a project and use the **Canvas** tab. Disabling the module removes the tab, `/api/canvas/*` routes and canvas agent tools immediately.

Headless overrides:

```bash
HADAMARD_ENABLE_MODULES=canvas   # force on
HADAMARD_DISABLE_MODULES=canvas  # force off
```

## Launch it

Standalone canvas window (forces the canvas module for this process):

```bash
npx hadamard-canvas [work-dir]
# or: npx hadamard-gui --surface canvas [work-dir]
```

## What you get

| Contribution | When loaded | When unloaded |
|---|---|---|
| Project detail **Canvas** tab with the Excalidraw editor | visible | not rendered |
| `/api/canvas/*` HTTP routes | 200 | 404 |
| Canvas agent tools | registered for new runs | absent from the catalog |
| Compact canvas context in agent sessions | injected as a session prompt part | not injected |

### Editing with Excalidraw

Everything you expect from Excalidraw is available: rectangles, diamonds, ellipses, arrows, lines, freedraw, text, images and frames; hand-drawn (sloppiness) styling; stroke/background/fill/stroke-width/stroke-style/edges/opacity/font/arrowhead controls; layers, zoom, undo/redo, export and keyboard shortcuts. The Hadamard chrome adds:

- **Canvases list** for the project (create blank canvases or an AI-model template).
- **Autosave**: the scene is saved through `/api/canvas/scene` after you stop drawing (revision-checked; conflicts trigger a reload instead of overwriting).
- **Agent review** panel: agent changes never edit the canvas directly. They arrive as proposals with an accept/reject card; accepting applies the typed operations to the scene.

## AI-model architecture pack

The optional pack turns a canvas into a tensor-flow graph and validates it:

- Node kinds `ai.input`, `ai.embedding`, `ai.layer`, `ai.tensor`, `ai.output`, `ai.loss` and `ai.flow` edges.
- Deterministic **shape/dtype propagation** with checks: `ai.shape-mismatch`, `ai.residual-mismatch`, `ai.cycle`, `ai.missing-input`, `ai.multiple-inputs`, `ai.unknown-op`, `ai.missing-param`.
- **AI template** in the canvas toolbar creates the transformer-block canvas; it is converted into Excalidraw elements while semantic kind/data are preserved.
- Exports: Mermaid, PyTorch-like skeleton, JSON Canvas 1.0, Markdown, SVG.

## Agent tools

| Tool | Purpose |
|---|---|
| `CanvasList` | list canvases (id, revision, item counts, pending proposals) |
| `CanvasRead` | read the document projection: shapes, styles, text, positions, edges and checks |
| `CanvasCreate` | create a blank canvas or the AI-model transformer template |
| `CanvasImport` | import JSON Canvas 1.0 or Mermaid as a new canvas |
| `CanvasApplyOps` | typed ops with `baseRevision` CAS; the scene is regenerated from the projection |
| `CanvasPropose` | submit agent changes for human review |
| `CanvasValidate` | run pack validators (AI shape propagation) |
| `CanvasExport` | Mermaid, PyTorch, JSON Canvas, Markdown, SVG |
| `CanvasRender` | deterministic SVG projection for structural inspection |

Agent edits need the revision returned by `CanvasRead`; stale revisions fail without changing the document. Accepted proposals become a new revision and are reflected in Excalidraw after the review reload.

## Storage and build

```
<project>/.hadamard/canvas/<docId>.canvas.json     # agent-readable document projection (+ proposals, checks)
<project>/.hadamard/canvas/<docId>.scene.json      # Excalidraw scene (source for the editor)
<project>/.hadamard/canvas/<docId>.log.jsonl       # append-only operation log
<project>/.hadamard/canvas/assets/<docId>/         # assets
```

The Excalidraw editor is **not loaded from a CDN**. Build the local bundle once:

```bash
npm run build:gui-canvas     # esbuild bundle + fonts/locales into dist/gui-canvas
npm run build                # regular build also runs the canvas bundle step
```

The GUI serves the bundle from `/gui-canvas/` (same origin, offline). If the asset is missing the Canvas tab shows an actionable error.

## Security

- Module gating: routes 404 and tools are unregistered while disabled.
- Project-scoped paths; document ≤ 2 MiB, scene/scene asset limits enforced server-side; revision CAS + per-document write serialization.
- The editor runs locally; no CDN, no remote fonts, no cookies; the Excalidraw bundle is served from Hadamard's own origin.
- Proposals are the only path from agent intent to a committed scene.

## Limitations

- First surface is the desktop GUI; TUI is read-only for canvas content and the DSH project plugin does not register canvas tools yet.
- Proposals are reviewed in the Hadamard side panel, not as in-canvas ghost shapes.
- No real-time multi-user collaboration, cloud libraries, or component system yet.
- Additional domain packs (algorithm flow, brainstorm, art, circuit/mechanical drafts) are follow-ups.

## License

Excalidraw is MIT-licensed. See [THIRD_PARTY_NOTICES.md](https://github.com/DeconBear/hadamard/blob/main/THIRD_PARTY_NOTICES.md) for the attribution and license text.