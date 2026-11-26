# Hadamard Canvas（hcanvas）

第一次使用 Hcanvas？请从 [Hcanvas 快速上手](./hcanvas.md) 开始。

Hadamard Canvas 是独立于桌面 GUI（`hadamard-gui`）的 AI-native 画布应用。人和 agent 操作同一份文档：

- **HTML 页面**：沙箱渲染，可直接在页面上改文字/样式，也可用完整 HTML/CSS 源码编辑器；
- **Canvas 页面**：可混合 HTML、文本、Markdown、代码、图片、形状、原生手绘、曲线与箭头块；
- **Agent**：通过 JSON-first CLI 读写同一文档，不需要 MCP 或浏览器自动化。

## 安装

独立的 CLI 与桌面启动器发布为 `hadamard-canvas` npm 包，提供 `hadamard-canvas`、`hcanvas`、`hcanvas-desktop` 三个命令：

```bash
npm install -g hadamard-canvas
```

桌面版下载可从 [GitHub Releases](https://github.com/DeconBear/hadamard/releases) 获取：Windows（安装包/便携版）、macOS（DMG/ZIP，x64 与 arm64）、Linux（AppImage/DEB，x64）。桌面安装包只包含 Electron 应用，不会把 `hcanvas` / `hadamard-canvas` CLI 加入 PATH；如需 CLI 或 Agent 命令，请另外安装 npm 包。

## 独立桌面应用

Hadamard Canvas 作为独立 Electron 窗口运行：

```bash
hcanvas desktop --workspace <dir> [--port 4319]
# 或: npx hadamard-canvas desktop --workspace <dir>
# 从本仓库运行: npm run hcanvas:desktop -- --workspace <dir>
```

桌面入口会启动本地 hcanvas 服务并打开原生窗口：无菜单栏、外链交给系统浏览器、窗口关闭时服务退出。

生成带 Canvas 图标的 Windows 便携版：

```bash
npm run build:hcanvas:desktop
# dist_electron/canvas/Hadamard-Canvas-0.1.2-portable.exe
```

需要独立工作区时显式传路径：

```powershell
.\Hadamard-Canvas-0.1.2-portable.exe --workspace C:\Users\me\hcanvas --port 4319
```

改为构建 Windows 安装包：

```bash
npm run build:hcanvas:installer
# dist_electron/canvas/Hadamard-Canvas-Setup-0.1.2.exe
```

安装包是标准 NSIS 向导：可选择安装目录、创建开始菜单与桌面快捷方式、自带卸载器，无需 system-wide 安装。

在 macOS 上构建 macOS 包（x64 与 arm64 的 DMG 和 ZIP）：

```bash
npm run build:hcanvas:mac
# dist_electron/canvas/Hadamard-Canvas-0.1.2-<arch>.dmg
# dist_electron/canvas/Hadamard-Canvas-0.1.2-<arch>.zip
```

在 Linux 上构建 Linux 包（x64 的 AppImage 和 DEB）：

```bash
npm run build:hcanvas:linux
# dist_electron/canvas/Hadamard-Canvas-0.1.2-x86_64.AppImage
# dist_electron/canvas/Hadamard-Canvas-0.1.2-amd64.deb
```

## 发布（维护者）

- **actoviq-agent-sdk**：推送 `v<version>` tag 后，`Publish GitHub Release` 创建 Release，`publish-npm.yml` 随后自动发布到 npm。
- **hadamard-canvas**：更新 `hcanvas.version.json` 并推送 `hcanvas-v<version>` tag，`Publish Hcanvas` 构建安装包；成功后 `publish-hcanvas-npm.yml` 自动构建并发布 npm 包。
- 两个工作流都使用 **npm trusted publishing (OIDC)**，不需要 `NPM_TOKEN` secret。首次配置在 npmjs.com 的包设置中完成：**Settings → Trusted Publishing → GitHub Actions**，owner `DeconBear`、repository `hadamard`，workflow 分别填 `publish-npm.yml` / `publish-hcanvas-npm.yml`，environment 留空。
- npm 版本一旦发布不能覆盖；发布前先递增 `package.json` / `hcanvas.version.json` 的 version。工作流会跳过已发布的版本，也可在 Actions 页面用 `workflow_dispatch` 手动指定 tag。

## 启动

```bash
hcanvas desktop --workspace ~/.hcanvas
# 或: npx hadamard-canvas desktop --workspace ~/.hcanvas
```

从本仓库运行：

```bash
npm run build
node bin/hcanvas-desktop.js --workspace plan/hcanvas-demo
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

- **可视化**：单击选中，再次单击文字或按 Enter 直接编辑；鼠标悬停元素会显示命中轮廓，点击后可在 Inspector 查看层级路径和元素树；编辑横幅的 **Insert +** 会展开紧凑的元素面板（标题、段落、按钮、链接、图片、列表、引用、卡片、分隔线）；选中的元素还可使用快捷操作和自动应用的样式面板（无需点 Apply），内置 Title/Body/Muted/Accent/Card 预设，并可调颜色、背景、字号/字重、字间距、padding、对齐、圆角、行高；修改通过稳定的 `data-hc-id` patch 回 HTML 源；
- **SVG 文本**：`<text>` / `<tspan>` 标签会打开紧凑的浮动编辑器。浏览器不支持对 SVG 文本使用 `contenteditable`，因此坐标轴名称、图示标注等 SVG 文本也保持直接可编辑；
- **行内 LaTeX**：在 HTML 文本中输入 `$...$`、`\(...\)`、`$$...$$` 或 `\[...\]`，提交后会渲染为 KaTeX 公式；点击公式可打开实时预览并编辑源码。**Insert** 面板也提供 **Formula** 预设；
- **SVG 公式**：编辑含 LaTeX 的 SVG 标签时，会自动转换为可继续编辑的 `foreignObject` 公式标签。浏览器渲染、PDF/PNG 导出和 Present 使用渲染后的 MathML；外部管线如果需要原生 SVG `<text>`，请保留纯文本标签。
- **Agent ID**：Page Inspector 会显示 **Canvas ID** 和 **Page ID**，并提供复制按钮；右键任意页面也可以复制这两个 ID 给 Agent；
- **源码**：CodeMirror 编辑完整 HTML/CSS，右侧实时预览；源码编辑器自动保存，没有 Save 按钮：停止输入后稍等片刻即保存，状态会显示 **Editing…**、**Saving…** 或 **Auto-save on**，**Ctrl/Cmd+S** 立即保存；**Done**、**×** 或 **Esc** 关闭前会先写入未保存的修改，保存失败时编辑器保持打开以便重试；
- 编辑模式下脚本禁用；预览模式使用带脚本、无同源的沙箱。

## Canvas 页面

块类型：HTML、文本、Markdown、代码、图片、形状、原生手绘（freehand）、曲线（curve）、箭头（arrow）。左侧 **Curve (C)** 工具可拖出平滑的三次贝塞尔曲线；曲线使用紧包围盒，点选/移动/缩放正常，可改描边颜色、宽度和线型。选中曲线后会显示起点、终点和两个贝塞尔控制柄，直接拖动即可原位改形。形状支持矩形、椭圆、菱形、三角形、平行四边形、梯形、六边形、八边形、星形、十字、直线和 frame，可设置填充、描边、线型与圆角；左侧 **Shape** 按钮悬停时会在右侧展开按 Basic / Lines / Flowchart / Stars & Banners / Callouts / Action Buttons 分组的 60+ 个 PPT 类形状；选中矩形/polygon 后点击选择工具栏的 **Slice**，拖一条切割线即可切成两个可编辑 polygon block（撤销可恢复）。无选中 block 时，Page Inspector 的 **Components** 区域可添加 Slider 等样式关联组件，并在 Inspector 调整 label/value/min/max/accent/track/text。在气泡中点选形状后，在画布上点击/拖拽放置；点击 Shape 或按 6 也会打开同一选择器。可用 **框选**、**Shift+click** 或点击组成员多选；**Ctrl/Cmd+G** 成组、**Ctrl/Cmd+Shift+G** 解组，拖动任一选中 block 会整体移动。Markdown 支持引用块（`> 引用`）、GFM 和 LaTeX 数学公式：行内 `$E=mc^2` / `\(x^2\)`，独立公式 `$...$` / `\[...\]`，通过 KaTeX 输出 MathML，因此导出和 Present 也能正常显示。左侧 **∑ Formula** 工具或快捷键 `7` 可插入独立 LaTeX block，双击或 **Edit formula** 打开源码 + 实时公式编辑器。图片可从文件夹直接拖入 Canvas/Infinite 页，或从剪贴板粘贴；侧边栏的图片插入按钮已移除，已有图片仍可在 Inspector 改 URL。形状选中后有 8 个角/边缩放手柄；直线则只有两个端点手柄，可自由拖动任一端改变方向和长度；拖动标签可移动，双击形状可直接编辑居中文字，Inspector 可改字体/字号/颜色；拖动时会显示并吸附到其他 block 或页面中心的智能参考线。转换后的 Excalidraw frame 会记录子元素 `frameId`，拖动 frame 时子元素跟随。**Arrow (A)** 落在 shape/text/image/frame 上时会自动绑定两端（`startBinding` / `endBinding`），移动或缩放被绑定元素时箭头端点自动跟随；文字 block 选中后可拖 block 本体，也可拖上方的小 **label 把手** 移动；双击就地编辑，`Esc` 结束。block 重叠时 **Alt+click** 会在叠放层之间循环选择。Infinite 页选择插入类型（HTML/Text/Markdown/Code/Shape）后进入 **click-to-place**：下一次点击画布才在该位置创建 block；坐标无边界，负 x/y 也有效，frame 不裁剪/限制 block，可在 Inspector 里 **Dissolve frame** 保留子元素。**Pen (P)** / **Arrow (A)** / **Eraser (E)** 可直接绘制、擦除原生矢量；手绘会平滑成 path，数据以 block points 存在 JSON 中，可缩放、改线色/线宽。**Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** 撤销重做 block 编辑，**Ctrl/Cmd+C/V** 复制粘贴选中 block。新画板请使用 Infinite。拖拽遵循主流画布/PPT 习惯：移动时按 **Shift** 锁定主方向，**Ctrl/Cmd+拖拽** 复制一份；缩放时按 **Shift** 保持宽高比，按 **Ctrl/Cmd** 从中心缩放。选中 block 后会出现旋转手柄，固定在旋转后选择框上方的屏幕间距；拖动时显示中心基准点和实时角度，按 **Shift** 吸附 15°，按 **Esc** 取消；旋转后的缩放沿 block 自身坐标轴进行。右键 Transform 区域可旋转 90° 和 **水平/垂直镜像**。

在画布中选中 block 后，顶部浮动工具栏会出现 **Opacity**、**Color**、取色器；选中图片还会出现 **Cutout**。Opacity 是 0–100% 的实时样式控制，可一键恢复 100%。图片内置 **Remove image background** 抠图：右键图片或点 Cutout，调整背景容差和软边，在棋盘格上预览透明结果后应用为新的 PNG data URL。抠图会采样边缘背景色，适合纯色背景；跨域图片需要先本地化上传。右键 block 可打开编辑菜单：Edit、Duplicate、上移一层 / 下移一层 / 置顶 / 置底、Change color、Stroke color、屏幕取色、Solid/Dashed/Dotted 线型和 Delete。线型会写入原生 `strokeStyle`，对形状、曲线、手绘和箭头生效，并支持撤销。颜色与层级都写回原生 blo... (line truncated to 2000 chars)

右侧 **Layers** 是用户图层树：新页面默认有一个包含所有元素的 **Default layer**；用 **+** 新建图层，用 **−** 删除非默认图层（确认后连同内容删除），双击图层名重命名，点击图层头设为新元素的活动图层。每层有显示/锁定开关；隐藏层不会出现在编辑、导出和 Present 中，锁定层不能选中或填充。拖动图层头可调整层序，也可以把元素拖到其他图层；图层顺序和层内 `z` 都支持撤销/重做。**Color** 支持纯色填充，同一面板的 **Fill / gradient** 可给形状和闭合曲线应用线性渐变；工具栏 **▣ Fill** 可直接在画布上填充闭合形状/路径，右键 **Fill / gradient…** 也可。渐变通过原生 SVG 渲染，并用于 Present/导出。

页面支持 slide 16:9、A4、海报 4:5、方形和自定义尺寸。提供全屏 Present 模式，导出 HTML/PDF/PNG（使用本机 Chrome/Edge/Chromium）。PPTX/母版等后续扩展。

## Markdown 文档页

**Markdown** 页是一整页 A4 文档，不是 Markdown block。用 **+ Page → Markdown · A4** 新建；页面通过 `markdownPageHtml` 渲染，正文可直接编辑：点击文字即可按富文本编辑，修改会通过带 revision 校验的 `set_page_markdown` 操作自动保存。右键 **Pages** 面板中的页面，或右键渲染文档的空白区域，选择 **Edit Markdown source**，即可在带实时预览的全屏源码工作区编辑 Markdown。源码工作区自动保存：没有 Save 按钮，按 **Done**、**×** 或 **Esc** 时会先写入待保存的修改，**Ctrl/Cmd+S** 立即保存；每次保存都会重新生成 Present/PDF/PPTX/HTML 导出使用的 HTML 快照，Markdown 源保存在 `page.markdown`。

富文本模式下可直接输入 Markdown 快捷语法：`# `、`## `、`### ` 生成标题；`- ` / `* ` 生成无序列表；`1. ` 生成有序列表；`> ` 生成引用；输入围栏代码标记生成代码块；`---` 生成分隔线。在块首输入 `/` 打开斜杠命令菜单（Text、标题、列表、代码、引用、分隔线、链接、任务列表、表格、高亮和 formula），支持方向键/Enter 和 Escape。

Markdown 页右上角有 **?** 帮助按钮：首次进入会自动弹出简短的编辑帮助（说明点击文字可直接编辑、右键打开 Markdown 源码），可 **Dismiss** 或 **Don't show again**；之后仍可点 **?** 重新打开。

点击 Markdown 页中的行内或独立公式，会在公式旁打开小型 LaTeX 编辑浮层并实时预览：**Enter** 应用、**Esc** 取消、清空输入会删除该公式，点击浮层外部也会应用修改。

## 无限画布与工具栏

新增页面时选择 **Infinite canvas**（演示文档里也有 Infinite canvas 页）。没有页面边界：用 Hand 工具、按住 Space、中键拖动或双指触控板滑动平移；捏合或 Ctrl/Cmd+滚轮在指针位置缩放；Shift+滚轮横向平移。块可以放在任意位置。左侧工具栏可切换选择/抓手、插入 HTML/文本/Markdown/代码/图片/形状、切换点阵网格与 8px 吸附、查看快捷键。选中块后顶部出现浮动操作条（编辑、复制、置顶/置底、对齐、删除）。导出会按内容边界裁剪无限画布，Present 会按内容边界适配。撤销/重做会被串行化：拖动、缩放、文字编辑、HTML 元素 patch、分组、页面排序和换形状都记录正确 inverse；连续快速 Ctrl/Cmd+Z 会排队逐步回退。

## 演示工作流

- **画布尺寸**：新建时可选择 Canvas · 16:9、A4、4:5、1:1、16:9 wide、Infinite 或 HTML page；用途由尺寸和内容决定，不再区分 Slide / Résumé 页面类型。
- **Speaker notes**：在 Inspector 编辑每页备注；Present 模式有 Notes 开关，PPTX 导出会写入 notes。
- **Present**：全屏演示并支持 speaker notes。文档型页面使用专门的阅读布局而不是整页缩放：Markdown 页进入 **Markdown · reading view**，以居中的阅读栏自然滚动；HTML 页进入 **HTML · interactive view**，按响应式视口展示并保留脚本与页面滚动。这两类页面中滚轮用于滚动文档、不会翻页，点击也会与页面交互。Canvas 页整页适配，Infinite 页按内容边界适配。用 **←/→** 或 **PageUp/PageDown** 翻页、**Esc** 退出；在幻灯片式页面（Canvas、Infinite）上仍可单击屏幕或滚轮翻页。右键菜单提供上一页/下一页/激光笔/备注/退出，按 **L** 切换激光笔。
- **PowerPoint 导出**：`hcanvas export <doc> --format pptx` 生成 16:9 PPTX，一页一张 slide，并带 speaker notes。
  - **Canvas 页面**（文本/形状/图片块，不含 HTML 块）会导出为**可编辑的 PowerPoint 文本框和形状**；
  - `format=pptx-editable` 还会用真实浏览器布局数据，把 HTML 标题、段落、列表、内联标签和卡片背景映射为原生 PowerPoint 文本框/形状；无文本可提取的页面回退为图片；
  - HTML、Infinite 页在默认视觉 deck 中以高保真整页图片嵌入；
  - 在 **+ Page** 创建 **Canvas · 16:9** 页面，添加文本/形状 blocks 即可导出可编辑 PowerPoint；
  
## 文档、简历与海报

使用通用的 **Canvas · A4** 做文档/简历，**Canvas · 4:5** 做海报。它们就是普通 canvas 页面：添加文本/形状/图片 blocks、直接编辑，然后导出。用途由画布尺寸和内容决定，不再有独立的“简历”或“幻灯片”页面类型。

- **PDF / PNG / HTML**：通过本地浏览器按 A4/海报尺寸矢量打印；
- **Print PDF**：Export → **Print PDF · 3mm bleed**（或 `--format pdf --bleed-mm 3 --crop-marks`）增加 3mm 出血和 slug 区裁切标记；输出为 RGB PDF，不做 CMYK 转换。
- **DOCX（ATS）**：语义 HTML 页或 HTML-page 文档可导出 `format=docx`（UI：**Word résumé (.docx)**）。导出器遍历语义 HTML（标题、段落、列表），生成单栏 A4 Word 文档，文字可选，适合 ATS 投递；单栏纯文本布局最稳妥；
- **PPTX**：简历/海报页也可以作为整页 slide 放进 PPTX deck。

## 页面母版

任意页面（HTML、Canvas、Infinite）都可以保存为 **workspace 级页面母版**，作为新页面的起点复用：

- UI：Page inspector → **Save as master**；**+ Page** → **My page masters** 显示 HTML/Canvas 母版实时缩略图，并提供 **Use** / **Delete** 操作。
- CLI：
```bash
hcanvas masters save <doc> --page <pageId> --name "Title slide"
hcanvas masters list
hcanvas masters apply <masterId> <doc> --base-revision <rev>
hcanvas masters delete <masterId>
```

母版存储在 `<workspace>/masters.json`；应用母版会创建新页，重新生成 page/block ID，并保留原 mode、尺寸、背景、HTML/blocks/scene 与 speaker notes。之后编辑新页面不会改动母版。

## Excalidraw 场景导入/导出

hcanvas 可以把 `.excalidraw` 文件作为原生 Infinite 页导入，也可以把 Canvas/Infinite 页反向导出为 `.excalidraw`。这是兼容性桥接。

```bash
hcanvas import-scene ./board.excalidraw <doc> --title "Imported board"
hcanvas export-scene <doc> --page <infinitePageId> --out ./exports/board.excalidraw
```

Infinite 页顶栏也提供 **Export → Excalidraw scene**。暂时没有原生对应物的元素会被跳过，并在页面 notes 中报告。

### 多 Agent 实时 Presence

每个 agent 创建一个 session 并心跳；hcanvas 在顶栏以头像显示在线 agent：

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

Agent 是外部客户端：Hcanvas 没有内置的 Agent/Copilot 面板。Agent 使用下面的 JSON-first CLI/HTTP 协议；在线 session 仍以头像显示在顶栏，`hcanvas context --json` 提供当前文档/页面/revision。不硬编码任何厂商的 agent 名称；10 分钟无心跳会显示为 stale。

当前页有 session 的 agent 会显示为画布内的彩色光标。Canvas/Infinite 页锚定到 block；HTML 页会测量真实渲染布局，锚定到上报的 `data-hc-id` 元素。点击光标即可 **follow** 该 agent：hcanvas 会切换到它的文档/页面并选中它上报的 block 或 HTML 元素。

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

### 面向 Agent 的紧凑读取与检查

创作时优先使用紧凑视图，而不是原始 DOM：

```bash
hcanvas read <doc> --format layout --page <pageId> --limit 80
hcanvas lint <doc> --page <pageId>
hcanvas schema scene|ops|layout
```

`layout` 返回页面尺寸、block 边界、短文本预览、可编辑的 HTML/SVG target，并限制返回数量；它会过滤 KaTeX/MathML 内部节点和 SVG 几何细节，Agent 不需要读取完整源码就能找到目标标签。`lint` 会报告 `text-overflow`、`block-overlap`、`block-outside-page`、`empty-page` 和包含关系提示，不需要先导出截图。

### 用 compose 代替手算坐标

`compose` 接收高层场景并自动计算位置、尺寸、样式和 ID：

```json
{
  "title": "Maxwell 方程",
  "pages": [{
    "name": "封面",
    "layout": "stack",
    "padding": 64,
    "gap": 24,
    "blocks": [
      { "type": "heading", "level": 1, "text": "经典 Maxwell 方程组" },
      { "type": "paragraph", "text": "电磁学的四条基本方程。" },
      { "type": "divider" },
      { "type": "markdown", "markdown": "## 四条方程\n\n- 电的高斯定律\n- 磁的高斯定律" }
    ]
  }]
}
```

```bash
hcanvas compose deck.json --dry-run                 # 查看自动布局结果
hcanvas compose deck.json --title "Maxwell 方程"     # 创建新文档
hcanvas compose extra.json <doc> --base-revision 7  # 追加页面到现有文档
```

布局支持 `stack`（默认）、带 `columns`/`span` 的 `grid`，以及显式 `x/y/w/h` 的 `free`。block 类型包括 heading、text、paragraph、caption、markdown、code、math/formula、image、shape、html、spacer、divider。`autoHeight` 可让页面高度跟随内容。

请优先从 Page Inspector 的 **Canvas ID** / **Page ID** 复制按钮，或右键侧边栏中的画布/页面，获取要交给 Agent 的文档或页面 ID。

寻址顺序：显式 id/标题/`hcanvas://doc/<id>` → `HCANVAS_DOC`/session context → 工作区唯一文档 → 否则返回候选让 agent 询问。写操作必须带 `--base-revision`，过期 revision 返回退出码 2 和最新 revision。session 通过 `HCANVAS_SESSION` 绑定文档/页面/选中项。

### 上下文、检索与更安全的写回

```bash
hcanvas context --brief
hcanvas docs list --query maxwell --recent --limit 5
hcanvas apply <doc> --ops-file ops.json --base-revision 7 --compact --idempotency-key add-cover-v1
```

- `context --brief` 只返回当前上下文和最近更新的 5 篇文档。
- `docs list` 支持按 id/标题过滤、按最近更新排序并限制数量。
- `--compact` 返回 revision、页面摘要和创建/更新/删除的 ID，而不是整份文档。
- `--idempotency-key` 让重试安全：重复提交相同请求会返回缓存结果；相同 key 提交不同 payload 会返回冲突。
- 错误会带机器可读的 `code` 和可操作的 `hint`；revision 过期时会附带最新 revision，Agent 可以重新读取后重试。

### 模板、自动字号、箭头和图片

```bash
hcanvas template list
hcanvas compose --template cover --title "Quarterly review"
hcanvas assets upload ./logo.png
```

- 内置模板：`cover`、`section`、`two-column`、`quote`、`agenda`。
- 在 text/markdown/code block 上设置 `autoFit: true` 会自动缩小字号直到适配文本框。
- 设置 `type: "arrow"`、`from`/`to` 指向显式 block ID，并可设置 `route: "orthogonal"`；compose 会计算 points、bounds 和起止绑定。
- `image.srcFile` 会先上传本地图片，再替换为素材 URL；`hcanvas assets list|upload|delete` 可直接管理素材库。

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

桌面窗口与 Agent 集成使用同一套本地 HTTP API：`/api/state`、`/api/docs`、`/api/docs/:id/read|apply|proposals`、`/api/export`、`/api/events`（SSE）；请求需 `x-hcanvas-token`，默认仅监听 localhost。

## 修订历史

右侧 **History** Tab 按从新到旧列出已保存的 revision：**rN**、可读的编辑摘要（例如 **Edit Markdown**、**Add shape**、**Rename page** 或 **Restore revision 4**）、操作者和相对时间，当前 revision 标记为 **Current**。**Filter edits…** 会按摘要、操作者或 revision 号过滤，并显示匹配数量；**↑/↓** 在列表中移动，**↻** 刷新列表。

选中某个 revision 会显示该快照的只读页面预览（可在预览上方切换页面）和差异。对比按钮在 **This edit**（与上一个 revision 对比）和 **Vs current**（与当前文档对比）之间切换；新增/删除的页面会明确标出，未变化内容会折叠，初始 revision 会提示没有更早版本可对比。HTML/Markdown 页按行 diff，Canvas/Infinite 页按 block 摘要 diff。

**Restore** 会把选中快照作为**新的 revision** 应用，不会改写历史，因此当前文档和之后的所有 revision 都保留。当前 revision 的 Restore 按钮不可用，确认框会提示将创建新 revision。快照存放在 workspace 的 `history/<docId>/` 目录（项目 workspace 中即 `.hcanvas/history/<docId>/`），每个文档最多保留最近 120 个 revision。

## 安全

- 本地服务 + 每进程 token，`daemon.json` 供 CLI 发现；
- 编辑 iframe 无脚本 + same-origin，预览 iframe 有脚本 + 无 same-origin；
- 无远程 CDN，UI/编辑器本地打包；
- 写操作按文档串行、revision CAS、记录历史。

## 限制

- 每个桌面窗口显示一个 workspace；桌面应用可以为每个项目打开各自的窗口；暂不支持多用户 CRDT；
- 可视化编辑聚焦文字/样式，结构修改走源码；
- 视觉 PPTX 中 HTML 页仍为整页图片；可编辑 deck 会把 HTML 文本映射为原生 PowerPoint 对象（布局为近似，复杂 CSS 效果不重建）。
- DOCX 导出刻意走 text-first/ATS 路线，不复刻视觉卡片和装饰图形。

## 项目 Workspace

选定项目目录后，hcanvas 可以初始化它；所有产品数据都放在 `<project>/.hcanvas`：

```bash
hcanvas workspace init ~/projects/my-deck
hcanvas projects list
hcanvas desktop --project ~/projects/my-deck
```

顶部 **Projects** 按钮会打开全屏**项目管理页**，数据来自配置的数据目录中的全局注册表（默认 `~/.hcanvas/projects.json`）。当前数据位置在 **Project Hub → 设置 → 通用** 中查看和修改。该设置保存在应用配置目录（Windows 为 `%APPDATA%\Hadamard Canvas\hcanvas-settings.json`），不在安装目录内，所以重装或升级不会重置。修改时若目标目录为空会复制现有数据，旧目录会保留作为安全副本，并提供 **Restart now**。画布页顶栏的 **Open folder** 会打开当前项目根目录；Page Inspector 的 **Open page files** 会打开文档 JSON 所在的 `<workspace>/docs`。项目卡片中，**📁 Open folder** 可在系统文件管理器中打开项目文件夹（Workspace 对话框里也有同样按钮）。桌面版点击项目会打开一个**独立窗口**（可同时打开多个项目）；**New Project…** 通过原生目录选择创建/打开 `<project>/.hcanvas`。点击当前项目卡片返回画布。点击左下角 workspace 路径会打开 Workspace 对话框，显示当前路径、生成的 CLI 指南，并可一键复制。初始化不破坏现有文件，会创建：

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
<workspace>/history/<docId>/   # revision 快照（最多最近 120 个）
<workspace>/daemon.json         # 本地服务 URL + token
<workspace>/exports/            # HTML/PDF/PNG/PPTX/DOCX 输出
```

文档使用 JSON schema `hadamard-canvas/1`：HTML 页把完整源码存在 `page.html`；Canvas/Infinite 页存 `page.blocks`。未选择项目时，桌面应用回退到配置的数据目录（默认 `~/.hcanvas`）；`--workspace <dir>` 仍可直接指定 store 根目录，推荐使用项目化模式 `--project <dir>`。


## 自动布局与智能连线

Canvas 页面的选中工具栏现在提供布局与连线工具。选中两个及以上 block 后，在 **Auto layout** 菜单里可以：

- **Stack**：纵向对齐，保持统一间距。
- **Row**：横向对齐。
- **Grid · 2 / Grid · 3**：按等宽列排成网格。
- **Distribute H / Distribute V**：让所选 block 之间的间距相等。
- **Frame · Stack / Frame · Grid 2**：在选中 frame 的边界内排列其子 block。

自动布局带有过渡动画，并且是一次可撤销的普通编辑。文本 block 在文字或宽度变化时会自动增高，避免内容被悄悄裁掉。

选中箭头后，Inspector 会显示 **Route**、**Start anchor**、**End anchor** 和 **Label**：

- **Straight**：直线连接。
- **Orthogonal**：直角折线，并尽量避开其他 block。
- **Anchor**：自动选择，或固定到 block 的上/右/下/左/中心。
- 箭头仍绑定源/目标 block；移动或缩放 block 时，关联箭头会自动重路由。

同一个菜单还提供 **Theme · Neon / Paper / Mono** 主题预设、**Save component / Insert component** 可复用选区组件，以及 **Check layout** 页面检查（越界、重叠、可能的文字溢出）。frame 尺寸变化时子 block 会自动重排，布局变化带有短过渡动画。

## 侧栏多选与操作

左侧导航中的 **画布**、**页面**、**资源** 支持多选：**Ctrl/Cmd+单击** 切换选中项，**Shift+单击** 选择范围，**Delete/Backspace** 删除选中项。右键行可 **复制** 或 **删除**，操作会作用于整个选区。复制画布会创建独立文档并使用新的元数据；复制页面会在原页面后插入副本；复制资源会复制文件。页面至少保留一个；删除全部画布会进入空画布状态。资源预览改为双击打开，单击用于选择。

## 工作区导航与面板

左侧边栏是单面板的 workspace 导航，分为 **Canvases**、**Pages**、**Files**、**Assets**、**Plugins** 五个区块。点击区块图标切换面板，按 **Ctrl/Cmd+B** 显示/隐藏整个导航；当前区块会按 Hcanvas 配置记住。**Canvases** 和 **Pages** 会显示条目数量，**Plugins** 区块可在不离开当前文档的情况下打开插件管理器与 Gallery。

同一时间只显示一个区块。焦点在区块 Tab 上时，**←/→/↑/↓** 切换区块，**Home/End** 跳到第一个/最后一个区块；**↑/↓** 在当前面板的条目之间浏览，**Enter** 打开焦点条目，**F2** 重命名页面。**Ctrl/Cmd+F** 聚焦面板过滤器；过滤器（占位符 **Find a canvas…** / **Find a page…**）按名称实时过滤并显示匹配数量，**Esc** 清空；**Canvases** 和 **Pages** 分别记住自己的过滤文本。Files 不会持续监听文件系统：外部新增/删除文件后，点 Files 标题栏的 **↻** 手动刷新，或等窗口重新获得焦点时自动刷新。Assets 中点击图片/视频行可先预览，再点 Insert 或拖拽插入页面。

### 工作区标签页

画布和文件都会在上方的标签栏中打开。每个标签都有 **×** 关闭按钮，也可以中键单击标签关闭；关闭画布标签只会关闭标签，不会删除页面；关闭最后一个标签会显示空工作区，再次从 **Pages** 打开该页面会重新打开标签。点击文件标签则从画布切换到文件查看器。

左侧导航和右侧检查器都可以拖拽内侧分隔条调整宽度，双击分隔条可收起面板；顶栏的 ▤ / ▥ 按钮分别切换左右侧边栏，**Ctrl/Cmd+B** 切换左侧导航，宽度和收起状态保存在浏览器本地。

右侧有四个 Tab：

- **Inspector**：页面/block 属性、布局、样式、分组、历史与导出入口。
- **Layers**：页面的用户图层树（新建、重命名、排序、显示/锁定）。
- **Proposals**：Agent 提交的修改提案审核队列；接受或拒绝后才会写入文档。
- **History**：revision 列表、只读预览、diff 对比与恢复（见「修订历史」）。



## 语言

打开 **Project Hub → 设置 → 通用**，在 **界面语言** 中选择 **English / 中文**。设置保存在应用配置目录的 `hcanvas-settings.json` 中，跨项目、窗口和升级共享。切换后界面、Inspector、弹窗、快捷键、历史、插件管理器和 toast 都会使用对应语言；文档内容（页面文字、HTML、文件名）不会被机器翻译。桌面窗口会按保存的语言启动，项目页面始终提供语言选择器。


## 取色器

Inspector 中的颜色（文字颜色、填充、描边和页面背景）不再打开系统原生颜色对话框，而是打开内联取色器。拖动明度/饱和度区域或色相滑条时画布会**实时变化**，关闭取色器时才作为一次修订提交。面板显示 HEX、RGB 和颜色名称；支持 EyeDropper API 的 Chromium 版本还提供屏幕取色按钮。

## 字体

Hcanvas 内置 **Inter**、**Source Serif 4**、**JetBrains Mono** 三个可变 WOFF2 字体，并提供系统 **Georgia**、**System UI**、**微软雅黑**、**宋体** 选项。选中文本、形状或 Markdown block 后，Inspector 会出现 **Font** 下拉框，选择结果以 CSS font-family 栈保存在 block 上。HTML 页/block 仍可使用任意 CSS 字体；Canvas 渲染可直接使用内置字体。独立 HTML/PDF/PNG 导出会内嵌内置字体，PPTX 会把内置字体映射到 Arial/Georgia/Consolas，保证目标机器没有这些字体时仍可读。中文会回退到系统 CJK 字体。

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

### 插件 Studio

打开 **Plugins → Manage → New plugin**，或点击已安装插件旁的 **Edit**，即可在应用内打开 **Plugin Studio**。它本质上是一个带校验和实时预览的 manifest 编辑器：

- 编辑 block 标签、字段、默认值、HTML 模板和页面模板。
- **Validate** 使用与安装时相同的服务端校验器检查 manifest。
- **Preview** 用默认字段值渲染第一个 block。
- **Save & Reload** 把 manifest 写入 `<project>/.hcanvas/plugins/<id>/manifest.json`，并立即重新加载。
- **Duplicate** 生成一个新 id 供你继续改；用户级插件只读，但可以复制到项目。
- **Export** 下载 manifest；项目插件可以在 Studio 或管理器中删除。

### 插件动作

插件 block 可以暴露按钮，执行安全的声明式画布操作。给 block 增加 `actions` 数组：

```json
{
  "type": "my-card",
  "label": "My card",
  "render": "<div>{{title}}</div>",
  "actions": [
    { "id": "reset", "label": "Reset", "kind": "set-data", "data": { "title": "Hello" } },
    { "id": "accent", "label": "Accent", "kind": "apply-style", "style": { "color": "#0f766e" } },
    { "id": "insert", "label": "Insert another", "kind": "insert-block", "blockType": "my-card", "text": "More" }
  ]
}
```

支持的动作类型：`set-data`（合并 block data）、`apply-style`（合并 block style）、`insert-block`（在当前页面插入 block）和 `add-page-preset`（使用插件页面模板添加页面）。动作仍然走正常画布操作路径，因此可撤销、受 revision 校验；不会执行任意 JavaScript、iframe、事件属性或 `javascript:` URL。

### 沙箱 JavaScript 动作

需要更复杂逻辑时，插件可以显式启用 Worker 沙箱：

```json
{
  "runtime": "sandbox",
  "script": "self.hcanvas.register({ actions: { bump(ctx) { const n = Number(ctx.block.data.count || 0) + 1; return [{ kind: 'set-data', data: { count: n } }]; } } });",
  "blocks": [{
    "type": "counter-card",
    "label": "Counter",
    "render": "<div>{{count}}</div>",
    "defaultData": { "count": 0 },
    "actions": [{ "id": "bump", "label": "Bump", "kind": "script" }]
  }]
}
```

脚本运行在 Web Worker 中，不在画布 DOM 里。它接收 `ctx.action`、`ctx.block` 和 `ctx.page`，返回允许的效果数组：`set-data`、`apply-style`、`insert-block` 或 `add-page-preset`。宿主会校验每个效果、通过正常画布操作执行，并强制 5 秒超时。Plugin Studio 的 **Sandbox template** 按钮可以插入起始脚本和脚本动作。Worker 是崩溃隔离和 DOM 隔离边界，不是强安全边界；只安装你信任的沙箱插件。

### 插件形状

插件可以向形状选择器贡献原生形状。在 manifest 里增加 `shapes` 数组：

```json
{
  "shapes": [{
    "id": "blob-badge",
    "label": "Blob badge",
    "hint": "用于状态标签的柔和徽章",
    "category": "Custom",
    "paths": [
      "M50,3 C88,3 98,42 50,97 C2,42 12,3 50,3 Z",
      "M50,20 C68,20 78,46 50,80 C22,46 32,20 50,20 Z"
    ]
  }]
}
```

路径使用 `0 0 100 100` viewBox。Hcanvas 会用 SVG path 字符白名单校验，注册到 **Custom** 分类，并用 block 正常的 fill、stroke、opacity 和渐变设置渲染。插件形状可用于 Canvas block、走 Canvas 渲染的 HTML/PNG/PDF 导出路径、Present 和形状选择器。一个插件可以同时贡献 block、形状和页面模板。
### 可信 iframe block

需要 DOM、WebGL 或第三方 UI 库时，block 可以显式启用隔离 iframe：

```json
{
  "type": "leaflet-map",
  "label": "Leaflet map",
  "runtime": "iframe",
  "render": "<div id=\"map\"></div><script src=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js\"></script><script>/* map code */</script>"
}
```

iframe block 使用 `sandbox="allow-scripts"` 渲染，不能读取 Hcanvas 主 DOM。模板数据通过 `window.hcPluginData` 提供。双击 block 进入交互模式，按 Escape 回到画布编辑。这是交互地图、图表和其他可信 DOM 插件的支持路径。示例见 [Leaflet map 示例](https://github.com/DeconBear/hadamard/blob/main/examples/hcanvas-plugins/leaflet-map/manifest.json)。

### 插件宿主

每个已加载的 manifest 都会进入客户端插件宿主索引。宿主记录 block 类型、形状、页面模板、运行时能力（`declarative`、`sandbox`、`iframe`）和启用状态；Plugins 管理器会显示宿主摘要。这个宿主是后续 panel、renderer 和 importer 扩展点的基础。
### 外部渲染器

iframe 插件可以调用受信任的本地渲染服务，而不把宿主进程能力暴露给沙箱。在 manifest 中声明 renderer：

```json
{
  "renderers": [{
    "id": "manim",
    "label": "Manim renderer",
    "kind": "http",
    "endpoint": "http://127.0.0.1:8765/render"
  }]
}
```

在 iframe block 内调用 `window.hcRequestRenderer("manim", { scene: source })`。Hcanvas 会把请求转发给宿主，以 JSON POST 方式调用 endpoint，60 秒超时，并把 JSON/文本结果返回给同一个 iframe。渲染服务自己负责进程隔离、白名单和产物文件。跨域 endpoint 需要支持浏览器 CORS。这就是 Manim 这类工具的安全桥接方式：Hcanvas 不直接执行 Python，由受信任的渲染服务执行。
### 组件与插件块

**插件块**是带 manifest 字段的声明式 HTML 模板，可渲染自定义卡片并通过字段编辑，但不会执行 JavaScript。**组件**是标记了 `component: true` 的插件，会出现在 Inspector 的 Components 区域而不是普通块选择器。内置的 **Slider** 组件在画布上可交互：拖动滑轨或点击位置即可改变数值；数值保存在 `block.data.value` 中，并同步到 Inspector 和导出结果。其他插件块/组件目前仍是声明式静态内容，暂无自定义交互。

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

## 扩展平台（v2）

Hcanvas 除旧版声明式插件块外，还提供沙箱化扩展平台（manifest schema `hcanvas-extension/1`）。扩展是一个带 `manifest.json` 的目录，可贡献 file viewer、工作区标签页、命令、sidecar 进程、语言 kernel、可执行代码块和自定义页面格式；旧版 `plugins/` 插件继续兼容。

### 安装位置

| 作用域 | 目录 |
| --- | --- |
| 工作区 | `<workspace>/extensions/<id>/manifest.json` |
| 用户 | `~/.hadamard/hcanvas/extensions/<id>/manifest.json` |
| 内置 | 随应用发布的一等扩展（如 notebook viewer） |
| 旧版 v1 插件 | `<workspace>/plugins`、`~/.hadamard/hcanvas/plugins` |

项目工作区的数据目录是 `.hcanvas`，工作区扩展位于 `.hcanvas/extensions/`。在 **插件 → 扩展** 中启用/禁用、信任、查看诊断，或安装文件夹、打开一等示例 Gallery。声明了进程能力的扩展默认未信任；信任决定记录在工作区 `extensions.json`。

### 信任与能力

扩展在 `capabilities` 中声明所需能力，且只能使用被授予的界面：

- `document`：通过宿主读取/提交文档操作。
- `workspace`：按工作区相对白名单读写文件。
- `network`：通过宿主代理访问白名单主机；viewer 不能直接跨域联网。
- `process`：启动声明的 sidecar/终端、使用用户工具。
- `commands`、`menus`、`keybindings`、`configuration`：UI 贡献。

信任确认框会先列出扩展声明的能力、sidecar 命令、kernel 与网络白名单。扩展管理器还提供工作区 **受限模式（Restricted Mode）** 开关，以及在源码仓库运行时可见的一等示例 **Gallery**。受限模式会在工作区级别阻止 sidecar、kernel 与进程型命令，不受单个扩展信任状态影响。扩展代码不会进入 Node/Electron 主进程：

- iframe viewer 运行在不透明源沙箱（`sandbox="allow-scripts"`，无 `allow-same-origin`），CSP 只允许宿主提供的资源。
- sidecar 是独立进程，使用 argv 数组启动（`shell: false`）、环境变量过滤、受监督的生命周期。
- 声明式 canvas block 不执行 JavaScript。

### Manifest

```json
{
  "schema": "hcanvas-extension/1",
  "id": "com.example.json-viewer",
  "name": "JSON Viewer",
  "version": "0.1.0",
  "engines": { "hcanvas": ">=0.2.0" },
  "capabilities": {},
  "contributes": {
    "formats": [{ "id": "json", "label": "JSON", "extensions": [".json"], "viewer": "json.viewer", "surfaces": ["file"] }],
    "viewers": [{ "id": "json.viewer", "type": "iframe", "entry": "ui/entry.html", "surfaces": ["file"] }],
    "views": [{ "id": "json.tools", "title": "JSON tools", "slot": "workspace-tab", "viewer": "json.viewer" }],
    "commands": [{ "id": "json.open", "title": "JSON: Open tools", "category": "JSON", "exec": { "kind": "view", "viewId": "json.tools" } }]
  }
}
```

贡献类型包括 `formats`、`viewers`、`views`、`commands`、`menus`、`keybindings`、`sidecars`、`kernels`、`canvas.blocks`、`canvas.shapes`、`pagePresets`、`configuration`、`tools`、`terminals`。viewer 通过 `surfaces` 声明渲染位置：`file`、`tab`、`page`。

### File viewer

format 把扩展名映射到 viewer；从 **文件** 面板打开匹配文件时，viewer 在工作区标签页中挂载：

```html
<script src="/api/extension-sdk/hc-extension-api.js"></script>
<script>
  const hc = await HcanvasView.acquire();
  const { rootId, path } = hc.context.file;
  const { content } = await hc.files.read(rootId, path);
  document.getElementById('out').textContent = content;
</script>
```

SDK 提供 `hc.context`（`surface`/`file`/`page`）、`hc.files`（授权范围内的 read/stat/write）、`hc.document`（文档表面 read/apply ops）、`hc.commands`、`hc.config`、`hc.ui`、`hc.sidecars` 与 `hc.kernels`。viewer 普通请求 30 秒超时；sidecar 型 viewer 请求使用更长的宿主预算。网络访问必须通过 `hc.network.fetch`，并受宿主白名单限制。

### 命令与工作区视图

贡献的 `view` 以工作区标签页挂载 viewer；`command` 会出现在命令面板，`exec.kind` 支持 `view`（打开标签页）、`command`（调用宿主命令）等。示例中的 C++ 工具箱、Octave 控制台都通过这一路径打开，无需改应用外壳。

### 终端、Output 与 Problems

命令面板提供 **Terminal: Toggle terminal panel**：底部 dock 使用 xterm.js 渲染真实 PTY session，profile 选择器列出 manifest 贡献的终端（或平台默认 shell），输入转发到 PTY、尺寸同步、**Restart** 重建 session。相邻的 **Output** tab 收集 runtime 事件流中的 sidecar stderr/log，**Problems** tab 展示从 user tool 输出解析的诊断（`file:line:col: error|warning: message`）。终端与工具执行要求工作区已信任；node-pty 不可用时 dock 会明确提示。

### 用户工具

manifest 通过 `contributes.tools` 声明 argv-only 小工具：

```json
{
  "capabilities": { "process": { "tools": ["cpp.version"] } },
  "contributes": {
    "tools": [{ "id": "cpp.version", "label": "C++ compiler version", "command": ["g++", "--version"], "cwd": "extension", "output": "terminal" }]
  }
}
```

用 **Tools: Run a contributed tool** 运行：命令以 `shell: false` 启动、使用过滤后的环境变量、以扩展目录（或 workspace）为 cwd，并有输出上限；工作区与扩展都必须已信任。stdout/stderr 出现在底部 Output 面板，编译器风格诊断进入 Problems。C++ toolbox 示例贡献了版本工具和一个故意失败的语法检查工具用于演示该流程。

### Sidecar

Sidecar 是受监督的常驻服务，用于工具链、语言服务器与渲染器。manifest 声明可执行文件、协议与允许的请求：

```json
{
  "sidecars": [{
    "id": "cpp-runner",
    "command": ["node", "sidecar/cpp_runner.mjs"],
    "cwd": "extension",
    "role": "service",
    "protocol": "jsonrpc-stdio",
    "requests": [{ "method": "run", "timeoutMs": 120000 }],
    "limits": { "maxStdoutBytes": 4194304, "maxStderrBytes": 1048576 }
  }]
}
```

支持 stdio 上的 JSON-RPC 2.0（LSP `Content-Length` 帧）以及声明的行协议。宿主只在信任后启动 sidecar，并负责 stdout/stderr 上限、请求超时、shutdown 握手与进程树终止。viewer 用 `hc.sidecars.request(sidecarId, method, params)` 调用，接收 `onOutput`、`onProgress` 与 `done`。

示例：[C++ Toolbox](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/cpp-toolbox)、[GNU Octave Console](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/octave-console)。

### Kernel 与可执行代码块

kernel 贡献描述语言与实现 Hcanvas kernel 协议（HKP）的 sidecar 命令：在同一 stdio 帧协议上处理 `initialize`、`execute`、`interrupt`、`shutdown`。画布 `exec` block 与文件/页面 notebook 按作用域（文档、文件或页面）共享 kernel session，流式输出 stdout/stderr/display MIME，并把最近一次输出持久化到文档或 notebook 缓存。

- **Cell: Insert code cell**：在画布页面插入可执行单元格。
- **Cell: Run all code cells**：按顺序运行页面上的所有单元格。
- Python kernel 示例是真正的持久 kernel，支持全局变量、`hc_display(...)`、matplotlib 图形和结构化 traceback：[python-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/python-kernel)。
- C++ kernel 示例用 g++/clang++ 编译每个 cell 并流式返回编译/运行输出；没有 `int main` 的代码会被包进 main()；C++ cell 之间不保留变量：[cpp-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/cpp-kernel)。
- GNU Octave kernel 示例保持一个交互式 Octave 进程存活，变量可跨 canvas cell 与 notebook cell 持久；文本流式输出，新建图形自动捕获为 PNG：[octave-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/octave-kernel)。Interrupt/restart 会重置 Octave 状态。
- **Notebook 页面**从 **页面 → 添加页面 → Notebook** 创建。每个 code cell 可独立选择内核（Python、GNU Octave、C++ 等）；Markdown 直接在渲染后的正文中编辑，不带单元格边框，也没有单独的编辑模式——点击文字即可输入，Ctrl/Cmd+B/I/U 可格式化，失焦/自动保存时会把 HTML 转回 Markdown。支持 GFM（标题、列表、表格、任务列表、代码块、链接/图片）与 KaTeX 数学公式。源码、所选内核和输出都保存在 `page.extension.data`，即 workspace docs 目录中的文档 JSON（项目工作区为 `.hcanvas/docs/`），不是单独文件。内置 **Hadamard Notebook** viewer 仍兼容打开 `.hnb.md` 文件（Markdown + fenced 可执行 cell、Run/Run all/Restart、自动保存、输出缓存、HTML 导出）。
- kernel session 有作用域且可回收；中断会从协作取消升级到重启。

### 自定义页面格式

扩展 viewer 可以渲染整页。为扩展创建的页面保存 `mode: "extension"` 与 `extension: { format, data }`；viewer 声明 `page` surface，并通过 `hc.document.read()` 读取页数据。命令面板的 **Page: Add extension page** 可从已安装的 page-capable format 创建页面。

```json
{
  "formats": [{ "id": "board-page", "label": "Board page", "extensions": [".board.json"], "viewer": "board.viewer", "surfaces": ["file", "page"] }],
  "viewers": [{ "id": "board.viewer", "type": "iframe", "entry": "ui/entry.html", "surfaces": ["file", "page"] }]
}
```

扩展页会进入正常页面列表，支持撤销/重做与修订历史，但不能添加 block。内置 Notebook 页面使用该机制（format `hadamard-notebook`），cell 和输出保存在页面数据中。Present 会挂载扩展页 viewer；导出暂不支持扩展页，会给出可读提示而不是产出损坏文件。示例：[page-board](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/page-board)。

### 内置与示例扩展

| 示例 | 演示内容 |
| --- | --- |
| [svg-viewer](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/svg-viewer) | 最小沙箱 file viewer |
| [json-viewer](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/json-viewer) | 格式化文件 viewer |
| [manim-http](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/manim-http) | viewer + 宿主 renderer 桥（Manim） |
| [python-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/python-kernel) | HKP kernel、图表、输出 |
| [cpp-toolbox](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/cpp-toolbox) | sidecar 编译/运行界面 |
| [cpp-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/cpp-kernel) | cell/notebook 的 C++ 编译运行 kernel |
| [octave-console](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/octave-console) | GNU Octave sidecar REPL |
| [octave-kernel](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/octave-kernel) | Canvas cell 与 notebook 的持久 Octave kernel |
| [map-viewer](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/map-viewer) | 离线 GeoJSON 地图 viewer |
| [three-d-viewer](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/three-d-viewer) | WebGL OBJ viewer |
| [page-board](https://github.com/DeconBear/hadamard/tree/main/examples/hcanvas-extensions/page-board) | 自定义页面格式 |

把示例目录复制到 `<workspace>/extensions/`，如声明进程能力则在扩展管理器中信任，然后用命令面板或文件面板打开。旧版插件块、renderer、页面模板保持兼容，见上文各节。

### 扩展 SDK 与校验

manifest、iframe viewer、sidecar 服务的类型声明与复制模板位于 `src/hcanvas/sdk/`。安装前可先校验：

```bash
npm run build
npm run hcanvas:extension:validate -- path/to/extension/manifest.json
```

校验器与运行时使用同一 schema，并给出稳定路径的诊断。viewer 运行时 SDK 始终由宿主提供（`/api/extension-sdk/hc-extension-api.js`），不要自行打包副本。

