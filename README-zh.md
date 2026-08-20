# Hadamard：让 Agent 像工程团队一样协作

[![CI](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/DeconBear/hadamard/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)
[![Docs](https://img.shields.io/badge/docs-github%20pages-0f766e)](https://deconbear.github.io/hadamard/)

[English](./README.md) | [中文](./README-zh.md)

**Hadamard** 是一个 TypeScript agent SDK 与 agent-team 平台。同一套 runtime 驱动：带工具、skills、会话、记忆与 MCP 的对话式 agent；并行调查、评审与分派的 model team；以及把已安装的 agent CLI（Claude Code、Codex、Cursor、Pi、CodeWhale、Reasonix、Crush）作为子进程管理的 bridge。这套 runtime 同时提供终端 UI 和桌面 GUI。

受 Claude Code、Codex、Deepagents 等项目启发。Hadamard 保持独立，拥有自己的公开 API 与文档。

> **包名说明：** npm 发布名为 [`actoviq-agent-sdk`](https://www.npmjs.com/package/actoviq-agent-sdk)。产品、仓库、CLI 与配置路径统一为 **Hadamard**（`hadamard-*`、`~/.hadamard`、`.hadamard/`）。

## 安装

要求 Node.js 22.13+ 或 Node.js 24。

```bash
npm install actoviq-agent-sdk zod
```

将提供商配置放在 `~/.hadamard/settings.json` —— 任意 Anthropic 兼容或 OpenAI 兼容的提供商均可。

## 快速开始

### SDK

```ts
import { createAgentSdk, loadDefaultHadamardSettings } from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings();   // 读取 ~/.hadamard/settings.json
const sdk = await createAgentSdk();

const result = await sdk.run('什么是 CAS？');
console.log(result.text);

await sdk.close();
```

在仓库内可用 `npm run example:hadamard-quickstart` 运行同样的示例。

### 终端 UI（`hadamard-tui`）

```bash
npx hadamard-tui [工作目录]
```

输入消息并回车，即可在 Claude Code 风格的终端 REPL 中与 agent 对话。输入 `/` 打开斜杠命令菜单（`/team`、`/bridge`、`/plan`、`/mcp`、`/doctor`……）。常用参数：`--model`、`--permission-mode`、`--resume <会话ID>`、`--continue`。

### 桌面 GUI（`hadamard-gui`）

```bash
npx hadamard-gui [工作目录]
```

打开 Electron 聊天窗口（仅绑定 localhost 服务）—— 发送一条消息即可开始第一次对话。可视化 Agent graph 编辑器仍在迭代中；生产工作流请优先使用已保存的 team 与 `/team`。

## 文档

- 文档站：https://deconbear.github.io/hadamard/
- 英文教程：[docs/en/README.md](./docs/en/README.md) · 中文教程：[docs/zh/README.md](./docs/zh/README.md)
- External CLI bridge 指南（provider 参数、凭证、`HADAMARD_<PROVIDER>_PATH`）：[docs/en/05-bridge-runtime.md](./docs/en/05-bridge-runtime.md)
- 示例：[hadamard-quickstart.ts](./examples/hadamard-quickstart.ts)、[hadamard-workflow.ts](./examples/hadamard-workflow.ts)、[hadamard-agent-helpers.ts](./examples/hadamard-agent-helpers.ts)
- 安全政策：[SECURITY.md](./SECURITY.md)

## 开发

```bash
npm run typecheck   # TypeScript 检查
npm test            # Vitest 测试
npm run build       # 清理 + 编译
```

## 参与贡献

欢迎贡献。发现问题或文档缺失，请提交 Issue 或 Pull Request。

基于 [MIT License](./LICENSE) 许可。
