# Hadamard Canvas（hcanvas）

Hadamard Canvas 是独立于桌面 GUI（`hadamard-gui`）的 AI-native 画布应用。人和 agent 操作同一份文档：

- **HTML 页面**：沙箱渲染，可直接在页面上改文字/样式，也可用完整 HTML/CSS 源码编辑器；
- **Canvas 页面**：可混合 HTML、文本、Markdown、代码、图片、形状、原生手绘与箭头块；
- **Agent**：通过 JSON-first CLI 读写同一文档，不需要 MCP 或浏览器自动化。

## 独立桌面应用

Hadamard Canvas 可以作为独立 Electron 窗口运行，不只是一个浏览器标签页：

```bash
hcanvas desktop --workspace <dir> [--port 4319]
# 或: npm run hcanvas:desktop -- --workspace <dir>
# 或: node bin/hcanvas-desktop.js --workspace <dir>
```

桌面入口会启动本地 hcanvas 服务并打开原生窗口：无菜单栏、外链交给系统浏览器、窗口关闭时服务退出。原有浏览器模式（`hcanvas app`）继续保留。

生成带 Canvas 图标的 Windows 便携版：

```bash
npm run build:hcanvas:desktop
# dist_electron/canvas/Hadamard-Canvas-0.4.22-portable.exe
```

需要独立工作区时显式传路径：

```powershell
.\Hadamard-Canvas-0.4.22-portable.exe --workspace C:\Users\me\hcanvas --port 4319
```

改为构建 Windows 安装包：

```bash
npm run build:hcanvas:installer
# dist_electron/canvas/Hadamard-Canvas-Setup-0.4.22.exe
```

安装包是标准 NSIS 向导：可选择安装目录、创建开始菜单与桌面快捷方式、自带卸载器，无需 system-wide 安装。

## 启动

```bash
npx hcanvas app --workspace ~/.hcanvas
npx hcanvas serve --workspace /path/to/workspace --port 4319
```

从本仓库运行：

```bash
npm run build
node bin/hcanvas.js app --workspace plan/hcanvas-demo
```

工作区结构：

```
<workspace>/docs/<docId>.json     # 文档模型（pages、blocks、HTML）
<workspace>/state.json            # 当前文档/页面/选中块、agent sessions
<workspace>/daemon.json           # 服务 URL + token
<workspace>/exports/              # HTML/PDF/PNG 导出
```

## HTML 直接编辑

HTML 页面和 HTML block 在沙箱 iframe 中渲染：

- **可视化**：双击文字直接编辑；点击元素查看元素树和文本颜色、背景、字号、padding、对齐等样式；修改通过稳定的 `data-hc-id` patch 回 HTML 源；
- **源码**：CodeMirror 编辑完整 HTML/CSS，实时预览；
- 编辑模式下脚本禁用；预览模式使用带脚本、无同源的沙箱。

## Canvas 页面

块类型：HTML、文本、Markdown、代码、图片、形状、原生手绘（freehand）、箭头（arrow）。Infinite 页可用 **Pen (P)** / **Arrow (A)** / **Eraser (E)** 直接绘制、擦除原生矢量；手绘会平滑成 path，数据以 block points 存在 JSON 中，可缩放、改线色/线宽。**Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** 撤销重做 block 编辑，**Ctrl/Cmd+C/V** 复制粘贴选中 block。页面支持 slide 16:9、A4、海报 4:5、方形和自定义尺寸。提供全屏 Present 模式，导出 HTML/PDF/PNG（使用本机 Chrome/Edge/Chromium）。PPTX/母版等后续扩展。

## 无限画布与工具栏

新增页面时选择 **Infinite canvas**（演示文档里也有 Infinite canvas 页）。没有页面边界：用 Hand 工具、按住 Space 或中键拖动平移，鼠标滚轮指哪缩哪或用缩放按钮缩放，块可以放在任意位置。左侧工具栏可切换选择/抓手、插入 HTML/文本/Markdown/代码/图片/形状、切换点阵网格与 8px 吸附、查看快捷键。选中块后顶部出现浮动操作条（编辑、复制、置顶/置底、对齐、删除）。导出/Present 会按内容边界裁剪无限画布。

## 演示工作流

- **幻灯片模板**：Cover、Section、Two columns、Quote、Agenda（16:9 HTML 页），以及空白 slide/A4/海报模板。
- **Speaker notes**：在 Inspector 编辑每页备注；Present 模式有 Notes 开关，PPTX 导出会写入 notes。
- **Present**：全屏翻页演示；Excalidraw 白板页以干净的只读 view mode 展示。
- **PowerPoint 导出**：`hcanvas export <doc> --format pptx` 生成 16:9 PPTX，一页一张 slide，并带 speaker notes。
  - **Canvas 页面**（文本/形状/图片块，不含 HTML 块）会导出为**可编辑的 PowerPoint 文本框和形状**；
  - `format=pptx-editable` 还会用真实浏览器布局数据，把 HTML 标题、段落、列表、内联标签和卡片背景映射为原生 PowerPoint 文本框/形状；无文本可提取的页面回退为图片；
  - HTML、Infinite、Excalidraw 白板页在默认视觉 deck 中以高保真整页图片嵌入；
  - **+ Page** 提供 Canvas · PPT cover / content 模板；
  - 白板图片通过本地 Excalidraw CLI 渲染。

## 简历与海报

**+ Page** 提供 A4 简历模板（Classic / Modern / ATS minimal）和 4:5 海报模板（Event / Product）。它们就是可编辑的 HTML 页面：直接改文字、用源码改布局，然后导出。

- **PDF / PNG / HTML**：通过本地浏览器按 A4/海报尺寸矢量打印；
- **Print PDF**：Export → **Print PDF · 3mm bleed**（或 `--format pdf --bleed-mm 3 --crop-marks`）增加 3mm 出血和 slug 区裁切标记；输出为 RGB PDF，不做 CMYK 转换。
- **DOCX（ATS）**：当前 HTML 页可导出 `format=docx`（UI：**Word résumé (.docx)**）。导出器遍历语义 HTML（标题、段落、列表），生成单栏 A4 Word 文档，文字可选，适合 ATS 投递；最稳妥的模板是 **ATS minimal**；
- **PPTX**：简历/海报页也可以作为整页 slide 放进 PPTX deck。

## 页面母版

任意页面（HTML、Canvas、Infinite、Excalidraw 白板）都可以保存为 **workspace 级页面母版**，作为新页面的起点复用：

- UI：Page inspector → **Save as master**；**+ Page** → **My page masters** 显示 HTML/Canvas 母版实时缩略图，并提供 **Use** / **Delete** 操作。
- CLI：
```bash
hcanvas masters save <doc> --page <pageId> --name "Title slide"
hcanvas masters list
hcanvas masters apply <masterId> <doc> --base-revision <rev>
hcanvas masters delete <masterId>
```

母版存储在 `<workspace>/masters.json`；应用母版会创建新页，重新生成 page/block ID，并保留原 mode、尺寸、背景、HTML/blocks/scene 与 speaker notes。之后编辑新页面不会改动母版。

## Excalidraw 白板页

新增 **Excalidraw whiteboard** 页面预设，内嵌本地打包的完整 Excalidraw 编辑器：形状、箭头、自由绘制、文字、图片、frame、手绘风格、图层、缩放/平移、撤销/重做和 Excalidraw 工具栏。场景随文档保存：

```bash
hcanvas read <doc> --format scene --page <白板页 id>
hcanvas apply <doc> --ops-file scene-ops.json --base-revision <rev> --actor claude-code
```

```json
[{ "op": "set_whiteboard_scene", "pageId": "page_...", "scene": { "elements": [], "appState": {}, "files": {} } }]
```

编辑自动保存并做 revision 校验；页面 Inspector 可下载 `.excalidraw`；白板的 HTML/PDF/PNG/PPTX 通过本地打包的 Excalidraw CLI 渲染导出。

### 多 Agent 实时 Presence

每个 agent 创建一个 session 并心跳；hcanvas 在 **Agent** 页和顶栏显示在线 agent：

```bash
hcanvas sessions create <doc> --actor claude-code
export HCANVAS_SESSION=session_...
hcanvas context --json          # 自动心跳
hcanvas read <doc> --format outline
hcanvas apply <doc> --ops-file ops.json --base-revision <rev>
hcanvas sessions list           # 所有在线/过期 session
hcanvas sessions heartbeat <id> --doc <doc> --page <page> --block <block>
hcanvas sessions delete <id>
```

Agent 页显示 actor、当前文档/页面、选中项、最后心跳、最近文档活动（history）、agent context JSON 与可复制的 CLI 片段；10 分钟无心跳会显示为 stale。

当前页有 session 的 agent 会显示为画布内的彩色光标。Canvas/Infinite 页锚定到 block；HTML 页会测量真实渲染布局，锚定到上报的 `data-hc-id` 元素；Excalidraw 白板会用 scene 元素位置 + 当前 scroll/zoom 投影出光标。点击光标即可 **follow** 该 agent：hcanvas 会切换到它的文档/页面并选中它上报的 block 或 HTML 元素。

## Canvas Copilot（应用内 AI）

**Copilot** 页内嵌一个可以读写当前画布的 agent，不需要终端。它使用 OpenAI-compatible chat-completions 接口，并暴露两个工具：`canvas_read`（outline/html/page/scene + revision）和 `canvas_apply`（带 revision CAS 的 hcanvas ops）。

启动前配置模型：

```bash
export HCANVAS_LLM_BASE_URL="https://api.openai.com/v1"
export HCANVAS_LLM_API_KEY="..."
export HCANVAS_LLM_MODEL="gpt-4o-mini"
hcanvas app --workspace ~/.hcanvas
```

或创建 `<workspace>/agent.json`（不要提交）：

```json
{ "baseUrl": "https://api.openai.com/v1", "apiKey": "...", "model": "gpt-4o-mini" }
```

Copilot 会先读取再写入，用 revision 校验应用修改，并在编辑后重新加载画布。未配置模型时 Copilot 页会显示设置说明；CLI 协议始终可用，不需要模型。

## Agent 协议（CLI-first）

CLI 默认输出 JSON，支持 stdin/stdout、结构化错误与退出码：

```bash
hcanvas context --json
hcanvas read <doc> --format outline
hcanvas read <doc> --format html --page <id>
hcanvas apply <doc> --ops-file ops.json --base-revision 7 --actor claude-code
hcanvas propose <doc> --ops-file ops.json --base-revision 7 --intent "Add a slide"
hcanvas proposal accept <doc> <proposalId>
hcanvas export <doc> --format pdf --out deck.pdf
```

寻址顺序：显式 id/标题/`hcanvas://doc/<id>` → `HCANVAS_DOC`/session context → 工作区唯一文档 → 否则返回候选让 agent 询问。写操作必须带 `--base-revision`，过期 revision 返回退出码 2 和最新 revision。session 通过 `HCANVAS_SESSION` 绑定文档/页面/选中项。

HTML patch 示例：

```json
[
  {
    "op": "html_patch",
    "pageId": "page_...",
    "patches": [
      { "op": "set_text", "target": "el_...", "text": "New heading" },
      { "op": "set_style", "target": "el_...", "styles": { "color": "#6d28d9" } }
    ]
  }
]
```

提案：agent 用 `hcanvas propose` 提交 ops，人在 Proposals 面板接受/拒绝；接受后成为新 revision，冲突会显式提示而不是覆盖。

HTTP API 与 CLI 同源：`/api/state`、`/api/docs`、`/api/docs/:id/read|apply|proposals`、`/api/export`、`/api/events`（SSE）；请求需 `x-hcanvas-token`，默认仅监听 localhost。

## 安全

- 本地服务 + 每进程 token，`daemon.json` 供 CLI 发现；
- 编辑 iframe 无脚本 + same-origin，预览 iframe 有脚本 + 无 same-origin；
- 无远程 CDN，UI/编辑器本地打包；
- 写操作按文档串行、revision CAS、记录历史。

## 限制

- 当前是本地 Web 应用；Electron 打包/多窗口、多用户 CRDT 后续做；
- 可视化编辑聚焦文字/样式，结构修改走源码；
- 视觉 PPTX 中 HTML 页仍为整页图片；可编辑 deck 会把 HTML 文本映射为原生 PowerPoint 对象（布局为近似，复杂 CSS 效果不重建）。母版、素材库、矢量 PDF 仍为后续扩展。
- DOCX 导出刻意走 text-first/ATS 路线，不复刻视觉卡片和装饰图形。
## 项目 Workspace

选定项目目录后，hcanvas 可以初始化它；所有产品数据都放在 `<project>/.hcanvas`：

```bash
hcanvas workspace init ~/projects/my-deck
hcanvas projects list
hcanvas app --project ~/projects/my-deck
hcanvas desktop --project ~/projects/my-deck
```

顶部 **Projects ▾** 菜单从全局项目注册表（`~/.hcanvas/projects.json`）列出所有初始化过的项目。桌面版选择项目会打开一个**独立窗口**（可同时打开多个项目）；**Open Project…** 通过原生目录选择创建/打开 `<project>/.hcanvas`。浏览器模式可以打开已在运行的其他项目服务。点击左下角 workspace 路径会打开 Workspace 对话框，显示当前路径、生成的 CLI 指南，并可一键复制。初始化不破坏现有文件，会创建：

```text
<project>/.hcanvas/
  CLI.md          # 生成的 CLI 操作指南
  workspace.json  # 项目标识 / schema
  docs/           # 文档
  exports/        # 导出文件
  .gitignore      # daemon.json + exports/
```

## 存储格式

一个 workspace（通常是 `<project>/.hcanvas`）就是普通目录：

```
<workspace>/docs/<docId>.json   # 文档：pages、html/blocks/scene、history、proposals
<workspace>/state.json         # 当前 canvas/page 与 agent sessions
<workspace>/masters.json        # 可复用页面母版
<workspace>/daemon.json         # 本地服务 URL + token
<workspace>/exports/            # HTML/PDF/PNG/PPTX/DOCX 输出
```

文档使用 JSON schema `hadamard-canvas/1`：HTML 页把完整源码存在 `page.html`；Canvas/Infinite 页存 `page.blocks`；Excalidraw 页存 `page.scene`。未选择项目时，桌面应用回退到 `~/.hcanvas`；`--workspace <dir>` 仍可直接指定 store 根目录，推荐使用项目化模式 `--project <dir>`。