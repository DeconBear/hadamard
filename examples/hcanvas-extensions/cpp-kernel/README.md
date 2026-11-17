# C++ Kernel (Hcanvas extension)

Compile-and-run C++ kernel for canvas **Code cells** and **Hadamard Notebook**
cells. Each cell is compiled with g++/clang++ and executed; compilation and
program output are streamed as text.

## What it does

- Code without an explicit `int main(...)` is wrapped in a main() with
  `<bits/stdc++.h>` (top-level `#include` lines are moved above the wrapper).
- Code with `int main` is compiled as a complete program.
- Compiler errors are reported as kernel errors; runtime output is streamed.
- C++ has no REPL semantics, so **variables do not persist between cells**.
- Interrupt kills the running compiler/program.

## Requirements

- Node.js (sidecar).
- `g++` or `clang++` on PATH.

## Usage

Copy to `<workspace>/extensions/cpp-kernel`, trust it, then use a Code cell /
Notebook cell with the **C++ (g++)** kernel.
