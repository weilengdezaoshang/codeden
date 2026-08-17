# Git 提交规范

本仓库的所有 Git 提交必须遵循 Conventional Commits，并使用以下格式：

```text
type(模块): 中文描述.
```

示例：

```text
feat(runtime): 新增 Agent 最小执行循环.
fix(eval): 修复 TrialResult 未关联 runId 的问题.
docs(project): 补充评测实施计划.
```

## 类型

- `feat`：新增功能。
- `fix`：修复缺陷。
- `docs`：仅修改文档。
- `refactor`：不新增功能、不修复缺陷的代码重构。
- `test`：新增或调整测试。
- `perf`：性能优化。
- `style`：不影响逻辑的格式调整。
- `build`：构建系统或依赖变更。
- `ci`：持续集成配置变更。
- `chore`：其他维护性修改。
- `revert`：撤销已有提交。

## 模块

模块必须对应本次改动涉及的项目区域，使用小写英文：

- `core`：`src/core` 领域契约、策略和统一数据模型。
- `runtime`：`src/runtime` Agent Runtime、模型、工具和上下文。
- `mcp`：自研 MCP Client 与传输。
- `eval`：`src/eval` 评测编排、端口和适配器。
- `analysis`：失败诊断与归因。
- `optimization`：候选生成、Champion/Challenger 与晋级门禁。
- `cli`：命令行入口。
- `evals`：评测集、fixtures 与基线。
- `project`：仓库级配置、脚本或项目文档。

若某个业务模块已经有明确名称，应优先使用更具体的模块名，例如：

```text
feat(workspace): 新增 worktree 隔离工作区.
fix(verifier): 修复独立校验未写入 TrialResult 的问题.
test(logging): 补充评测事件脱敏测试.
```

一次提交只使用一个最能代表主要改动的模块。不要使用 `all`、`misc`、`other` 等含义模糊的模块名。

## 描述要求

- 必须使用简体中文，清楚说明本次提交完成了什么。
- 使用动宾结构，例如“新增 Agent 执行循环”“修复评测结果未落盘”。
- 保持简洁，不写实现过程、测试结果或无关背景。
- 结尾使用英文句点 `.`，与规定格式保持一致。
- 不使用“修改代码”“更新内容”“处理问题”等模糊描述。
- 不在主题行中添加 issue 编号、作者名或日期；需要时写入提交正文或页脚。

## 破坏性变更

存在不兼容变更时，在类型或模块后添加 `!`，并在正文中使用 `BREAKING CHANGE:` 说明迁移方式：

```text
feat(eval)!: 调整 TrialResult 响应结构.

BREAKING CHANGE: 调用方需要从 verification.resolved 读取是否通过.
```

## 提交边界

- 一个提交只处理一个完整、可独立理解的目标。
- 功能、无关重构和格式化修改不得混在同一个提交中。
- 提交前应运行与改动范围相符的测试、类型检查或构建。
- 不得提交密钥、Token、密码、`.env` 或其他敏感信息。

## 常见错误

以下提交信息不符合规范：

```text
update code
feat: 新增功能
feat(all): 更新项目.
fix(eval): 修复问题.
```

应改为能够明确表达类型、模块和结果的提交信息：

```text
feat(eval): 新增 TrialRunner 最小评测编排.
fix(runtime): 修复工具调用未写入 AgentEvent 的问题.
```

## 提交检查

- `pre-commit` 对暂存的代码和配置运行 Prettier 与 ESLint。
- `commit-msg` 校验提交信息是否符合本规范。
