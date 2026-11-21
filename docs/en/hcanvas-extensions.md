---
title: Hcanvas Extension Authoring
description: Package, validate and publish an Hcanvas v2 extension.
---

# Hcanvas Extension Authoring

Hcanvas extensions are self-contained packages with a v2 `manifest.json` plus optional local sidecars. The stable distribution path is bundled or curated extensions; npm distribution for official kernels is currently **Preview**.

## Package layout

```text
my-extension/
  package.json          # name, exact version, keywords: ["hcanvas-extension"]
  manifest.json         # schema: "hcanvas-extension/1"
  README.md
  LICENSE
  dist/                 # optional compiled assets
  sidecar/              # optional local processes
```

The npm package version must equal `manifest.version`, and `manifest.engines.hcanvas` must accept the installed Hcanvas 0.1.x release (for example `>=0.1.0`). Packages are unpacked and installed locally; Hcanvas does not run npm lifecycle scripts or a second `npm install`. Registry selection uses `HCANVAS_NPM_REGISTRY`; auth uses `HCANVAS_NPM_TOKEN`/`NPM_TOKEN`; `HTTPS_PROXY`/`HTTP_PROXY` are honored; `HCANVAS_NPM_OFFLINE=1` gives a readable offline error.

## Manifest and permissions

Use a unique extension ID. The `hcanvas.*` and `com.hadamard.*` namespaces are reserved for bundled or official `@hcanvas/*` packages. Declare only the capabilities you need: process/sidecar, network domains, document access, UI contributions, and so on.

Process-backed extensions stay disabled until the user trusts the workspace and grants the extension its capability hash. Changing the extension version or capabilities requires a new grant. A local folder install is intended for development; use an exact npm version for distribution.

## Validate locally

```bash
npm pack --dry-run
hcanvas extension install --folder ./my-extension --project
hcanvas extension list --project
hcanvas extension trust <extension-id>
hcanvas extension enable <extension-id>
hcanvas doctor
```

## Publish (Preview)

Official packages use the `@hcanvas/*` scope and a reviewed release workflow; do not upload unreviewed folders manually. Third-party packages must be self-contained and must not claim a reserved ID. The stable Hcanvas release does not depend on online npm availability: bundled kernels are always available in the installation image.
