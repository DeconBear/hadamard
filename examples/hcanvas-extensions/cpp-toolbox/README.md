# C++ Toolbox (Hcanvas extension)

Compile and run C++ code in a dedicated workspace tab through the `cpp-runner`
sidecar. The extension does not bundle a compiler: it uses `g++`, `clang++` or
`cl` from this machine's PATH. If none is found, the view reports a toolchain
error instead of failing silently.

## Capabilities

- `process.sidecars: ["cpp-runner"]` — Hcanvas starts the declared Node sidecar
  only after the workspace trusts the extension.
- No network, no filesystem capability beyond the sidecar's own tempdir.

## Usage

1. Install this folder under `<workspace>/extensions/cpp-toolbox` (Hcanvas data
   directory) or load it through the extension manager.
2. Trust the extension in **Plugins → Extensions** (process capability).
3. Run command palette → **C++: Open toolbox**.
4. Edit code and press **Build & Run**; stdout/stderr/exit code appear live.

## Requirements

- Node.js on PATH (sidecar entry).
- A C++17 compiler on PATH: MinGW g++, clang++, or MSVC cl.
