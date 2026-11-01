# 启动界面（surface）与模块

Hadamard 的 GUI 不是不可拆分的单体：同一个本地运行时可以组合成不同的**启动界面（launch surface）**，可选**模块（module）**决定某个能力是否存在。

## 三种启动方式

| 命令 | Surface | 得到什么 |
|---|---|---|
| `npx hadamard-gui [work-dir]` | **full** | 主 Hadamard 应用：项目总览、会话、项目工作台，以及所有已启用模块。 |
| `npx hadamard-harness [work-dir]` | **harness** | 只启动 agent 界面：会话、transcript、输入框、模型/权限控制；没有项目总览、工作台和画布。 |
| `npx hadamard-canvas [work-dir]` | **canvas** | 只启动画布界面：Excalidraw 工作区、画布列表、Agent review 与校验面板；没有左侧导航、没有聊天。 |

三者启动同一个仅监听 localhost 的后端，读取同一份项目、会话、设置和画布文档；变化的只是应用外壳。

等价的参数/环境变量写法：

```bash
npx hadamard-gui --surface harness [work-dir]
npx hadamard-gui --surface canvas [work-dir]
HADAMARD_GUI_SURFACE=canvas npx hadamard-gui [work-dir]
```

## 模块

模块是 surface 背后的可组合能力。

| 模块 | 默认 | 负责 |
|---|---|---|
| `harness` | **开启** | agent 聊天界面：会话、输入框、模型配置、Agent monitor。 |
| `canvas` | **关闭** | Excalidraw 设计画布、`/api/canvas/*`、画布 agent 工具与会话上下文。 |

### 主应用中个性化配置

打开 **Settings → Personalization → Modules**，勾选/取消 **Harness** 与 **Canvas**。选择持久化到 `~/.hadamard/settings.json`（`modules.<id>.enabled`），运行时立即重载：

- 模块关闭 → 对应界面、工具、上下文与 HTTP 路由都不注册；
- 模块开启 → 出现在主应用里（例如项目详情的 **Canvas** 页签）；
- 主应用按**实际启用的模块**组合界面。

### 独立 surface 强制模块集合

独立启动会忽略持久化开关，保证窗口内容确定：

- `--surface harness` → harness 开启、canvas 关闭（即使设置里启用了 canvas）；
- `--surface canvas` → canvas 开启、harness 关闭（即使设置里关闭了 canvas）。

独立启动不会写回设置；之后启动 `hadamard-gui` 仍使用已保存的模块偏好。

## 示例

```bash
# 只启动 agent 界面，类似标准 coding agent
hadamard-harness ~/work/my-project

# 只启动画布，全屏 Excalidraw + Agent review
hadamard-canvas ~/work/my-project

# 主应用：聊天 + Canvas 页签（两个模块都启用）
hadamard-gui ~/work/my-project
```

## 同一份数据，不同的外壳

- 会话、项目、记忆、issues、画布都在共享的 Hadamard data root / 项目 `.hadamard` 目录中。
- 在 canvas-only 中创建的画布，在完整应用中立即可见，反之亦然。
- agent 工具只在所属模块激活处注册：canvas-only 窗口没有聊天循环，harness-only 窗口没有画布工具。
