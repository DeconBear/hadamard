# 3D Viewer (Hcanvas extension)

WebGL viewer for Wavefront OBJ meshes with no external dependencies. It parses
`v`/`f` records, computes flat normals, centers and normalizes the mesh, and
renders it with a small lighting shader. Drag rotates, wheel zooms; rendering
animates slowly so the mesh shape is readable.

## Usage

1. Copy the folder into `<workspace>/extensions/three-d-viewer`.
2. Open a `.obj` file (sample: `fixtures/cube.obj`).
3. If WebGL is unavailable the viewer reports it instead of showing a blank tab.

## Files

- `manifest.json` — `.obj` format + viewer.
- `ui/entry.html` — OBJ parser and WebGL renderer.
- `fixtures/cube.obj` — sample cube (36 triangles).
