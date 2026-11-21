# Hcanvas Changelog

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
