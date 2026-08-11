# ADR-012：Agent 三模式、节点四模式与统一执行策略

- 状态：Accepted
- 日期：2026-08-11
- 决策范围：Hadamard SDK runtime、Agent、Workflow、Graph、TUI/GUI

## 上下文

现有 DAG Workflow 与 Team Graph 分别使用 `mode`、`type` 表达 ReAct/Single，且 Graph 的 `type:'team'` 又承担目标引用语义。加入 CodeAct 后若各 executor 自行解释字段，会产生不一致的 prompt、工具注册和安全降级。

## 决定

1. 可复用 Agent 定义只允许 `react | codeact | hybrid`；Agent-level `single` 是配置错误。
2. Workflow/Graph Agent 节点允许 `react | codeact | hybrid | single`，并可使用 `inherit` 表示无显式覆盖。
3. 运行边界统一解析为 `AgentExecutionPolicy`：action space、turn policy、普通工具与工具调用上限。
4. 继承顺序固定为节点显式值、Agent 定义、会话覆盖、项目默认，最终默认 ReAct。
5. Single 保留现有普通工具选择，但只能选择零个或一个、最多调用一次；不能注册 CodeCell。
6. CodeAct/Hybrid 在项目 capability 关闭时返回 `CODEACT_DISABLED`，绝不静默降级。
7. 旧 Workflow `mode` 与 Graph `type:'react'|'single'` 只读迁移；Graph `type:'team'` 不解释为执行模式。
8. Prompt 与实际 provider tool catalog 必须由同一 policy 生成和裁剪。

## 拒绝的方案

- 为 CodeAct 建第二套 outer runtime：拒绝，会分裂会话、权限、compact、事件与审计。
- 仅修改系统提示词但仍发送全部工具：拒绝，模型可见能力与文字约束不一致。
- 把 Single 暴露为 Agent 类型：拒绝，它是节点级有界执行策略。
- CodeAct 不可用时自动 ReAct：拒绝，行为和安全假设会被隐藏改变。

## 兼容影响

Canonical `agentMode` 优先于 legacy 字段。旧字段保留一版读取兼容，序列化只写新字段；Graph 目标引用逐步迁移到 `targetRef`。

## 测试证据

- `tests/agent-execution-policy.spec.ts`：模式映射、继承、禁用错误、Single 上限和 legacy fixtures。
- 后续模式矩阵测试验证 Agent/Workflow/Graph、prompt 与工具裁剪的一致性。

## 回滚方式

可以暂时只让 resolver 产出 ReAct 策略，但不得删除 canonical 字段或重新允许隐式降级；持久化格式必须继续可读。
