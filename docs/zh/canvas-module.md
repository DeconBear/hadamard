# 画布模块（可选）

Hadamard 支持按需加载的**模块**；模块决定某个能力是否存在，未加载时它的界面、agent 工具与会话上下文都不会被注册。

画布是第一个模块，**默认关闭**。编辑画布使用 **[Excalidraw](https://github.com/excalidraw/excalidraw)（MIT）**，已本地打包进桌面 GUI，不依赖 CDN。

## 开启 / 关闭

1. 打开桌面 GUI。
2. 进入 **Settings → Personalization → Modules**。
3. 勾选 **Canvas**。Hadamard 会把 `modules.canvas.enabled` 写入 `~/.hadamard/settings.json` 并重载运行时。
4. 打开项目，使用 **Canvas** 页签。关闭模块后，页签、`/api/canvas/*` 路由与画布 agent 工具立即消失。

无界面场景可用环境变量覆盖：

```bash
HADAMARD_ENABLE_MODULES=canvas   # 强制开启
HADAMARD_DISABLE_MODULES=canvas  # 强制关闭
```

## 单独启动

仅画布窗口（本次进程强制启用 canvas 模块）：

```bash
npx hadamard-canvas [工作目录]
# 或：npx hadamard-gui --surface canvas [工作目录]
```

## 模块提供什么

| 贡献 | 加载时 | 未加载时 |
|---|---|---|
| 项目详情 **Canvas** 页签 + Excalidraw 编辑器 | 可见 | 不渲染 |
| `/api/canvas/*` HTTP 路由 | 200 | 404 |
| 画布 agent 工具 | 注册到新 run | 不在工具目录中 |
| 会话中的画布摘要上下文 | 通过 session prompt part 注入 | 不注入 |

### 用 Excalidraw 编辑

矩形、菱形、椭圆、箭头、线、自由绘制、文本、图片、frame；手绘风格（sloppiness）；描边/背景/填充/线宽/线型/箭头/透明度/字体等样式面板；图层、缩放、撤销/重做、导出与快捷键都来自 Excalidraw。Hadamard 额外提供：

- **Canvases 列表**：按项目管理画布，可新建空白画布或 AI 模型模板。
- **自动保存**：停止绘制后通过 `/api/canvas/scene` 保存场景（带 revision 校验；冲突时重新加载而非覆盖）。
- **Agent review** 面板：agent 不会直接改画布，而是提交 proposal；接受后把 typed ops 应用到场景。

## AI 模型架构 pack

可选 pack 把画布变成 tensor-flow 图并校验：

- 节点 `ai.input`、`ai.embedding`、`ai.layer`、`ai.tensor`、`ai.output`、`ai.loss`，边 `ai.flow`。
- 确定性的 **shape/dtype 传播** 与检查：`ai.shape-mismatch`、`ai.residual-mismatch`、`ai.cycle`、`ai.missing-input`、`ai.multiple-inputs`、`ai.unknown-op`、`ai.missing-param`。
- 工具栏 **AI template** 生成 transformer 画布，会转换为 Excalidraw 元素并保留语义 kind/data。
- 导出：Mermaid、PyTorch 风格骨架、JSON Canvas 1.0、Markdown、SVG。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `CanvasList` | 列出画布（id、revision、条目数、待审提案） |
| `CanvasRead` | 读取文档投影：shape、样式、文本、位置、边与 checks |
| `CanvasCreate` | 新建空白画布或 AI transformer 模板 |
| `CanvasImport` | 导入 JSON Canvas 1.0 或 Mermaid |
| `CanvasApplyOps` | 带 `baseRevision` CAS 的 typed ops；场景会按投影重建 |
| `CanvasPropose` | 提交需人审的修改 |
| `CanvasValidate` | 运行 pack 校验器（AI shape 传播） |
| `CanvasExport` | Mermaid、PyTorch、JSON Canvas、Markdown、SVG |
| `CanvasRender` | 生成确定性 SVG 投影供结构检查 |

Agent 编辑必须携带 `CanvasRead` 返回的 revision；revision 过期会失败且不修改文档。接受提案后成为新 revision，并在审阅刷新后反映到 Excalidraw。

## 存储与构建

```
<project>/.hadamard/canvas/<docId>.canvas.json     # agent 可读文档投影（含 proposals、checks）
<project>/.hadamard/canvas/<docId>.scene.json      # Excalidraw 场景（编辑器事实源）
<project>/.hadamard/canvas/<docId>.log.jsonl       # 追加式操作日志
<project>/.hadamard/canvas/assets/<docId>/         # 资产
```

Excalidraw 编辑器**不从 CDN 加载**，需要本地构建一次：

```bash
npm run build:gui-canvas     # esbuild 打包 + fonts/locales 到 dist/gui-canvas
npm run build                # 常规构建也会自动执行该步骤
```

GUI 从同源 `/gui-canvas/` 提供资源（离线可用）。若资源缺失，Canvas 页签会显示可操作的错误提示。

## 安全

- 模块门禁：关闭时路由 404、工具不注册。
- 路径限制在项目内；文档 ≤ 2 MiB，场景/资源有服务端大小限制；revision CAS + 单文档写串行化。
- 编辑器本地运行，无 CDN、无远程字体、无 Cookie；Excalidraw bundle 由 Hadamard 自身提供。
- 接受提案是 agent 意图进入已提交场景的唯一路径。

## 限制

- 首个落地端是桌面 GUI；TUI 对画布只读，DSH 项目插件暂不注册画布工具。
- 提案在 Hadamard 侧栏审阅，尚未在 Excalidraw 画布内显示幽灵形状。
- 暂无实时多人协作、云端素材库、组件系统。
- 其它领域 pack（算法流程、脑暴、美术、电路/机械初稿）为后续工作。

## 许可证

Excalidraw 使用 MIT 许可证，归属与许可文本见 [THIRD_PARTY_NOTICES.md](https://github.com/DeconBear/hadamard/blob/main/THIRD_PARTY_NOTICES.md)。