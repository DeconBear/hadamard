# Launch surfaces and modules

Hadamard's GUI is not one monolith: the same local runtime can be composed into different **launch surfaces**, and optional **modules** decide which capabilities exist at all.

## Three ways to launch

| Command | Surface | What you get |
|---|---|---|
| `npx hadamard-gui [work-dir]` | **full** | The main Hadamard app: project overview, conversations, project workbench, plus every enabled module. |
| `npx hadamard-harness [work-dir]` | **harness** | Agent-only window: conversation, transcript, composer, model/permission controls. No project overview, no workbench, no canvas. |
| `npx hadamard-canvas [work-dir]` | **canvas** | Canvas-only window: the Excalidraw workspace, canvas list, agent review and validation panels. No app sidebar, no chat. |

All three start the same localhost-only backend and read the same projects, sessions, settings and canvas documents. Only the app shell changes.

Equivalent flag/env forms:

```bash
npx hadamard-gui --surface harness [work-dir]
npx hadamard-gui --surface canvas [work-dir]
HADAMARD_GUI_SURFACE=canvas npx hadamard-gui [work-dir]
```

## Modules

Modules are the composable capabilities behind the surfaces.

| Module | Default | Owns |
|---|---|---|
| `harness` | **on** | The agent chat surface: conversation, composer, model configuration, agent monitor. |
| `canvas` | **off** | The Excalidraw design canvas, `/api/canvas/*`, canvas agent tools and canvas session context. |

### Personalize the full app

Open **Settings → Personalization → Modules** and toggle **Harness** / **Canvas**. The choice is persisted in `~/.hadamard/settings.json` (`modules.<id>.enabled`) and the runtime reloads immediately:

- module off → its UI, tools, context part and HTTP routes are not registered;
- module on → it appears in the full app (e.g. the **Canvas** project tab);
- the full app composes **whatever is enabled**.

### Standalone surfaces force their module set

Standalone modes ignore the persisted toggles for that process so the window is deterministic:

- `--surface harness` → `harness` on, `canvas` off (even if canvas is enabled in settings);
- `--surface canvas` → `canvas` on, `harness` off (even if canvas is disabled in settings).

Nothing is persisted by a standalone launch; switching back to `hadamard-gui` uses your saved module preferences.

## Examples

```bash
# Agent-only, like a standard coding-agent interface
hadamard-harness ~/work/my-project

# Design-only, full-screen Excalidraw with the agent review panel
hadamard-canvas ~/work/my-project

# Main app: chat + canvas tab because both modules are enabled
hadamard-gui ~/work/my-project
```

## Same data, different shells

- Sessions, projects, memory, issues and canvases live in the shared Hadamard data root / project `.hadamard` directory.
- A canvas created in the canvas-only surface is immediately visible in the full app (and vice versa).
- Agent tools are only registered where the owning module is active: the canvas-only window has no chat loop, and the harness-only window has no canvas tools.
