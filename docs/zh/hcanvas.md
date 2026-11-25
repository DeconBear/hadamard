---
title: Hcanvas 快速上手
description: 从下载到本地优先、Agent 原生的画布，只需要几分钟。
---

<div class="hc-hero">
  <div class="hc-kicker">Hadamard Canvas · v0.1.5</div>
  <h1>让页面<br /><span>成为工作空间。</span></h1>
  <p class="hc-sub">Hcanvas 是面向严肃视觉工作的本地优先画布。在这里做页面、幻灯片和图示，再让人类与 Agent 通过同一套 JSON-first 接口编辑同一份文档。</p>
  <div class="hc-actions">
    <a class="hc-btn hc-btn-primary" href="#安装">安装 Hcanvas</a>
    <a class="hc-btn" href="https://github.com/DeconBear/hadamard/releases">下载桌面版</a>
  </div>
  <div class="hc-proof">本地优先 · 人类 + Agent · HTML + Canvas + Infinite</div>
</div>

<div class="hc-shot">
  <img src="../assets/screenshots/hcanvas-canvas.png" alt="Hcanvas 工作区，包含页面检查器、画布块和 Agent 插件面板" />
  <p>同一份 Hcanvas 文档：Canvas 页面、可编辑 HTML、Markdown、代码块，以及人和 Agent 共用的检查器。</p>
</div>

## 可以做什么

<div class="hc-grid">
  <div class="hc-card"><h3>HTML 页面</h3><p>编写并直接编辑真实 HTML，在沙箱中预览；需要完全控制时打开源码编辑器。</p></div>
  <div class="hc-card"><h3>Canvas 页面</h3><p>在固定幻灯片画布上混合文本、Markdown、代码、图片、形状、公式、曲线和连接线。</p></div>
  <div class="hc-card"><h3>Infinite 图示</h3><p>无页面边界，自由缩放和平移，适合科研图谱、系统架构图和早期思考。</p></div>
  <div class="hc-card"><h3>可交付文档</h3><p>导出 HTML、PDF、PNG、视觉或可编辑 PPTX、DOCX，并支持带演讲者备注的全屏演示。</p></div>
</div>

## 安装

### 桌面版

从 [GitHub Releases](https://github.com/DeconBear/hadamard/releases) 下载对应平台的安装包：

- **Windows：**`Hadamard-Canvas-Setup-*.exe` 或便携版 `.exe`
- **macOS：**x64 与 arm64 的 `Hadamard-Canvas-*.dmg` 或 `.zip`
- **Linux：**x64 的 `Hadamard-Canvas-*.AppImage` 或 `Hadamard-Canvas-*.deb`

桌面安装包只包含 Electron 应用。如果需要终端或 Agent 命令，请另外安装 CLI。

### CLI 与 Agent 命令

~~~bash
npm install -g hadamard-canvas
hcanvas desktop --workspace ~/.hcanvas
~~~

要求 Node.js 22.13+ 或 Node.js 24。npm 包同时提供浏览器和 headless 模式：

~~~bash
hcanvas app --workspace ~/.hcanvas      # 本地服务 + 浏览器界面
hcanvas serve --workspace ~/.hcanvas --port 4319
~~~

## 10 分钟上手

<div class="hc-step"><div class="hc-step-num">1</div><div><strong>选择工作目录</strong><p>从 <code>~/.hcanvas</code> 开始，或用 <code>--project &lt;目录&gt;</code> 把演示、报告或研究项目独立管理。</p></div></div>
<div class="hc-step"><div class="hc-step-num">2</div><div><strong>创建页面</strong><p>落地页用 HTML 页面，幻灯片用 Canvas 页面，架构图用 Infinite 页面，论文用 Markdown 页面。</p></div></div>
<div class="hc-step"><div class="hc-step-num">3</div><div><strong>加入真实内容</strong><p>双击文本即可编辑；从块库添加 Markdown、代码、图片、形状、公式或组件。</p></div></div>
<div class="hc-step"><div class="hc-step-num">4</div><div><strong>让 Agent 加入</strong><p>Agent 通过 <code>hcanvas</code> 读取文档，并基于稳定 revision 写入 patch；人类编辑和 Agent 编辑共用同一份模型。</p></div></div>
<div class="hc-step"><div class="hc-step-num">5</div><div><strong>演示或导出</strong><p>全屏演示、从历史记录恢复 revision，或导出 PDF、PNG、PPTX、DOCX 交付。</p></div></div>

## 让 Agent 协作

给 Agent 文档上下文，并让它生成可审阅的小 patch。常用命令：

~~~bash
# 读取当前文档大纲
hcanvas read --format outline

# 创建新的 Canvas 文档
hcanvas docs create --title "研究同步" --preset canvas

# 基于已知 revision 应用审阅后的 patch
hcanvas apply --ops-file changes.json --base-revision 5 --actor my-agent
~~~

需要稳定目标？打开页面 Inspector 复制 **Canvas ID** / **Page ID**，或右键侧边栏中的页面使用同样的复制操作。

<div class="hc-note"><strong>用 Agent 安装？</strong>让它阅读 README 的 <a href="https://github.com/DeconBear/hadamard#quick-start-with-ai-agents">Quick start with AI Agents</a> 部分。桌面版和 CLI 是分开安装的：桌面安装包提供 GUI，<code>npm install -g hadamard-canvas</code> 提供 CLI 和桌面启动器。</div>

## 扩展与内核

Hcanvas 扩展是带 `manifest.json` 的 v2 包；内置 Notebook 和三个随应用提供的内核扩展会随安装包一起发布。从工作区的 **Extensions** 打开管理器，可以安装文件夹、按精确版本安装 npm 包、启用/禁用、授予信任或卸载：

~~~bash
hcanvas extension list
hcanvas extension install @hcanvas/kernel-python@0.1.0 --user
hcanvas extension install --folder ./my-extension --project
hcanvas extension install --tarball ./my-extension.tgz --project
hcanvas extension update @hcanvas/kernel-python@0.1.0 --user
hcanvas extension uninstall <extension-id> --user
hcanvas doctor
~~~

官方 `@hcanvas/*` 内核包的 NPM 分发仍是 **Preview**；稳定路径是随应用提供的 bundled 内核。用户级扩展位于你的 Hcanvas 数据根目录；项目级扩展位于 `.hcanvas/extensions/`。带进程能力的扩展（内核、sidecar、终端、工具）在 Restricted Mode 下默认禁用；信任工作区后仍需显式授予扩展信任。`hcanvas doctor` 会报告 Node、Python、g++、GNU Octave 与扩展兼容性。

## 设置

在桌面版或浏览器 UI 中打开 **Project Hub → 设置**。设置保存在 Hcanvas 配置目录下的 `hcanvas-settings.json`。

- **运行时**：可选填 Python、GNU Octave、C++ 编译器（`g++`/`clang++`）的绝对路径。留空表示从 `PATH` 自动检测；Windows 上 Octave 还会检查卸载注册表。可用 **Test** 验证路径，或用 **Auto-detect all** 检测本机。修改只影响新内核会话，运行中的会话保持当前解释器。
- **通用**：界面语言（English/中文）与数据位置。修改数据位置后仍需重启桌面版。
- **Notebook**：新建 Notebook 页面的默认内核、`.hnb.md` 浏览器输出缓存预算，并可清理缓存输出。
- **更新**：立即检查更新、启动时自动检查、自动下载以及 stable/preview 通道。自动安装仅桌面安装包支持；浏览器和 CLI 用户通过安装包或 npm 更新。

`hcanvas doctor` 会读取同一套运行时设置，并显示运行时来自配置路径还是自动检测。
## Notebook

从 **Pages** 新建 Notebook 页面，或从 **Files** 打开 `.hnb.md` 文件。Markdown 在连续文档中直接编辑，代码单元通过已启用的内核扩展执行。内核补全会随输入出现，也可用 **Ctrl+Space** 触发；按 **Tab** 接受选中的补全项。变量区分**初始值**与**当前值**：Initialize / Run all 应用初始值，普通运行发布当前值；共享变量可在 Python、C++、GNU Octave 内核之间流转。

`.hnb.md` 的输出缓存在当前浏览器工作区，Notebook 页面的输出保存在原生文档中。HTML 导出会内联当前可见输出（包括图片资源），可以在 Hcanvas 之外打开。不导入或导出 Jupyter `.ipynb` 文件。

## 继续探索

- [Hcanvas 完整参考](./hadamard-canvas.md)——页面类型、块、CLI 协议、插件与存储
- [扩展开发](./hcanvas-extensions.md)——npm 包结构、版本规则、信任与发布
- [npm 上的 Hcanvas](https://www.npmjs.com/package/hadamard-canvas)
- [Hadamard Harness](./hadamard-harness.md)——面向工程和科研的 agent runtime
