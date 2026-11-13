# Hadamard Harness: Installation and Development

Hadamard is the experimental harness we are exploring for engineering and research work. It is a TypeScript agent runtime for software delivery, AI-for-Science pipelines, experiment orchestration and the tooling around them: durable sessions, tools, skills, memory, MCP, multi-agent workflows and optional bridges to installed agent CLIs.

> **Package name:** the published npm package is [`actoviq-agent-sdk`](https://www.npmjs.com/package/actoviq-agent-sdk). Product, repository, CLI and config paths use **Hadamard** ([`hadamard-*`](https://github.com/DeconBear/hadamard), `~/.hadamard`, `.hadamard/`).

The standalone canvas product is documented separately: [Hadamard Canvas (hcanvas)](./hadamard-canvas.md).

## Requirements

- Node.js 22.13+ or Node.js 24
- An Anthropic-compatible or OpenAI-compatible model provider

## Install

For SDK usage:

```bash
npm install actoviq-agent-sdk zod
```

This installs the package for `import ... from 'actoviq-agent-sdk'`; its CLIs are then available through `npx` (for example `npx hadamard-tui`).

Install globally to put `hadamard`, `actoviq`, `hadamard-tui` and `hadamard-gui` on your `PATH`:

```bash
npm install -g actoviq-agent-sdk
```

Put provider settings at `~/.hadamard/settings.json`. Any Anthropic-compatible or OpenAI-compatible provider works.

## Quick start

### SDK

```ts
import { createAgentSdk, loadDefaultHadamardSettings } from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings(); // reads ~/.hadamard/settings.json
const sdk = await createAgentSdk();

const result = await sdk.run('What is compare-and-swap?');
console.log(result.text);

await sdk.close();
```

Run the same example from the repository with:

```bash
npm run example:hadamard-quickstart
```

### Terminal UI

```bash
npx hadamard-tui [work-dir]
```

Type a message and press Enter to chat with the agent in a Claude Code-style terminal REPL. `/` opens the slash-command menu (`/team`, `/bridge`, `/plan`, `/mcp`, `/doctor`, ...). Common flags: `--model`, `--permission-mode`, `--resume <session-id>`, `--continue`.

### Desktop GUI

```bash
npx hadamard-gui [work-dir]
```

Opens an Electron chat window backed by a localhost-only server. The visual Agent graph editor is still iterating; prefer saved teams and `/team` for production workflows.

## Surfaces and modules

Hadamard can also be launched as a dedicated module window:

```bash
npx hadamard-harness [work-dir]   # agent-only interface
npx hadamard-canvas [work-dir]    # canvas-only interface in the Hadamard suite
# or: npx hadamard-gui --surface harness|canvas [work-dir]
```

The main app composes every enabled module; configure **Harness** / **Canvas** under **Settings → Personalization → Modules**. See [Surfaces and modules](./surfaces-and-modules.md).

> `hadamard-canvas` is the canvas-only surface of the Hadamard suite. It is not the standalone **Hadamard Canvas** desktop product, whose command is `hcanvas`. See [Hadamard Canvas](./hadamard-canvas.md).

## Development

```bash
npm run typecheck   # TypeScript checks
npm test            # Vitest suite
npm run build       # clean + compile
```

The repository follows the source architecture checks in `tests/source-architecture.spec.ts`. For the full tutorial, start at [the guide](./README.md).

## Documentation

- Docs site: https://deconbear.github.io/hadamard/
- Standalone Hadamard Canvas: [Hadamard Canvas (hcanvas)](./hadamard-canvas.md)
- English tutorial: [docs/en/README.md](./README.md) · Chinese tutorial: [docs/zh/README.md](../zh/README.md)
- External CLI bridge guide: [Bridge runtime](./05-bridge-runtime.md)
- Security policy: [SECURITY.md](https://github.com/DeconBear/hadamard/blob/main/SECURITY.md)
