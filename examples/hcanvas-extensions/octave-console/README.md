# GNU Octave Console (Hcanvas extension)

Runs Octave snippets in a workspace tab through the `octave-runner` sidecar.
The extension does not bundle Octave: install GNU Octave and put `octave` on
PATH (or set `HCANVAS_OCTAVE_BIN` in the sidecar environment for a custom path).

## Usage

1. Install this folder under `<workspace>/extensions/octave-console`.
2. Trust the extension (process capability) in the extension manager.
3. Command palette → **Octave: Open console**.
4. Edit the snippet and press **Run snippet**. stdout/stderr and PNG/SVG files
   created by the snippet are shown inline.

## Requirements

- Node.js on PATH (sidecar entry).
- GNU Octave on PATH (no GUI needed).
