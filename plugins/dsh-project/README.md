# DSH 项目空间

独立的 DSH 项目管理插件：在项目首页集中查看任务看板、Issues 和文档。**不依赖 dsh-web-all 或任何第三方看板插件**。

## 使用

需要 **DSH 0.2.1-rc.2** 或兼容版本。安装后从左侧「项目管理」进入。无需配置项目路径，自动发现 DSH 工作区和正在运行的项目会话，每 5 秒更新；后台页面暂停轮询。

- **项目首页**：搜索项目、筛选运行中的项目、查看任务与运行会话数量。
- **任务看板**：与 Issues 共用项目任务数据，支持创建任务、状态流转和执行。按待规划、待开始、进行中、待验收、已完成、已阻塞、已取消排列。DSH 独立运行的会话也显示在进行中列，关联任务的会话不会重复展示。
- **Issues**：同一批任务的列表视图，支持搜索、状态筛选、分页，以及完整描述、验收标准和评论详情。
- **文档**：只读 Markdown 预览，支持根目录 Markdown、docs/、.hadamard/design/design.md、Hadamard 项目计划和笔记。原始 HTML 不执行，图片不加载，外部链接需用户点击。

创建任务只保存数据。点击「执行任务」才会通过 DSH 创建该项目的会话并发送任务说明，沿用 DSH 默认模型与权限。会话结束不自动判定成功；检查结果后移至待验收，再确认完成。运行期间请先在 DSH 中停止会话，再调整任务状态。

## 安装

```sh
cd plugins/dsh-project
npm ci
npm test
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-hadamard-project-0.3.0.tgz
```

CLI 将 web 换成实际 profile 名称。桌面版请在「插件」页面选择本地包安装上述 tgz；若提示需要重启，请在会话结束后重启 DSH。包内包含 Host 和 Web client 构建产物，安装无需 Hadamard 源码或其他看板插件。

可选 profile cordis.patch.yml 配置（通常不需要）：

```yaml
- id: hadamard-project
  config:
    homeDir: /absolute/path/to/user-home
    maxOutputBytes: 1048576
```

homeDir 默认 OS 用户主目录，亦接受 Hadamard 数据根目录。workDir 可额外指定一个绝对路径项目，不影响自动发现其他项目。

## 数据与接口

看板和 Issues 使用 Hadamard 的项目 Issues 存储，遵循项目的 home/workspace 选择。默认保存于用户目录 `.hadamard/projects/<项目标识>/issues.json`；选择 workspace 存储时保存于项目 `.hadamard/issues.json`。已有 Hadamard Issues 直接显示；第三方看板的旧任务不会自动导入。

本插件不注册模型工具、系统提示或 slash command。旧版的 hadamard_project_get、hadamard_issue_list、hadamard_issue_get 和 /project status 已移除。

界面通过 DSH Connection 认证后的 owner 路由访问 /api/hadamard-project/*。路径由服务器根据当前 DSH 项目列表解析。写入仅用于任务创建、状态流转和关联执行会话；文档只读。单个项目任务数据损坏不会阻止其他项目和文档浏览。

文档最多 200 篇、扫描 4,000 个目录项和 8 层目录；单篇最多 512 KiB，不跟随符号链接。响应默认最多 1 MiB，maxOutputBytes 可设为 1 KiB–4 MiB。

## 开发与验证

```sh
npm run typecheck
npm test
npm pack --dry-run
```

测试覆盖无第三方看板环境、旧看板共存、动态项目发现、看板与 Issues 一致性、任务写入与会话派发、跨项目隔离、认证、文档路径限制、零模型工具注册及独立安装包加载。
