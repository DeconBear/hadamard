# Hcanvas notebook examples

## Maxwell–Bloch

[Maxwell–Bloch](.hcanvas/docs/doc_maxwellbloch.json) follows a Gaussian optical pulse through a
two-level medium. It solves the optical Bloch equations, scans the post-pulse
inversion over detuning, and adds a one-dimensional Maxwell propagation map.
Shared variables are read by Python, C++ and Octave cells. The expanded example
contains 11 cells, including 6 executable cells and 10 shared input parameters.
Python publishes `rabi_period` and `pulse_area`; C++ consumes and validates them,
then Octave consumes the C++ result for a final cross-language consistency check.
Pulse center, width and the numerical time step are shared inputs, not hardcoded
per-cell settings. The document also explains the equations, stability condition,
parameter experiments, expected results and model limitations in Chinese.

Requirements:

- the Python kernel extension with NumPy and Matplotlib
- optional: the C++ and GNU Octave kernel extensions for the cross-language cells

Open the **Maxwell–Bloch** document from **Canvases**, then open its native
page from **Pages**. It is stored in `.hcanvas/docs/doc_maxwellbloch.json`, with
no separate `.hnb.md` file required. Outputs and revisions use the native document store.

Other notebooks can still use `.hnb.md` and standard `.ipynb`. Separate initial
and current variables with explicit initialization, Run affected, background execution,
native table/CSV output, kernel completion and optional SymPy cells are available
in the current editor.
