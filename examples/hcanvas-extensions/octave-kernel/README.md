# GNU Octave Kernel (Hcanvas extension)

A persistent GNU Octave kernel implementing the Hcanvas Kernel Protocol (HKP)
for canvas **Code cells** and **Hadamard Notebook** cells.

## What it does

- Keeps one interactive Octave process alive so variables persist across cells.
- Streams stdout/stderr into the cell output.
- Captures **newly created Octave figures** as PNG display data automatically
  (no explicit `print` required).
- Interrupt kills the Octave process and starts a fresh session (state is lost
  after an interrupt).
- Resolves Octave from `PATH`, or on Windows from the installer registry
  `InstallLocation`; a custom binary can be set via `OCTAVE_BIN` in the
  sidecar env.

## Usage

1. Install/copy this folder to `<workspace>/extensions/octave-kernel`.
2. Trust the extension (process sidecar).
3. Canvas: **Cell: Insert code cell** → choose **GNU Octave** → Run.
4. Notebook: open/create a `.hnb.md` file and choose **GNU Octave** in the
   kernel selector (or set `kernel: octave` in the frontmatter), then run cells.

## Notes

- User code is executed from a temp `.m` script via `source`, so function
  definitions are supported.
- Figures are captured when their handles are new in the execution. Re-plotting
  into an existing figure does not re-emit that figure; call `figure`/create a
  new figure to get a new image.
- Interrupt/restart resets Octave state.
- Requires GNU Octave (no GUI needed) and Node.js for the sidecar.
