---
title: Hcanvas 扩展开发
description: 打包、验证并发布 Hcanvas v2 扩展。
---

# Hcanvas 扩展开发

Hcanvas 扩展是带 v2 `manifest.json` 的自包含包，可选附带本地 sidecar。稳定分发路径是 bundled/curated 扩展；官方内核的 npm 分发目前是 **Preview**。

## 包结构

```text
my-extension/
  package.json          # name、精确 version、keywords: ["hcanvas-extension"]
  manifest.json         # schema: "hcanvas-extension/1"
  README.md
  LICENSE
  dist/                 # 可选编译产物
  sidecar/              # 可选本地进程
```

npm 包版本必须与 `manifest.version` 一致；`manifest.engines.hcanvas` 必须接受当前 0.1.x 宿主（例如 `>=0.1.0`）。包会解压后本地安装；Hcanvas 不运行 npm 生命周期脚本，也不会隐式执行二次 `npm install`。

## Manifest 与权限

使用唯一扩展 ID。`hcanvas.*` 与 `com.hadamard.*` 命名空间保留给 bundled 或官方 `@hcanvas/*` 包。只声明需要的 capability：进程/sidecar、网络域名、文档访问、UI 贡献等。

带进程能力的扩展默认禁用，直到用户信任工作区并授予对应 capabilities hash。扩展版本或能力变化后需要重新授权。本地文件夹安装用于开发；对外分发使用精确 npm 版本。

## 本地验证

```bash
npm pack --dry-run
hcanvas extension install --folder ./my-extension --project
hcanvas extension list --project
hcanvas extension trust <extension-id>
hcanvas extension enable <extension-id>
hcanvas doctor
```

## 发布（Preview）

官方包使用 `@hcanvas/*` scope 和受审查的发布流程；不要手工上传未验证目录。第三方包必须自包含，且不得占用保留 ID。Hcanvas 稳定版不依赖在线 npm 可用性：安装产物中始终带有 bundled 内核。
