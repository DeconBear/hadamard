# GeoJSON Map Viewer (Hcanvas extension)

Offline map viewer for `.geojson` files. Renders polygons, lines and points on
a Canvas 2D equirectangular projection with pan, wheel zoom, a graticule and
feature selection (point-in-polygon plus line/point hit tests). The example in
`fixtures/sample.geojson` is a small synthetic dataset.

## Usage

1. Copy the folder into `<workspace>/extensions/map-viewer`.
2. Open a `.geojson` file from Files.
3. Drag to pan, wheel to zoom, click a feature for its properties.

No network/tile capability is needed: the viewer is fully offline. The legacy
`examples/hcanvas-plugins/leaflet-map` block plugin remains available for an
OSM tile-based map block.

## Files

- `manifest.json` — `.geojson` format + viewer.
- `ui/entry.html` — Canvas map renderer.
- `fixtures/sample.geojson` — sample features.
