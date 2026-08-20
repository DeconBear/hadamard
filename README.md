# Hadamard: Agents as an Engineering Team

[![CI](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/hadamard/)

[English](./README.md) | [Chinese](./README-zh.md)

LLM harnesses are powerful but hard to manage on real engineering and research work — shipping software, running AI-for-Science (AI4S) pipelines, training neural networks and steering experiments. Contexts overflow, tool calls sprawl, runs drift from the plan, and a single agent loop never gets a second opinion.

**Hadamard** exists to make agent engineering and research controllable. Multiple agents on different providers talk to each other — investigating, reviewing, and dispatching in parallel — so problems get considered more thoroughly. One TypeScript runtime provides tools, skills, durable sessions, memory, and MCP, plus a bridge that manages installed agent CLIs (Claude Code, Codex, Cursor, Pi, CodeWhale, Reasonix, Crush) as child processes; the same runtime ships with a terminal UI and a desktop GUI.

Inspired by Claude Code, Codex, Deepagents, and the broader agent ecosystem. Hadamard remains independent with its own public API and documentation.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeconBear/hadamard/main/docs/assets/screenshots/gui-home.png" alt="Hadamard desktop GUI — projects overview" width="49%">
  <img src="https://raw.githubusercontent.com/DeconBear/hadamard/main/docs/assets/screenshots/gui-chat.png" alt="Hadamard desktop GUI — chat with a model" width="49%">
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/DeconBear/hadamard/main/docs/assets/screenshots/tui-home.png" alt="Hadamard TUI — terminal startup screen" width="90%">
</p>
<p align="center"><em>The desktop GUI (top: projects overview and a chat session) and the terminal UI (bottom).</em></p>

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

## Demo

A 50-second walkthrough of the desktop GUI: open the Chats view, start a new conversation, ask a question, and watch the streamed reply with the thinking indicator and code rendering.

<p align="center">
  <video src="https://raw.githubusercontent.com/DeconBear/hadamard/main/docs/assets/screenshots/gui-demo.mp4" width="720" controls muted>
    Your browser does not support embedded video.
  </video>
</p>

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
