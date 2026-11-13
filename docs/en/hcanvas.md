---
title: Hcanvas Quickstart
description: Go from download to a local-first, agent-ready canvas in minutes.
---

<div class="hc-hero">
  <div class="hc-kicker">Hadamard Canvas · v0.1.2</div>
  <h1>Make the page<br /><span>the workspace.</span></h1>
  <p class="hc-sub">Hcanvas is a local-first canvas for serious visual work. Build pages, slides and diagrams, then let people and agents edit the same document through one clean, JSON-first interface.</p>
  <div class="hc-actions">
    <a class="hc-btn hc-btn-primary" href="#install">Install Hcanvas</a>
    <a class="hc-btn" href="https://github.com/DeconBear/hadamard/releases">Download for desktop</a>
  </div>
  <div class="hc-proof">Local-first · Human + agent · HTML + Canvas + Infinite</div>
</div>

<div class="hc-shot">
  <img src="../assets/screenshots/hcanvas-canvas.png" alt="Hcanvas workspace showing the page inspector, canvas blocks and agent plugin panels" />
  <p>The same document in Hcanvas: canvas pages, editable HTML, Markdown, code blocks and an inspector for people and agents.</p>
</div>

## What you can build

<div class="hc-grid">
  <div class="hc-card"><h3>HTML pages</h3><p>Write and edit real HTML, preview it in a sandbox, or open the source editor when you want full control.</p></div>
  <div class="hc-card"><h3>Canvas pages</h3><p>Mix text, Markdown, code, images, shapes, formulas, curves and connectors on a fixed slide surface.</p></div>
  <div class="hc-card"><h3>Infinite diagrams</h3><p>Pan and zoom without page bounds — useful for research maps, system diagrams and early thinking.</p></div>
  <div class="hc-card"><h3>Documents that ship</h3><p>Export HTML, PDF, PNG, visual or editable PPTX, and DOCX. Present full-screen with speaker notes.</p></div>
</div>

## Install

### Desktop app

Download the installer for your platform from [GitHub Releases](https://github.com/DeconBear/hadamard/releases):

- **Windows:** `Hadamard-Canvas-Setup-*.exe` or the portable `.exe`
- **macOS:** `Hadamard-Canvas-*.dmg` or `.zip` for x64 and arm64
- **Linux:** `Hadamard-Canvas-*.AppImage` or `Hadamard-Canvas-*.deb` for x64

The desktop installers include the Electron app only. Install the CLI separately when you want terminal or agent commands.

### CLI and agent commands

~~~bash
npm install -g hadamard-canvas
hcanvas desktop --workspace ~/.hcanvas
~~~

Node.js 22.13+ or Node.js 24 is required. The npm package also provides browser and headless modes:

~~~bash
hcanvas app --workspace ~/.hcanvas      # local server + browser UI
hcanvas serve --workspace ~/.hcanvas --port 4319
~~~

## First 10 minutes

<div class="hc-step"><div class="hc-step-num">1</div><div><strong>Choose a workspace</strong><p>Start with <code>~/.hcanvas</code>, or pass <code>--project &lt;dir&gt;</code> to keep a deck, report or research project self-contained.</p></div></div>
<div class="hc-step"><div class="hc-step-num">2</div><div><strong>Make a page</strong><p>Use an HTML page for a landing page, a Canvas page for a slide, an Infinite page for a diagram, or a Markdown page for a paper.</p></div></div>
<div class="hc-step"><div class="hc-step-num">3</div><div><strong>Add real content</strong><p>Double-click text to edit. Add Markdown, code, images, shapes, formulas or a component from the block library.</p></div></div>
<div class="hc-step"><div class="hc-step-num">4</div><div><strong>Bring in an agent</strong><p>Agents read the document through <code>hcanvas</code> and write patches with stable revisions. Human edits and agent edits use the same model.</p></div></div>
<div class="hc-step"><div class="hc-step-num">5</div><div><strong>Present or export</strong><p>Present the deck, restore a revision from History, or export a PDF, PNG, PPTX or DOCX for delivery.</p></div></div>

## Let an agent work on it

Give your agent the document context and a small, reviewable patch. Useful commands:

~~~bash
# Read the current document outline
hcanvas read --format outline

# Create a new canvas document
hcanvas docs create --title "Research sync" --preset canvas

# Apply a reviewed patch against a known revision
hcanvas apply --ops-file changes.json --base-revision 5 --actor my-agent
~~~

<div class="hc-note"><strong>Installing with an agent?</strong> Point it at the <a href="https://github.com/DeconBear/hadamard#quick-start-with-ai-agents">Quick start with AI Agents</a> section in the README. The desktop and CLI are separate installs: the desktop installer provides the GUI, while <code>npm install -g hadamard-canvas</code> provides the CLI and launcher.</div>

## Keep exploring

- [Hcanvas reference](./hadamard-canvas.md) — page types, blocks, CLI protocol, plugins and storage
- [Hcanvas on npm](https://www.npmjs.com/package/hadamard-canvas)
- [Hadamard Harness](./hadamard-harness.md) — the agent runtime for engineering and research
