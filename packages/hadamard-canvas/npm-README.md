# Hadamard Canvas

AI-native visual canvas and document workspace. Build presentations, documents, diagrams, and Markdown pages, then let AI agents read and modify them through a JSON-first CLI.

## Install

```bash
npm install -g hadamard-canvas
```

## Quick Start

```bash
# Start the app (opens browser UI)
hcanvas app --workspace ~/my-canvas

# Run as a headless API server
hcanvas serve --workspace ~/my-canvas --port 4319

# Launch as a desktop window (requires Electron)
hcanvas desktop --workspace ~/my-canvas
```

## Page Types

| Type | Description |
|------|-------------|
| **HTML** | Full HTML documents with rich text editing and CSS control |
| **Canvas** | Fixed-size slides mixing text, shapes, images, code blocks |
| **Infinite** | Boundless canvas for diagrams, mind maps, workflows |
| **Markdown** | A4 documents with live rich-text editing, LaTeX math, tables |

## CLI for AI Agents

```bash
# Read the current document outline
hcanvas read --format outline

# Apply changes
hcanvas apply --ops-file changes.json --base-revision 5 --actor my-agent

# Export as image (for visual verification)
hcanvas export --format png --page page_001 --out preview.png

# Export as PDF, PPTX, DOCX, HTML
hcanvas export --format pptx --out deck.pptx
```

No MCP or browser automation required. Just HTTP + JSON.

## Key Features

- **Direct editing** - click text to edit, right-click for source
- **Auto-save** - changes save automatically with revision history
- **LaTeX math** - inline and display formulas with live preview
- **Presentation mode** - present Markdown, HTML, and canvas pages
- **Export** - PNG, PDF, PPTX (visual + editable), DOCX, HTML
- **Plugin system** - declarative HTML templates, no JS execution
- **Multi-agent** - session-based presence and conflict resolution
- **Revision history** - 120 snapshots per document, restore anytime
- **Bundled fonts** - Inter, Source Serif 4, JetBrains Mono

## Desktop App

```bash
npm install -g hadamard-canvas electron
hcanvas desktop --workspace ~/my-canvas
```

## Data Location

Default workspace: `~/.hcanvas/`

Change this from the Projects page or via `--workspace <dir>`.

## Documentation

- [Full Guide (English)](https://github.com/DeconBear/hadamard/blob/main/docs/en/hadamard-canvas.md)
- [Full Guide (Chinese)](https://github.com/DeconBear/hadamard/blob/main/docs/zh/hadamard-canvas.md)
- [Agent CLI Reference](https://github.com/DeconBear/hadamard/blob/main/docs/en/hadamard-canvas.md#agent-protocol-cli-first)

## License

MIT
