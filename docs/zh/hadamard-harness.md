# Hadamard Harness：安装与开发

**Hadamard Harness** 是 Hadamard 系列中的工具之一，整个 Hadamard 围绕 LLM Harness 展开。Hadamard Harness 是面向工程和科研任务的探索性 agent harness：一套 TypeScript agent runtime，服务于软件交付、AI for Science（AI4S）流程、实验编排以及围绕这些工作的工具链——持久会话、工具、skills、memory、MCP、多 agent workflow，以及连接已安装 agent CLI 的 bridge。

> **包名说明：** Hadamard harness 发布为 [`actoviq-agent-sdk`](https://www.npmjs.com/package/actoviq-agent-sdk)；独立画布产品单独发布为 [`hadamard-canvas`](https://www.npmjs.com/package/hadamard-canvas)。产品、仓库、CLI 与配置路径统一使用 **Hadamard**（[`hadamard-*`](https://github.com/DeconBear/hadamard)、`~/.hadamard`、`.hadamard/`）。

独立画布产品有单独文档：[Hadamard Canvas（hcanvas）](./hadamard-canvas.md)。

## 环境要求

- Node.js 22.13+ 或 Node.js 24
- 任意 Anthropic 兼容或 OpenAI 兼容的模型提供商

## 安装

SDK 用法：

```bash
npm install actoviq-agent-sdk zod
```

这会安装 `actoviq-agent-sdk`，供 `import ... from 'actoviq-agent-sdk'` 使用；命令行需要通过 `npx` 调用（如 `npx hadamard-tui`）。

如果希望 `hadamard`、`actoviq`、`hadamard-tui`、`hadamard-gui` 直接出现在 `PATH` 上，请全局安装：

```bash
npm install -g actoviq-agent-sdk
```

将提供商配置放在 `~/.hadamard/settings.json`。任意 Anthropic 兼容或 OpenAI 兼容的提供商均可。

## 快速开始

### SDK

```ts
import { createAgentSdk, loadDefaultHadamardSettings } from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings(); // 读取 ~/.hadamard/settings.json
const sdk = await createAgentSdk();

const result = await sdk.run('什么是 CAS？');
console.log(result.text);

await sdk.close();
```

在仓库内运行同样的示例：

```bash
npm run example:hadamard-quickstart
```

### 终端 UI

```bash
npx hadamard-tui [工作目录]
```

输入消息并回车，即可在 Claude Code 风格的终端 REPL 中与 agent 对话。输入 `/` 打开斜杠命令菜单（`/team`、`/bridge`、`/plan`、`/mcp`、`/doctor` 等）。常用参数：`--model`、`--permission-mode`、`--resume <会话ID>`、`--continue`。

### 桌面 GUI

```bash
npx hadamard-gui [工作目录]
```

打开 Electron 聊天窗口（仅绑定 localhost 服务）。可视化 Agent graph 编辑器仍在迭代中；生产工作流请优先使用已保存的 team 与 `/team`。

## 启动界面与模块

Hadamard 也可以按模块单独启动：

```bash
npx hadamard-harness [工作目录]               # 仅 agent 界面
npx hadamard-gui --surface canvas [工作目录]  # Hadamard 套件内的仅画布界面
# 或：npx hadamard-gui --surface harness|canvas [工作目录]
```

独立画布产品使用单独的包：

```bash
npm install -g hadamard-canvas
hcanvas desktop --workspace <目录>
```

主应用会组合所有已启用模块；在 **Settings → Personalization → Modules** 中配置 **Harness** / **Canvas**。详见 [Surface 与模块](./surfaces-and-modules.md)。

> Hadamard 套件内的仅画布界面通过 `hadamard-gui --surface canvas` 启动；它不是独立的 **Hadamard Canvas** 产品。独立产品发布为单独的 `hadamard-canvas` npm 包，提供 `hcanvas` / `hadamard-canvas` 命令。参见 [Hadamard Canvas](./hadamard-canvas.md)。

## 开发

```bash
npm run typecheck   # TypeScript 检查
npm test            # Vitest 测试
npm run build       # 清理 + 编译
```

仓库使用 `tests/source-architecture.spec.ts` 检查源码架构。完整教程从 [教程首页](./README.md) 开始。

## 文档

- 文档站：https://deconbear.github.io/hadamard/
- 独立 Hadamard Canvas：[Hadamard Canvas（hcanvas）](./hadamard-canvas.md)
- 英文教程：[docs/en/README.md](../en/README.md) · 中文教程：[docs/zh/README.md](./README.md)
- External CLI bridge 指南：[Bridge Runtime](./bridge-runtime.md)
- 安全政策：[SECURITY.md](https://github.com/DeconBear/hadamard/blob/main/SECURITY.md)
