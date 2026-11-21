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
- Figures are captured when their handles are new in the execution and closed
  after their PNG is emitted. Re-plotting into an existing figure does not
  re-emit that figure; call `figure`/create a new figure to get a new image.
- Basic `kernel/complete` suggestions cover language keywords, shared variables
  and identifiers in the current source.
- Interrupt/restart resets Octave state.
- Notebook current variables are injected before each run and restored after a
  restart. Apply initial values with **Initialize** or **Run all**; other run
  commands do not auto-initialize. Use `hc_get("name", default)` and
  `hc_set("name", value)` for JSON-compatible exchange with Python and C++ cells.
  Publishing a current value does not modify its initial value.
- Requires GNU Octave (no GUI needed) and Node.js for the sidecar.
