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

- **可视化**：双击文字直接编辑；鼠标悬停元素会显示命中轮廓，点击后可在 Inspector 查看层级路径和元素树；编辑横幅的 **Insert +** 会展开紧凑的元素面板（标题、段落、按钮、链接、图片、列表、引用、卡片、分隔线）；选中的元素还可使用快捷操作和自动应用的样式面板（无需点 Apply），内置 Title/Body/Muted/Accent/Card 预设，并可调颜色、背景、字号/字重、字间距、padding、对齐、圆角、行高；修改通过稳定的 `data-hc-id` patch 回 HTML 源；
- **源码**：CodeMirror 编辑完整 HTML/CSS，实时预览；
- 编辑模式下脚本禁用；预览模式使用带脚本、无同源的沙箱。

## Canvas 页面

块类型：HTML、文本、Markdown、代码、图片、形状、原生手绘（freehand）、曲线（curve）、箭头（arrow）。左侧 **Curve (C)** 工具可拖出平滑的三次贝塞尔曲线；曲线使用紧包围盒，点选/移动/缩放正常，可改描边颜色、宽度和线型。形状支持矩形、椭圆、菱形、三角形、平行四边形、梯形、六边形、八边形、星形、十字、直线和 frame，可设置填充、描边、线型与圆角；左侧 **Shape** 按钮悬停时会在右侧展开按 Basic / Lines / Flowchart / Stars & Banners / Callouts / Action Buttons 分组的 60+ 个 PPT 类形状；选中矩形/polygon 后点击选择工具栏的 **Slice**，拖一条切割线即可切成两个可编辑 polygon block（撤销可恢复）。无选中 block 时，Page Inspector 的 **Components** 区域可添加 Slider 等样式关联组件，并在 Inspector 调整 label/value/min/max/accent/track/text。在气泡中点选形状后，在画布上点击/拖拽放置；点击 Shape 或按 6 也会打开同一选择器。可用 **框选**、**Shift+click** 或点击组成员多选；**Ctrl/Cmd+G** 成组、**Ctrl/Cmd+Shift+G** 解组，拖动任一选中 block 会整体移动。Markdown 支持引用块（`> 引用`）、GFM 和 LaTeX 数学公式：行内 `$E=mc^2# Hadamard Canvas（hcanvas）

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

- **可视化**：双击文字直接编辑；鼠标悬停元素会显示命中轮廓，点击后可在 Inspector 查看层级路径和元素树；编辑横幅的 **Insert +** 会展开紧凑的元素面板（标题、段落、按钮、链接、图片、列表、引用、卡片、分隔线）；选中的元素还可使用快捷操作和自动应用的样式面板（无需点 Apply），内置 Title/Body/Muted/Accent/Card 预设，并可调颜色、背景、字号/字重、字间距、padding、对齐、圆角、行高；修改通过稳定的 `data-hc-id` patch 回 HTML 源；
- **源码**：CodeMirror 编辑完整 HTML/CSS，实时预览；
- 编辑模式下脚本禁用；预览模式使用带脚本、无同源的沙箱。

## Canvas 页面

块类型：HTML、文本、Markdown、代码、图片、形状、原生手绘（freehand）、箭头（arrow）。形状支持矩形、椭圆、菱形、三角形、平行四边形、梯形、六边形、八边形、星形、十字、直线和 frame，可设置填充、描边、线型与圆角；左侧 **Shape** 按钮悬停时会在右侧展开按 Basic / Lines / Flowchart / Stars & Banners / Callouts / Action Buttons 分组的 60+ 个 PPT 类形状；选中矩形/polygon 后点击选择工具栏的 **Slice**，拖一条切割线即可切成两个可编辑 polygon block（撤销可恢复）。无选中 block 时，Page Inspector 的 **Components** 区域可添加 Slider 等样式关联组件，并在 Inspector 调整 label/value/min/max/accent/track/text。在气泡中点选形状后，在画布上点击/拖拽放置；点击 Shape 或按 6 也会打开同一选择器。可用 **框选**、**Shift+click** 或点击组成员多选；**Ctrl/Cmd+G** 成组、**Ctrl/Cmd+Shift+G** 解组，拖动任一选中 block 会整体移动。 / `\(x^2\)`，独立公式 `$...$` / `\[...\]`，通过 KaTeX 输出 MathML，因此导出和 Present 也能正常显示。左侧 **∑ Formula** 工具或快捷键 `7` 可插入独立 LaTeX block，双击或 **Edit formula** 打开源码 + 实时公式编辑器。图片可从文件夹直接拖入 Canvas/Infinite 页，或从剪贴板粘贴；侧边栏的图片插入按钮已移除，已有图片仍可在 Inspector 改 URL。形状选中后有 8 个角/边缩放手柄；直线则只有两个端点手柄，可自由拖动任一端改变方向和长度；拖动标签可移动，双击形状可直接编辑居中文字，Inspector 可改字体/字号/颜色；拖动时会显示并吸附到其他 block 或页面中心的智能参考线。转换后的 Excalidraw frame 会记录子元素 `frameId`，拖动 frame 时子元素跟随。**Arrow (A)** 落在 shape/text/image/frame 上时会自动绑定两端（`startBinding` / `endBinding`），移动或缩放被绑定元素时箭头端点自动跟随；文字 block 选中后可拖 block 本体，也可拖上方的小 **label 把手** 移动；双击就地编辑，`Esc` 结束。block 重叠时 **Alt+click** 会在叠放层之间循环选择。Infinite 页选择插入类型（HTML/Text/Markdown/Code/Shape）后进入 **click-to-place**：下一次点击画布才在该位置创建 block；坐标无边界，负 x/y 也有效，frame 不裁剪/限制 block，可在 Inspector 里 **Dissolve frame** 保留子元素。**Pen (P)** / **Arrow (A)** / **Eraser (E)** 可直接绘制、擦除原生矢量；手绘会平滑成 path，数据以 block points 存在 JSON 中，可缩放、改线色/线宽。**Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** 撤销重做 block 编辑，**Ctrl/Cmd+C/V** 复制粘贴选中 block。Add Page 不再提供 Excalidraw Whiteboard，新画板请用 Infinite；已有旧白板可一键迁移。页面支持 slide 16:9、A4、海报 4:5、方形和自定义尺寸。提供全屏 Present 模式，导出 HTML/PDF/PNG（使用本机 Chrome/Edge/Chromium）。PPTX/母版等后续扩展。

## 无限画布与工具栏

新增页面时选择 **Infinite canvas**（演示文档里也有 Infinite canvas 页）。没有页面边界：用 Hand 工具、按住 Space 或中键拖动平移，鼠标滚轮指哪缩哪或用缩放按钮缩放，块可以放在任意位置。左侧工具栏可切换选择/抓手、插入 HTML/文本/Markdown/代码/图片/形状、切换点阵网格与 8px 吸附、查看快捷键。选中块后顶部出现浮动操作条（编辑、复制、置顶/置底、对齐、删除）。导出/Present 会按内容边界裁剪无限画布。撤销/重做会被串行化：拖动、缩放、文字编辑、HTML 元素 patch、分组、页面排序和换形状都记录正确 inverse；连续快速 Ctrl/Cmd+Z 会排队逐步回退。

## 演示工作流

- **画布尺寸**：新建时可选择 Canvas · 16:9、A4、4:5、1:1、16:9 wide、Infinite 或 HTML page；用途由尺寸和内容决定，不再区分 Slide / Résumé 页面类型。
- **Speaker notes**：在 Inspector 编辑每页备注；Present 模式有 Notes 开关，PPTX 导出会写入 notes。
- **Present**：全屏翻页演示；单击屏幕或滚轮上下翻页，右键菜单提供上一页/下一页/激光笔/备注/退出，按 L 切换激光笔；Excalidraw 白板页以干净的只读 view mode 展示。
- **PowerPoint 导出**：`hcanvas export <doc> --format pptx` 生成 16:9 PPTX，一页一张 slide，并带 speaker notes。
  - **Canvas 页面**（文本/形状/图片块，不含 HTML 块）会导出为**可编辑的 PowerPoint 文本框和形状**；
  - `format=pptx-editable` 还会用真实浏览器布局数据，把 HTML 标题、段落、列表、内联标签和卡片背景映射为原生 PowerPoint 文本框/形状；无文本可提取的页面回退为图片；
  - HTML、Infinite、Excalidraw 白板页在默认视觉 deck 中以高保真整页图片嵌入；
  - 在 **+ Page** 创建 **Canvas · 16:9** 页面，添加文本/形状 blocks 即可导出可编辑 PowerPoint；
  - Legacy 白板页在图片/PPTX 渲染前会先转换为原生 blocks，不再使用 Excalidraw CLI。

## 文档、简历与海报

使用通用的 **Canvas · A4** 做文档/简历，**Canvas · 4:5** 做海报。它们就是普通 canvas 页面：添加文本/形状/图片 blocks、直接编辑，然后导出。用途由画布尺寸和内容决定，不再有独立的“简历”或“幻灯片”页面类型。

- **PDF / PNG / HTML**：通过本地浏览器按 A4/海报尺寸矢量打印；
- **Print PDF**：Export → **Print PDF · 3mm bleed**（或 `--format pdf --bleed-mm 3 --crop-marks`）增加 3mm 出血和 slug 区裁切标记；输出为 RGB PDF，不做 CMYK 转换。
- **DOCX（ATS）**：语义 HTML 页或 HTML-page 文档可导出 `format=docx`（UI：**Word résumé (.docx)**）。导出器遍历语义 HTML（标题、段落、列表），生成单栏 A4 Word 文档，文字可选，适合 ATS 投递；单栏纯文本布局最稳妥；
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

## Legacy Excalidraw 白板页

旧文档可能仍包含 **Excalidraw whiteboard** 页。新建页面已不再提供此预设，hcanvas 也不再加载或提供 Excalidraw 运行时。旧白板以只读原生预览显示（形状、箭头、手绘、文本、图片、frame、旋转/透明度/虚线）；点击 **Convert to native Infinite** 后可编辑。原始 scene 仍保存在文档中用于迁移。场景随文档保存：

```bash
hcanvas read <doc> --format scene --page <白板页 id>
hcanvas apply <doc> --ops-file scene-ops.json --base-revision <rev> --actor your-agent
```

```json
[{ "op": "set_whiteboard_scene", "pageId": "page_...", "scene": { "elements": [], "appState": {}, "files": {} } }]
```

页面 Inspector 可下载原始 `.excalidraw`；白板的 HTML/PDF/PNG/PPTX 导出会先内部转换为原生 blocks，不再依赖 Excalidraw CLI。

### 迁移到原生 Infinite

在白板页 Inspector 点击 **Convert to native Infinite**，会把 Excalidraw 元素转换为原生 Infinite blocks：freehand、箭头及 binding、文本、矩形/椭圆/菱形/frame、旋转/透明度/虚线以及图片 data URL，并打开新页面；原白板保持不变。

CLI 同样支持转换与原生 scene 导入/导出：

```bash
hcanvas migrate-whiteboards <doc> --delete-source
hcanvas convert-whiteboard <doc> --page <白板页 id> --title "Board · Native"
hcanvas import-scene ./board.excalidraw <doc> --title "导入画板"
hcanvas export-scene <doc> --page <infinite 页 id> --out ./exports/board.excalidraw
```

Infinite 页顶栏 **Export → Excalidraw scene** 也可下载反向兼容文件。

A4 简历推荐用 Canvas 页（794×1123）由原生 text/shape/image block 搭建；PDF/PNG 保留固定版式，visual PPTX 每页嵌入整页图片，editable PPTX 使用原生 text/shape，DOCX 输出语义文本版。PPTX 会保持页面宽高比（A4 仍是 A4），不再强制 16:9。暂不支持的原生元素（极少数 embed）会跳过并记录在页面 notes。

### 多 Agent 实时 Presence

每个 agent 创建一个 session 并心跳；hcanvas 在 **Agent** 页和顶栏显示在线 agent：

```bash
hcanvas sessions create <doc> --actor your-agent
export HCANVAS_SESSION=session_...
hcanvas context --json          # 自动心跳
hcanvas read <doc> --format outline
hcanvas apply <doc> --ops-file ops.json --base-revision <rev>
hcanvas sessions list           # 所有在线/过期 session
hcanvas sessions heartbeat <id> --doc <doc> --page <page> --block <block>
hcanvas sessions delete <id>
```

Agent 页现在是接入与观测面板：顶部显示当前文档/页面和在线会话状态；**Copy agent prompt** 会把 workspace、document、page、revision 组合成可直接粘贴到任意 coding agent 对话框的提示词；下面是在线会话卡片、最近编辑、context JSON 和 CLI 参考。不硬编码任何厂商的 agent 名称；10 分钟无心跳会显示为 stale。

当前页有 session 的 agent 会显示为画布内的彩色光标。Canvas/Infinite 页锚定到 block；HTML 页会测量真实渲染布局，锚定到上报的 `data-hc-id` 元素；Excalidraw 白板会用 scene 元素位置 + 当前 scroll/zoom 投影出光标。点击光标即可 **follow** 该 agent：hcanvas 会切换到它的文档/页面并选中它上报的 block 或 HTML 元素。


## Agent 协议（CLI-first）

CLI 默认输出 JSON，支持 stdin/stdout、结构化错误与退出码：

```bash
hcanvas context --json
hcanvas read <doc> --format outline
hcanvas read <doc> --format html --page <id>
hcanvas apply <doc> --ops-file ops.json --base-revision 7 --actor your-agent
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

顶部 **Projects** 按钮会打开全屏**项目管理页**，数据来自全局注册表（`~/.hcanvas/projects.json`）。画布页顶栏的 **Open folder** 会打开当前项目根目录；Page Inspector 的 **Open page files** 会打开文档 JSON 所在的 `<workspace>/docs`。项目卡片中，**📁 Open folder** 可在系统文件管理器中打开项目文件夹（Workspace 对话框里也有同样按钮）。桌面版点击项目会打开一个**独立窗口**（可同时打开多个项目）；**New Project…** 通过原生目录选择创建/打开 `<project>/.hcanvas`。浏览器模式点击卡片会在新标签打开已在运行的项目；点击当前项目卡片返回画布。点击左下角 workspace 路径会打开 Workspace 对话框，显示当前路径、生成的 CLI 指南，并可一键复制。初始化不破坏现有文件，会创建：

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
## 工作区面板

左侧 **Canvases / Pages** 侧边栏和右侧检查器都可以拖拽内侧分隔条调整宽度；双击分隔条可收起面板。顶栏的 ▤ / ▥ 按钮分别切换左右侧边栏，宽度和收起状态会保存在浏览器本地。

右侧有四个 Tab：

- **Inspector**：页面/block 属性、布局、样式、分组、历史与导出入口。
- **Agent**：接入引导 + 在线会话 + 最近编辑 + context JSON + CLI 快速接入；它是外部 CLI Agent 的观测面板，不是聊天框。
- **Proposals**：Agent 提交的修改提案审核队列；接受或拒绝后才会写入文档。
## 插件 block

hcanvas 可以加载声明式 block 插件，不需要执行 JavaScript bundle。插件是一个带 `manifest.json` 的目录：

```text
<project>/.hcanvas/plugins/<plugin-id>/manifest.json
~/.hadamard/hcanvas/plugins/<plugin-id>/manifest.json
```

项目插件优先；重复的 block type 会被跳过并报告错误。最小 manifest：

```json
{
  "schema": "hcanvas-plugin/1",
  "id": "sticky-notes",
  "name": "Sticky Notes",
  "version": "1.0.0",
  "apiVersion": "hcanvas-plugin/1",
  "blocks": [{
    "type": "sticky-note",
    "label": "Sticky note",
    "hint": "A small paper note",
    "defaultSize": { "w": 280, "h": 200 },
    "defaultData": { "title": "Sticky note", "body": "Write something here." },
    "fields": [
      { "key": "title", "label": "Title", "kind": "text" },
      { "key": "body", "label": "Body", "kind": "textarea" }
    ],
    "render": "<div style=\"padding:18px;background:#fff7d6\">{{title}}<br>{{body}}</div>"
  }]
}
```

`render` 是 HTML 模板，`{{fieldKey}}` 占位符会被 HTML 转义；脚本、iframe、事件属性和 `javascript:` URL 会被拒绝。支持字段类型：`text`、`textarea`、`color`、`select`、`number`。新增或修改 manifest 后，在 Canvas/Infinite 页面的 Inspector 点击 **Reload plugins**，插件 block 会出现在 **Plugin blocks** 区域。

点击 **Plugin blocks** 旁边的 **Manage** 可以启用/禁用已安装插件，也可以用 **Create block sample** / **Create page sample** 在 `.hcanvas/plugins/` 下生成合法 manifest；**Gallery** 可一键安装内置示例（Sticky Notes、Starter Pages），**Import JSON** 可粘贴或选择 manifest 安装到当前项目；项目插件可在管理器中点 **Remove** 卸载（不会删除用户级插件）；状态保存在 `.hcanvas/plugin-settings.json`，禁用后插件 block 会显示安全的 unknown-block fallback。完整示例见 `examples/hcanvas-plugins/sticky-notes/manifest.json`。插件 block 以普通 block + `data` 保存，因此支持保存/重载、撤销/重做、复制粘贴和 Present。声明式模板是本地可信 UI 内容，只安装你理解的 manifest。
### 页面模板插件

插件还可以贡献整套页面模板，在 manifest 中加入 `pagePresets`：

```json
{
  "pagePresets": [{
    "id": "project-brief",
    "label": "Project brief",
    "mode": "canvas",
    "width": 1280,
    "height": 720,
    "background": "#fffdf8",
    "blocks": [
      { "type": "text", "x": 72, "y": 56, "w": 900, "h": 80, "text": "Project brief", "style": { "fontSize": 48, "fontWeight": 700 } },
      { "type": "shape", "x": 72, "y": 250, "w": 340, "h": 220, "shape": "rect", "text": "Goals" }
    ]
  }]
}
```

支持 `canvas`、`infinite`、`html` 三种模式；canvas/infinite 模板提供 blocks，HTML 模板提供 `html` 字符串。打开 **Add a page**，在 **Plugin page templates** 区域选择模板；新页面通过正常文档操作创建，支持撤销/重做。纯页面模板插件可以不提供 `blocks`。示例：`examples/hcanvas-plugins/starter-pages/manifest.json`。