# ADR-011: Project Design 文档源与 Document 工作区

- 状态：Accepted
- 日期：2026-08-12
- 决策范围：Project Manager、GUI/TUI、Design 导入导出与 Document UI

## 背景

项目首页需要一个面向人的文档工作区。设计文档应当支持模板化 HTML 预览、编辑、导出、分享和被 Agent 微调，但不能让 HTML 成为第二份可编辑事实来源。

## 决策

1. 每个项目只使用 `DESIGN.md` 作为面向人的设计文档；`MEMORY.md` 面向 Agent 的长期上下文，`AGENTS.md` 面向项目规则，三者在 Document UI 中分开显示。
2. Markdown 是唯一可编辑源；HTML/PDF/Package 是导出物，预览由 renderer 根据模板、主题和 profile 生成。
3. Document UI 使用左侧文档导航、中央预览/编辑区、右侧文档 inspector 的三栏布局。Design 专属的模板、主题、profile、导入导出、分享操作按工具组集中显示。
4. 所有项目直接采用 `DESIGN.md` 语义。应用不读取、不迁移、不展示、不提供接口处理 `PROGRESS.md`，也不保留迁移按钮或兼容端点。
5. Design 预览禁止执行 JavaScript、iframe、远程脚本或任意网络请求；导入继续执行路径、大小、MIME 和 checksum 校验。

## 交互约束

- 双击预览或点击 Edit 进入 Markdown 编辑；Escape 保存并回到预览。
- 切换文档前自动保存脏内容。
- 窄窗口隐藏 inspector，手机尺寸将左侧导航改为横向标签，中央文档保持滚动和编辑能力。
- AGENTS.md 使用项目工作区根目录的独立读写端点，不与 MEMORY.md 合并。

## 验证

- `tests/design-document.spec.ts` 覆盖 DESIGN.md 的 canonical 读取、原子写入、revision 检查和模板解析。
- `tests/design-document-http.spec.ts` 覆盖 Design 读写/渲染、AGENTS.md 读写、三种导出、导入和分享。
- GUI parity 测试覆盖 Document 入口、Design renderer 和操作端点。

## 回滚

回滚仅指恢复上一版本代码；不恢复已移除的 `PROGRESS.md` 读取、迁移接口或迁移 UI。
