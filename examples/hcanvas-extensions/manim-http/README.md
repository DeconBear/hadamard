# Manim HTTP example (Hcanvas extension)

Viewer for `.manim.json` scene files plus a host renderer bridge. The view lets
you edit a scene payload and POST it to a local renderer endpoint; the example
ships an echo renderer server so the flow can be verified without installing
Manim itself.

## Usage

1. Copy the folder into `<workspace>/extensions/manim-http`.
2. Trust the extension (it declares an allowlisted local network endpoint).
3. Start the echo renderer: `node examples/hcanvas-extensions/manim-http/server/echo-renderer.mjs` (listens on `127.0.0.1:8765`).
4. Open a `.manim.json` file or the contributed view and press Render.

Configure/point the endpoint at a real Manim renderer for production use; the
renderer is responsible for its own process isolation and output files.

## Security

The viewer never executes Python. Network access goes through
`hc.network.fetch` and the host allowlist; the declared endpoint is a local
service and the trust dialog calls that out.
