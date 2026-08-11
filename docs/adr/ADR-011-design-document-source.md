# ADR-011：Project Design 的规范源与迁移边界

- 状态：Accepted
- 日期：2026-08-11
- 决策范围：Project Manager、GUI/TUI、Design 导入导出

## 上下文

Project 首页把 Design 与 Progress 当作不同概念，但底层只维护 `PROGRESS.md`。同时引入可定制 HTML 会形成 Markdown、HTML 两份可编辑源，并扩大脚本、XSS、同步与 Agent 编辑风险。

## 决定

1. 每个项目只有一份面向人的规范文档 `DESIGN.md`；`MEMORY.md` 和 `AGENTS.md` 分别承担 Agent 长期上下文与行为规范。
2. Markdown 是唯一可编辑规范源。HTML/PDF 是受限 renderer 的输出，不反向成为 source of truth。
3. Project store 中的 `DESIGN.md` 是权威文件；`.hadamard/DESIGN.md` 只能是服务生成的可选镜像。
4. v1 模板只允许声明式章节与 theme tokens，不允许 JavaScript、iframe、远程脚本或任意网络请求。
5. 旧 `PROGRESS.md` 读取兼容但不静默写入：仅旧文件时展示迁移预览；双文件时报告冲突并要求用户选择；确认后才原子提交并备份旧文件。
6. Design 包与带校验数据块的 Hadamard HTML 可恢复为可编辑文档；普通 HTML/PDF 只能作为不可信参考附件。

## 拒绝的方案

- 同时编辑 Markdown 和 HTML：拒绝，无法可靠避免语义漂移。
- 首次读取自动覆盖/拼接：拒绝，可能丢失用户设计决策。
- 关闭 Markdown HTML 转义：拒绝，预览不应成为执行边界。
- 把 Design 与 Memory 合并：拒绝，两者受众和分享边界不同。

## 兼容与安全影响

- 旧项目在确认迁移前仍可读 `PROGRESS.md`。
- 导入必须限制路径、文件数、展开大小、MIME 和 checksum，并在隔离目录预览。
- Design 编辑不能隐式修改 `AGENTS.md`、machine policy 或权限；这些变更必须独立显示 diff 并确认。

## 测试证据

- `tests/design-migration.spec.ts`：legacy-only、canonical-only、双文件冲突和无写入读取。
- 后续 `tests/design-document*.spec.ts`：原子迁移、导入攻击样例、模板与导出往返。

## 回滚方式

保留只读 legacy inspector 和带时间戳备份。若新 UI 回归，可恢复读取旧文件，但不得恢复静默双写或把 HTML 设为权威源。
