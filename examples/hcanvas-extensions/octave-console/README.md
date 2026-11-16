# GNU Octave Console (Hcanvas extension)

Runs Octave snippets in a workspace tab through the `octave-runner` sidecar.
The extension does not bundle Octave: install GNU Octave. The runner resolves
`octave` from PATH first and, on Windows, falls back to the installer's registry
`InstallLocation` (`\\mingw64\\bin\\octave.exe`). For a custom location, set
`OCTAVE_BIN` in the sidecar's manifest `env` block or put the binary on PATH.

## Usage

1. Install this folder under `<workspace>/extensions/octave-console`.
2. Trust the extension (process capability) in the extension manager.
3. Command palette → **Octave: Open console**.
4. Edit the snippet and press **Run snippet**. stdout/stderr and PNG/SVG files
   created by the snippet are shown inline.

## Requirements

- Node.js on PATH (sidecar entry).
- GNU Octave installed (PATH or the Windows installer registry entry; no GUI needed).