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

## Files

- `manifest.json` — kernel + sidecar declarations.
- `sidecar/hcanvas_python_kernel.py` — HKP implementation and display helpers.
