# Hadamard Agent SDK

[![CI](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/hadamard/)

[English](./README.md) | [Chinese](./README-zh.md)

**Hadamard** is a TypeScript agent SDK and agent-team platform. One runtime powers conversational agents with tools, skills, sessions, memory, and MCP; model teams that investigate, review, and dispatch in parallel; and a bridge that manages installed agent CLIs (Claude Code, Codex, Cursor, Pi, CodeWhale, Reasonix, Crush) as child processes. The same runtime ships with a terminal UI and a desktop GUI.

Inspired by Claude Code, Codex, Deepagents, and the broader agent ecosystem. Hadamard remains independent with its own public API and documentation.

> **Package name:** the published npm package is [`actoviq-agent-sdk`](https://www.npmjs.com/package/actoviq-agent-sdk). Product, repo, CLI, and config paths use **Hadamard** (`hadamard-*`, `~/.hadamard`, `.hadamard/`).

## Install

Node.js 22.13+ or Node.js 24 is required.

```bash
npm install actoviq-agent-sdk zod
```

Put your provider settings at `~/.hadamard/settings.json` — any Anthropic-compatible or OpenAI-compatible provider works.

## Quick Start

### SDK

```ts
import { createAgentSdk, loadDefaultHadamardSettings } from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings();   // reads ~/.hadamard/settings.json
const sdk = await createAgentSdk();

const result = await sdk.run('What is compare-and-swap?');
console.log(result.text);

await sdk.close();
```

Run the same example from the repository with `npm run example:hadamard-quickstart`.

### Terminal UI (`hadamard-tui`)

```bash
npx hadamard-tui [work-dir]
```

Type a message and press Enter — you are chatting with the agent in a Claude Code-style terminal REPL. `/` opens the slash-command menu (`/team`, `/bridge`, `/plan`, `/mcp`, `/doctor`, …). Common flags: `--model`, `--permission-mode`, `--resume <session-id>`, `--continue`.

### Desktop GUI (`hadamard-gui`)

```bash
npx hadamard-gui [work-dir]
```

Opens an Electron chat window backed by a localhost-only server — send a message to start your first conversation. The visual Agent graph editor is still iterating; prefer saved teams and `/team` for production workflows.

## Documentation

- Docs site: https://deconbear.github.io/hadamard/
- English tutorial: [docs/en/README.md](./docs/en/README.md) · Chinese tutorial: [docs/zh/README.md](./docs/zh/README.md)
- External CLI bridge guide (provider flags, credentials, `HADAMARD_<PROVIDER>_PATH`): [docs/en/05-bridge-runtime.md](./docs/en/05-bridge-runtime.md)
- Examples: [hadamard-quickstart.ts](./examples/hadamard-quickstart.ts), [hadamard-workflow.ts](./examples/hadamard-workflow.ts), [hadamard-agent-helpers.ts](./examples/hadamard-agent-helpers.ts)
- Security policy: [SECURITY.md](./SECURITY.md)

## Development

```bash
npm run typecheck   # TypeScript checks
npm test            # Vitest suite
npm run build       # clean + compile
```

## Contributing

Contributions are welcome. If you spot a bug or a documentation gap, please open an issue or submit a pull request.

Licensed under the [MIT License](./LICENSE).
