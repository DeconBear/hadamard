# Python Kernel (Hcanvas extension)

A persistent Python kernel implementing the Hcanvas Kernel Protocol (HKP) over
the sidecar transport. Cells share globals inside one kernel session; stdout,
stderr, display MIME bundles, structured tracebacks and matplotlib PNG figures
are supported.

## Requirements

- Python 3.10+ on PATH (or the interpreter used by the sidecar command).
- `matplotlib` only for chart outputs; text/error cells work without it.

## Usage

1. Copy the folder into `<workspace>/extensions/python-kernel`.
2. Trust the extension (process sidecar/kernel capability).
3. Canvas: **Cell: Insert code cell** → Run. Notebook: open a `.hnb.md` file
   with an executable `python exec` fence and press Shift+Enter / Run.

Notebook shared variables are injected by name before each run. Use
`hc_get("name", default)` to read explicitly and `hc_set("name", value)` to
publish a JSON-compatible value to other kernels. The last expression in a cell
is also shown as an execution result, as in a conventional notebook.

The kernel implements `kernel/complete` and `kernel/inspect`, providing real
completion and documentation tooltips. Captured figures are closed after their
PNG is emitted. Formula popovers can also generate optional SymPy code; SymPy
is required only when those generated cells are run.

## Files

- `manifest.json` — kernel + sidecar declarations.
- `sidecar/hcanvas_python_kernel.py` — HKP implementation and display helpers.
