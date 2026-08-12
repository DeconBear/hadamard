# ADR-011: Project Design source and Document workspace

- Status: Accepted
- Date: 2026-08-12
- Scope: Hadamard SDK GUI/TUI, Design import/export, RULES, and Project Manager

## Decision

1. Human-facing Design files live only under `<primary-workspace>/.hadamard/design/`. The two independent editable entries are `design.md` and `design.html`; neither additional work paths nor a home-directory mirror are Design sources.
2. Project Document has four top-level choices: DESIGN, PLAN, MEMORY, and RULES. The command bar is the only Document toolbar; there is no Document sidebar or inspector.
3. Markdown uses the main rich editor and is persisted as Markdown. HTML opens in the shared Files source editor and is refreshed explicitly in a sandboxed preview.
4. Built-in templates are file bundles that provide both entries. Applying a template or importing a package previews added, overwritten, unchanged, and preserved files before a revision-checked confirmation.
5. Package export is the lossless, re-importable `.hadamard/design` directory bundle. HTML and PDF remain human-readable export artifacts.
6. RULES catalogs nested `AGENTS.md` files from every registered work path. Runtime resolution and the UI effective preview use the same root-to-nearest directory scope. Custom prompt and Project rules are edited only in RULES.
7. Project and Conversation share Review, Git, Browser, Files, and the bottom Terminal. Each surface remembers panel width, terminal height, open tool, collapsed state, and terminal visibility independently.
8. `PROGRESS.md`, Design Share, Design customization/configuration UI, mirror switches, migration controls, and compatibility endpoints are removed without a fallback path.

## Security boundaries

- HTML preview uses a sandboxed iframe and a restrictive CSP, strips scripts and inline event handlers, and serves only assets resolved within `.hadamard/design`.
- Bundles reject traversal, symlinks, duplicate paths, undeclared files, checksum mismatches, excessive entries, oversized files, and oversized expanded payloads.
- Template preview never writes to the workspace. Apply and import fail if the workspace changed since preview.

## Verification

Vitest covers canonical paths, atomic revision writes, template application, directory bundle round-trips, unsafe archives and symlinks, runtime RULES scope, and GUI/TUI command parity. Playwright covers the Document command bar, both Design modes, rich editing, template preview/apply, RULES, shared tools, resize persistence, and narrow layouts.
