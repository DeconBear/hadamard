# Hcanvas extension SDK

Types, manifest examples and templates for [Hcanvas extensions](../../../docs/en/hadamard-canvas.md#extension-platform-v2). Runtime viewers load the host-served SDK:

```html
<script src="/api/extension-sdk/hc-extension-api.js"></script>
<script>
  const hc = await HcanvasView.acquire();
</script>
```

Do not bundle a second copy of the SDK: it must match the running host.

## Contents

- `hcExtensionTypes.ts` — manifest and viewer API declarations.
- `templates/manifest.json` — minimal iframe file-viewer manifest.
- `templates/viewer.html` — sandboxed viewer entry that reads the opened file.
- `templates/sidecar-service.mjs` — JSON-RPC stdio service skeleton.

## Validate before installing

```bash
npm run build
npm run hcanvas:extension:validate -- path/to/extension/manifest.json
```

The command uses the same `hcanvas-extension/1` schema as the app and prints
stable `path: message` diagnostics. Warnings do not fail validation; errors do.

## Install

Copy the extension folder to `<workspace>/extensions/<id>/` (for a project
workspace: `.hcanvas/extensions/<id>/`) or to
`~/.hadamard/hcanvas/extensions/<id>/`. Declare process capabilities only when
needed; the extension manager asks for trust before starting sidecars.
