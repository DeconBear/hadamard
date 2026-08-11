# ADR-014：Skill + MCP 插件包兼容边界

- 状态：Accepted
- 日期：2026-08-11
- 决策范围：Hadamard plugins、Qwen-MM-Plugins 兼容

## 上下文

Hadamard Plugin v1 要求 `hadamard-plugin.json`、JavaScript `entry` 和 capabilities，并在信任后加载 entry。Qwen-MM core 使用 Codex 风格 `.codex-plugin/plugin.json` 声明 skills 与 MCP servers；伪造 JS entry 会扩大供应链和 in-process 执行风险。

## 决定

1. 保留 Plugin v1，并新增独立的 `skill-mcp-bundle` manifest variant。
2. Bundle 只声明 package-local skills 路径和 MCP 配置路径，不执行 JavaScript entry。
3. 所有相对路径必须留在包内；拒绝绝对路径、`..`、符号链接逃逸和隐藏替换。
4. Skills 进入现有 skill discovery；MCP 配置进入现有 connection manager，启动仍需 trust/permission。
5. Trust record 包含来源、版本、上游 commit、启动命令、环境变量名、网络/文件 capability 和内容完整性。
6. 正式 recipe pin 到 tag/commit，默认禁用；不长期跟随 GitHub `main`。
7. 禁用/卸载停止 MCP server 并移除 tool catalog，但历史 tool result 保持可读。
8. 移动端无本地 runtime 时不伪装支持，可显式调用配对电脑侧插件且不复制电脑 API key。

## 拒绝的方案

- 为 Qwen bundle 自动生成 JS entry：拒绝，不必要地引入 in-process code execution。
- 未信任即运行 `uvx`：拒绝，安装与网络副作用必须可见。
- 只按包名信任所有未来版本：拒绝，版本与 capability 变化必须重新评估。

## 兼容影响

现有 `parsePluginPackageManifest` 和 v1 package store 继续读取旧清单。新 resolver 以显式 discriminant 区分两种包，不改变旧安装目录和 trust 记录语义。

## 测试证据

- `tests/plugin-manifest.spec.ts`：v1 fixture 持续可读。
- Phase 5 增加 bundle discovery、trust、start/call、disable/uninstall、路径逃逸和 package dry-run 测试。

## 回滚方式

可禁用 bundle resolver 而不影响 Plugin v1。已安装 bundle 保留 metadata 供审计，但不得在不受支持状态继续启动 MCP server。
