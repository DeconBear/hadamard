# Hcanvas Changelog

## v0.1.6 - 2026-11-26

### Desktop-only interaction

- Remove the user-visible browser mode: `hcanvas app` is no longer advertised or available, and quick-start/API docs now point to `hcanvas desktop`.
- Keep the local HTTP service internal for the Electron window, agent integrations and E2E tests.
- Remove browser-specific project actions and replace them with desktop-required guidance.
- Move the language selector and data-location control out of the project manager; both now live only in Settings → General.
- Explain project `running` / `closed` badges and localize the project-manager footer.
## v0.1.5 - 2026-11-25

### Settings and runtimes

- Add a unified Settings dialog in Project Hub for interface language, data location, runtime paths, Notebook defaults, update preferences and cache management.
- Configure Python, GNU Octave and C++ compiler paths explicitly; auto-detect from `PATH` (plus the Windows Octave uninstall registry), test each path and report versions.
- Apply configured paths to kernel sessions: Python command override, C++ `CXX`, Octave `OCTAVE_BIN`; `hcanvas doctor` reads the same settings.
- Show actionable errors for missing runtimes and document when settings apply to new kernel sessions.

### Updates and Notebook

- Discover Hcanvas GitHub releases by stable/preview channel, wire electron-updater check/download/install IPC, and add auto-check/auto-download preferences.
- Choose the default kernel for new Notebook pages, configure the `.hnb.md` output-cache budget and clear cached outputs.
- Add an HTML export option to include or omit execution outputs and inlined images.
- Accept kernel completions with **Tab** in Notebook code cells; apply the same completion acceptance to code/files editors.

### Workspace tabs

- The top refresh reloads the active file from disk, preserves the file view and refreshes the file tree.
- Closing the last file tab returns to the canvas; closing the last tab shows an empty workspace while keeping pages available from Pages.
- Preserve sidecar artifact handling on Windows short paths.
## v0.1.4 - 2026-11-21

### Notebook

- Fix variable restoration across close/reopen, including legacy `variables:` frontmatter.
- Protect file saves with content hash/mtime checks; show Reload / Overwrite / Save-copy recovery instead of silently overwriting external edits.
- Keep Markdown YAML frontmatter and raw HTML on rich-text saves; refuse placeholder content as real data.
- Flush the previous Notebook document before switching files.
- Harden execution settlement, output replay, undo identity, and kernel reconnect handling.
- Inline images and current outputs in standalone HTML export; support offline viewing.

### Extensions and kernels

- Add a shared integrity-verified npm tarball installer with exact versions, safe extraction, staging/backup/rollback and provenance.
- Add user-scope install, list and uninstall with a unified Hcanvas data root and legacy migration.
- Enforce `engines.hcanvas` compatibility before install; disable incompatible installed extensions with a readable diagnostic.
- Ship bundled Python, C++ and GNU Octave kernel extensions and expose them in the Gallery.
- Add CLI extension management and `hcanvas doctor`; add GUI npm install, scopes, uninstall and compatibility badges.
- NPM `@hcanvas/*` kernel distribution remains a Preview channel; bundled kernels are the stable path.

### Release and verification

- Centralize the Hcanvas version in `hcanvas.version.json`.
- Add reusable CI verification, clean tarball installation checks, and no-clobber release publishing.
- Add Notebook/extension E2E coverage for conflicts, cross-document flush, offline HTML export and installed-package Notebook execution.
