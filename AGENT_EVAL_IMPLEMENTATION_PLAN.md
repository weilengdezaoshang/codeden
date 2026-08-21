# CodeDen Agent 与评测优化系统实施计划

## 1. 文档目标

本文是交给实现 Agent 的工程任务说明。目标是在当前空 Node.js 仓库中建设：

1. CodeDen Agent Runtime。
2. 自研 MCP Client。
3. 可适配多个评测集和多个 Agent 的 Eval Harness。
4. 评测事件、产物、分数和指标收集系统。
5. 根据失败结果诊断 Agent 问题的分析系统。
6. 通过 Champion/Challenger 实验验证优化候选的系统。

实施原则：先重构出最小但真实可运行的 Agent Runtime，同时搭建能够调用它的最小评测底座；随后完成本地评测和结果收集，再增强 MCP、分析、优化与外部评测集适配。Mock 只替代模型响应或注入故障，不能代替主要 Agent 执行链。

总实施顺序：

```text
重构 Agent 最小核心 + 最小 Eval Harness
-> 真实 Agent 接入 Native Eval
-> Worktree 隔离与结果收集
-> Agent Runtime 强化与自研 MCP
-> 聚合与失败诊断
-> Champion/Challenger 优化闭环
-> Harbor/DeepSWE/SWE-bench 适配
```

---

## 2. 最终闭环

```text
EvalCase
  -> 准备隔离 Workspace
  -> AgentPort 执行任务
  -> 收集 AgentSubmission、事件和指标
  -> BenchmarkPort 独立验证
  -> 保存 TrialResult 与 Artifact
  -> 聚合 EvalRunSummary
  -> FailureAnalyzer 生成失败归因
  -> CandidateGenerator 提出单变量优化
  -> Champion/Challenger 对照评测
  -> PromotionGate 决定接受或拒绝候选
```

关键约束：

- Agent 停止不等于任务完成。
- 只有独立 Verifier 通过，`resolved` 才能为 `true`。
- 评分、轨迹、Patch、成本和基础设施状态必须通过同一个 `runId/trialId` 关联。
- Optimizer 不得修改评测集、隐藏测试、Verifier、安全策略或 Promotion Gate。
- 安全违规不能被其他高分抵消。

---

## 3. 架构边界

### 3.1 Core Domain

Core 只保存系统必须统一遵守的数据和规则，不依赖具体模型、评测集、容器或数据库。

```text
TaskSpec
AgentEvent
AgentSubmission
EvalCase
EvalRun
TrialResult
VerificationResult
FailureDiagnosis
AgentCandidate
PromotionDecision
```

### 3.2 Application Layer

应用层负责用例编排：

```text
AgentRunner
TrialRunner
EvalRunner
FailureAnalysisService
ExperimentRunner
PromotionService
```

### 3.3 第一版只保留四个 Eval Port

```text
AgentPort
BenchmarkPort
WorkspacePort
EvalRepository
```

不要提前拆出 ProcessRunner、VCS、ArtifactStore、EventStore 等独立 Port。只有出现第二个真实实现并确认边界稳定后才能拆分。

### 3.4 Agent Runtime 内部扩展边界

```text
ModelProvider
Tool
McpTransport
```

Eval Harness 只能通过 `AgentPort` 使用 Agent，不得直接操作 ModelProvider、Tool 或 MCP。

---

## 4. 推荐目录

```text
src/
├── core/
│   ├── task/
│   ├── agent/
│   ├── events/
│   └── policies/
├── runtime/
│   ├── agent-runner.ts
│   ├── models/
│   ├── tools/
│   ├── mcp/
│   └── context/
├── eval/
│   ├── domain/
│   ├── application/
│   ├── ports/
│   ├── adapters/
│   │   ├── agents/
│   │   ├── benchmarks/
│   │   ├── workspaces/
│   │   └── repositories/
│   ├── analysis/
│   ├── optimization/
│   └── reporters/
└── cli/

evals/
├── cases/
│   ├── training/
│   ├── validation/
│   └── holdout/
├── fixtures/
├── baselines/
└── runs/

tests/
├── unit/
├── contract/
├── integration/
└── e2e/
```

---

## 5. 统一数据契约

实现 Agent 必须先定义这些契约，并使用 Zod 同时提供运行时校验和 TypeScript 类型推导。

### 5.1 EvalCase

```ts
interface EvalCase {
  schemaVersion: 1;
  id: string;
  suite: "training" | "validation" | "holdout" | "regression";
  tags: string[];
  benchmark: {
    name: string;
    version: string;
    sourceId: string;
  };
  task: {
    prompt: string;
    repo?: string;
    baseCommit?: string;
  };
  fixture?: {
    path: string;
  };
  limits: {
    timeoutMs: number;
    maxTurns?: number;
    maxToolCalls?: number;
    maxCostUsd?: number;
  };
  submission: {
    type: "git-patch" | "files" | "text";
    allowedPaths?: string[];
  };
  verification: unknown;
  metadata: Record<string, unknown>;
}
```

### 5.2 AgentSubmission

```ts
type AgentSubmission =
  | { type: "git-patch"; artifact: ArtifactReference }
  | { type: "files"; artifacts: ArtifactReference[] }
  | { type: "text"; content: string };
```

### 5.3 TrialResult

不得使用单一 `status` 混合不同失败来源。

```ts
interface TrialResult {
  schemaVersion: 1;
  runId: string;
  trialId: string;
  caseId: string;
  execution: {
    status: "submitted" | "timeout" | "budget_exhausted" | "agent_error";
    stopReason?: string;
  };
  submission: {
    status: "valid" | "empty" | "invalid" | "missing";
  };
  verification: {
    status: "passed" | "failed" | "error";
  };
  infrastructure: {
    status: "ok" | "setup_error" | "runtime_error";
  };
  resolved: boolean;
  scores: Record<string, number>;
  metrics: TrialMetrics;
  artifacts: ArtifactReference[];
}
```

### 5.4 RunEvent

```ts
interface RunEvent<T = unknown> {
  schemaVersion: 1;
  runId: string;
  trialId: string;
  sequence: number;
  timestamp: string;
  source: "eval" | "agent" | "model" | "tool" | "mcp" | "workspace" | "verifier";
  type: string;
  data: T;
}
```

最低事件集合：

```text
eval.trial.started
workspace.prepared
agent.started
model.requested
model.completed
tool.started
tool.completed
tool.failed
mcp.requested
mcp.completed
agent.submitted
artifact.collected
verification.started
verification.completed
analysis.completed
eval.trial.completed
```

---

## 6. Port 契约

### 6.1 AgentPort

```ts
interface AgentPort {
  readonly name: string;
  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult>;
}
```

第一批实现：

- `MockAgentAdapter`：按测试配置生成固定文件或文本。
- `CodeDenAgentAdapter`：调用真实 CodeDen Agent Runtime。
- `ReplayAgentAdapter`：重放已录制轨迹，供稳定测试使用。
- 后续实现通用 `ExternalCliAgentAdapter`。

### 6.2 BenchmarkPort

```ts
interface BenchmarkPort {
  readonly name: string;
  load(source: BenchmarkSource): AsyncIterable<EvalCase>;
  prepare(evalCase: EvalCase, workspace: WorkspacePort): Promise<PreparedCase>;
  verify(
    preparedCase: PreparedCase,
    submission: AgentSubmission,
    context: VerificationContext,
  ): Promise<VerificationResult>;
  exportResult?(result: TrialResult): Promise<unknown>;
}
```

第一批实现：

- `NativeBenchmarkAdapter`：读取 CodeDen YAML。
- `MockBenchmarkAdapter`：端到端骨架测试。
- 后续依次实现 `HarborBenchmarkAdapter`、`SweBenchAdapter`。

### 6.3 WorkspacePort

```ts
interface WorkspacePort {
  readonly root: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: CommandSpec): Promise<CommandResult>;
  status(): Promise<WorkspaceStatus>;
  createPatch(): Promise<ArtifactReference>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
```

第一批实现：

- `InMemoryWorkspaceAdapter`：骨架与单元测试。
- `WorktreeWorkspaceAdapter`：本地真实评测。
- 后续实现 `ContainerWorkspaceAdapter`。

### 6.4 EvalRepository

```ts
interface EvalRepository {
  createRun(run: EvalRun): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
  saveTrial(result: TrialResult): Promise<void>;
  saveArtifact(input: ArtifactInput): Promise<ArtifactReference>;
  getRun(runId: string): Promise<EvalRun | null>;
  queryRuns(query: EvalRunQuery): Promise<EvalRun[]>;
}
```

第一批实现：

- `InMemoryEvalRepository`：单元测试。
- `FileEvalRepository`：JSON、JSONL 和文件 Artifact。
- 数据量证明有必要后再实现 SQLite。

---

## 7. 阶段一：重构 Agent 核心，同时搭建评测底座

目标：首先得到一个真正可运行、可测试、可被评测的 CodeDen Agent。评测系统与 Agent 重构同时建立最小接口，但评测 Schema 必须由真实 Agent 的事件、Submission 和停止行为校准，不能只围绕 Mock 设计。

### 7.1 Agent 重构主线

最小可运行 Agent 必须包含：

```text
CLI 输入任务
-> AgentRunner
-> ModelProvider
-> Agent Loop
-> Tool Runtime
-> Workspace Tool
-> 结构化事件
-> AgentSubmission
-> 明确停止状态
```

第一阶段组件：

```text
TaskSpec
AgentState
AgentRunner
MockModelProvider
一个真实 ModelProvider
ToolRegistry
ToolExecutor
read_file
write_file
edit_file
run_command
WorkspacePolicy
CodeDenAgentAdapter
```

第一阶段暂不要求完整 MCP、多 Agent、Memory、Skill、复杂 Context 压缩或自动优化。

### 7.2 Agent Runtime 必须先建立的不变量

- 每个 Tool Call 恰好产生一个 Tool Result。
- Tool 参数必须经过 Zod 运行时校验。
- 模型、工具和 Agent 错误使用结构化错误类型。
- 写工具默认串行，禁止未知结果的自动重试。
- 所有文件读写必须经过 WorkspacePolicy。
- Agent 必须输出 `submitted/timeout/budget_exhausted/agent_error` 之一。
- 模型停止调用工具只表示提交候选，不表示评测通过。
- Model、Tool、Agent 事件必须携带 `runId/trialId`。

### 7.3 同期搭建的最小评测底座

与 Agent 主线同步实现：

```text
EvalCase Schema
TrialResult Schema
RunEvent Schema
AgentPort
BenchmarkPort
WorkspacePort
EvalRepository
TrialRunner 骨架
NativeBenchmarkAdapter 骨架
InMemoryEvalRepository
ConsoleReporter
```

Mock 只用于单元测试和故障注入，不能作为阶段一的主要产品闭环。阶段一的主要验收对象必须是 `CodeDenAgentAdapter`。

### 7.4 阶段一纵向用例

使用 Mock Model 驱动真实 Agent Runtime 完成固定任务：

```text
1. Native EvalCase 要求修改 fixture/package.json。
2. TrialRunner 创建 runId/trialId 和临时 Workspace。
3. CodeDenAgentAdapter 启动真实 AgentRunner。
4. MockModelProvider 返回 read_file Tool Call。
5. 真实 ToolExecutor 读取文件并记录事件。
6. MockModelProvider 返回 edit_file Tool Call。
7. 真实 ToolExecutor 修改文件并记录事件。
8. Agent 产生 AgentSubmission。
9. Native Benchmark 使用确定性 JSON Grader 验证结果。
10. Repository 保存事件、结果和 Artifact。
11. Reporter 输出通过或失败。
```

这里 Mock 的只有模型输出；Agent Loop、工具执行、Workspace、Submission 和评测流程都必须是真实实现。

### 7.5 阶段一验收标准

- CLI 能执行一次真实 Agent 任务。
- 同一个 Agent 可通过 `CodeDenAgentAdapter` 被 TrialRunner 调用。
- 使用 Mock Model 的端到端案例能够修改真实临时文件并通过 Grader。
- 使用一个真实 ModelProvider 可完成最小冒烟任务。
- Agent 抛错、Tool 抛错、Verifier 抛错和 Workspace 错误可明确区分。
- 成功案例只有在 Verifier 通过后才输出 `resolved=true`。
- 无论成功、失败或超时，Workspace 都被清理。
- `events.sequence` 单调递增，并可重建一次 Trial 的关键流程。

完成阶段一前，不得开发 Harbor、SWE-bench、自动 Candidate 优化或复杂可视化。

---

## 8. 阶段二：完成本地评测与结果收集系统

目标：使用 YAML Case、Fixture、Git worktree 和文件结果仓库，对真实 CodeDen Agent 进行可重复评测。

### 8.1 NativeBenchmarkAdapter

功能：

- 读取并使用 Zod 校验 YAML Case。
- 解析 Fixture、限制、Submission 和 Verification。
- 支持文件存在、JSON 字段、命令退出码和变更路径检查。
- Case 中所有相对路径均相对于 Case 文件解析。

验收：

- 非法 Case 返回包含字段路径的错误。
- Case 未声明的验收条件不得被隐式加入。
- Grader 只能读取评分环境，不能修改 Agent 结果。

### 8.2 WorktreeWorkspaceAdapter

功能：

- 记录 base commit 和 dirty state。
- 为 Trial 创建独立 Git worktree。
- 限制读写根目录。
- 执行命令并记录退出码、stdout、stderr、耗时。
- 创建 Patch 和 changed-files 列表。
- 清理 worktree。

验收：

- 不覆盖用户未提交修改。
- Trial 之间无文件污染。
- 超时命令及其子进程被终止。
- `../`、绝对路径和符号链接逃逸被拒绝。

### 8.3 FileEvalRepository

目录格式：

```text
evals/runs/<run-id>/<case-id>/<trial-id>/
├── trial.json
├── events.jsonl
├── submission/
│   └── patch.diff
├── agent/
│   ├── final-response.md
│   ├── stdout.log
│   └── stderr.log
└── verifier/
    ├── result.json
    ├── stdout.log
    └── stderr.log
```

验收：

- 事件采用 append-only JSONL。
- 进程崩溃后已写入事件仍可读取。
- Artifact 使用引用，不把大日志塞进 `trial.json`。
- 写入使用临时文件和原子替换。
- 默认脱敏 API Key、Token 和敏感环境变量。

---

## 9. 阶段三：强化 Agent Runtime 并实现自研 MCP

目标：在 Agent 已经接入评测闭环的前提下，加强 Provider、Tool、完成验证和自研 MCP。每项增强都必须通过阶段二建立的固定回归集验证。

### 9.1 ModelProvider 完善

统一：

- 消息格式。
- Tool Schema。
- 流式事件。
- Usage 和停止原因。
- Provider 错误分类。

阶段一已经实现一个真实 Provider 和一个 Mock Provider。本阶段增加 Provider Contract Tests，再按实际需要接入第二个 Provider，不得同时铺开所有模型供应商。

### 9.2 Tool Runtime 完善

统一执行管线：

```text
Zod 参数校验
-> 权限检查
-> 超时与取消
-> 执行
-> 结构化 ToolResult
-> 事件记录
```

不变量：

- 每个 Tool Call 恰好一个 Tool Result。
- 只读工具才可默认并发。
- 写操作不得因未知结果自动重试。
- 权限拒绝后不得重复申请同一操作。

### 9.3 自研 MCP Client

第一阶段范围：

- JSON-RPC 2.0。
- stdio Transport。
- `initialize`。
- `notifications/initialized`。
- `tools/list`。
- `tools/call`。
- 请求 ID 与 pending request 管理。
- 请求超时。
- Server 异常退出处理。
- stderr 持续消费。
- 结构化 content block。
- 优雅关闭。

暂不实现：Resources、Prompts、Sampling、Streamable HTTP、OAuth。

### 9.4 Completion Verification

Agent 状态机：

```text
RUNNING
-> MODEL_PROPOSED_COMPLETE
-> VERIFYING
-> 验证失败：RUNNING
-> 验证通过：VERIFIED_COMPLETE
-> 预算耗尽：INCOMPLETE
```

模型不再调用工具只能进入 `MODEL_PROPOSED_COMPLETE`，不能直接标记完成。

---

## 10. 阶段四：结果收集、聚合与诊断

### 10.1 必须收集的指标

```text
Resolve Rate
Regression Rate
Infrastructure Error Rate
Valid Submission Rate
Test Execution Rate
Tool Error Rate
Repeated Tool Call Rate
Completion Before Verification Rate
平均/P50/P95 耗时
输入/输出 Token
成本
Turns
Tool Calls
重试次数
MCP 错误和超时
权限违规数
```

### 10.2 FailureAnalyzer

第一版使用确定性规则：

```text
infrastructure_failure
workspace_setup_failure
agent_runtime_failure
missing_submission
invalid_patch
no_verification
introduced_regression
permission_violation
tool_failure
mcp_failure
agent_stalled
budget_exhausted
task_solution_failure
```

每个诊断必须包含：

```ts
interface FailureDiagnosis {
  category: string;
  owner: "agent" | "prompt" | "model" | "tool" | "mcp" |
    "workspace" | "benchmark" | "infrastructure";
  evidence: ArtifactReference[];
  confidence: number;
  recommendation?: string;
}
```

后续可增加 LLM Analyzer，但它只能补充诊断，不能修改原始评分。

### 10.3 Aggregator 和 Baseline Comparator

功能：

- 按 suite、tag、case、Agent 版本和模型聚合。
- 对比 Champion 与 Candidate。
- 报告绝对值和相对变化。
- 分别展示能力、可靠性、安全和效率，不只输出总分。

---

## 11. 阶段五：Agent 优化闭环

### 11.1 AgentCandidate

第一版只允许优化配置化表面：

```text
System Prompt
Tool descriptions
Completion Policy
Context Policy
Retry Policy
Budget Policy
Model Config
```

禁止候选修改：

```text
Eval Case
Holdout 数据
Verifier
隐藏测试
Workspace 安全边界
权限核心规则
Promotion Gate
历史原始结果
```

### 11.2 ExperimentRunner

使用 Champion/Challenger：

```text
Champion + 固定 Validation Set + 固定预算 + N Trials
Challenger + 同一 Validation Set + 同一预算 + N Trials
```

一次实验只改变一个主要变量，并保存假设：

```ts
interface AgentCandidate {
  id: string;
  parentVersion: string;
  hypothesis: string;
  changeTarget: string;
  changes: Record<string, unknown>;
}
```

### 11.3 PromotionGate

示例规则：

```yaml
resolveRateDeltaMin: 0.03
regressionRateMax: 0.10
costIncreasePercentMax: 20
permissionViolationsMax: 0
infrastructureErrorRateMax: 0.01
```

流程：

```text
Validation 通过
-> 在未参与优化的 Holdout Set 上复验
-> Promotion Gate 通过
-> 生成 PromotionDecision
-> 人工确认后升级 Champion
```

第一版不得自动修改并发布线上 Agent。

---

## 12. 阶段六：外部评测集适配

### 12.1 Harbor / DeepSWE

实现内容：

- Harbor Task Format 加载。
- Agent 与 Verifier 环境隔离。
- Agent 环境结束后导出 Patch。
- 在干净 Verifier 环境恢复 base commit 并应用 Patch。
- 运行隐藏测试。
- 导入 reward、测试结果和日志。

### 12.2 SWE-bench

输入转换：

```text
instance_id
repo
base_commit
problem_statement
-> EvalCase
```

输出转换：

```text
TrialResult + AgentSubmission
-> instance_id + model_name_or_path + model_patch
```

正式分数必须来自 SWE-bench 官方 Harness，CodeDen 不自行模拟。

### 12.3 External CLI Agent

使用配置化适配器，不为每个 CLI Agent复制代码：

```ts
interface ExternalCliAgentConfig {
  command: string;
  args: string[];
  promptMode: "stdin" | "argument" | "file";
  resultMode: "patch" | "files" | "text";
}
```

---

## 13. 测试策略

### 单元测试

- Zod Schema。
- 状态转换。
- 错误分类。
- 指标聚合。
- Promotion Gate。

### Contract Tests

每个 Port 的所有实现必须通过同一套契约测试：

- AgentPort Contract。
- BenchmarkPort Contract。
- WorkspacePort Contract。
- EvalRepository Contract。
- ModelProvider Contract。
- MCP Transport Contract。

### Integration Tests

- Native YAML + Worktree + Replay Agent。
- CodeDen Agent + Mock Model + Built-in Tools。
- MCP Client + 测试 MCP Server。
- File Repository 崩溃恢复。

### End-to-End Tests

至少覆盖：

1. 正常修改 JSON 并通过。
2. Agent 口头完成但文件错误，验证失败。
3. Agent 未生成 Submission。
4. Agent 超时。
5. Verifier 自身异常。
6. Workspace 初始化失败。
7. MCP 首次超时后按策略恢复。
8. 权限拒绝后 Agent 停止危险操作。
9. 修改禁止路径被 Safety Grader 拒绝。
10. Challenger 功能提高但安全违规，Promotion 被拒绝。

---

## 14. 多 Agent 开发拆分

开发必须以“重构 Agent + 最小评测底座”作为第一条纵向主线，不能先独立建设一套与真实 Agent 脱节的评测框架。

推荐执行波次：

```text
波次 1：工作包 A + 工作包 E 的最小部分
        冻结共享契约，跑通真实 Agent Loop、Mock Model 和最小 TrialRunner

波次 2：工作包 B + C + D
        完成本地真实评测、Workspace 隔离和结果收集

波次 3：工作包 E 的增强部分 + 工作包 F
        Provider、Tool Runtime、完成验证和自研 MCP

波次 4：工作包 G
        聚合、失败分析和优化实验

波次 5：工作包 H
        Harbor、DeepSWE、SWE-bench 等外部适配
```

波次 1 完成前不要并行开发外部 Benchmark 或自动优化。

### 工作包 A：Core、共享契约与最小 Eval Orchestration

负责：

- 数据 Schema。
- 四个 Port。
- TrialRunner/EvalRunner 最小骨架。
- 状态机。
- Native Benchmark 骨架。
- InMemory Repository。
- 与真实 CodeDenAgentAdapter 对接的端到端测试。

依赖：无。与工作包 E 的最小 Agent Runtime 同属波次 1，双方只通过冻结的 AgentPort 和事件 Schema 集成。

### 工作包 B：Native Benchmark 与 Graders

负责：

- YAML Loader。
- NativeBenchmarkAdapter。
- File/JSON/Command/ChangedPaths Grader。
- Case 示例和 Fixture。

依赖：工作包 A 的稳定 Port。

### 工作包 C：Workspace 与执行安全

负责：

- WorktreeWorkspaceAdapter。
- 路径策略。
- 命令超时与进程组回收。
- Patch 生成。

依赖：工作包 A 的 WorkspacePort。

### 工作包 D：Repository 与报告

负责：

- FileEvalRepository。
- JSONL 事件。
- Artifact 保存和脱敏。
- Console/JSON/Markdown Reporter。

依赖：工作包 A 的事件和结果 Schema。

### 工作包 E：Agent Runtime 重构主线

负责：

- ModelProvider。
- Agent Loop。
- Tool Runtime。
- Completion 状态机。
- CodeDenAgentAdapter。

实施拆成两段：

1. 波次 1：Mock Model + 一个真实 Provider、最小 Agent Loop、基础文件工具、WorkspacePolicy、CodeDenAgentAdapter。
2. 波次 3：Provider Contract、完整 Tool Runtime、Context、预算和 Completion Verification 增强。

依赖：与工作包 A 共同冻结 AgentPort 和事件 Schema；不得等待完整 Eval 系统完成后才开始 Agent 重构。

### 工作包 F：自研 MCP

负责：

- JSON-RPC。
- stdio Transport。
- 初始化、工具发现和调用。
- 超时、退出和清理。
- MCP Contract/Integration Tests。

依赖：工作包 E 的 Tool 接口和事件 Schema。

### 工作包 G：分析与优化

负责：

- Aggregator。
- Baseline Comparator。
- FailureAnalyzer。
- ExperimentRunner。
- PromotionGate。

依赖：工作包 A、D 完成；有真实 TrialResult 样本后开始。

### 工作包 H：外部 Benchmark

负责：

- Harbor/DeepSWE Adapter。
- SWE-bench Adapter。
- 外部结果导出。

依赖：Native Benchmark 端到端稳定后开始。

---

## 15. Agent 交付规则

每个实现 Agent 必须：

1. 只修改所负责工作包范围内的文件。
2. 不改变已冻结的 Port 和 Schema；确需改变时先提交兼容性说明。
3. 为新实现添加单元或契约测试。
4. 不把外部供应商类型泄漏到 Core Domain。
5. 不读取或暴露 Holdout/隐藏测试给被评 Agent。
6. 不用 LLM Judge 替代可以确定性验证的条件。
7. 不以“模型说完成”设置 `resolved=true`。
8. 不静默吞掉持久化、工具、MCP 或 Verifier 错误。
9. 保持错误来源可区分。
10. 在交付说明中列出实现内容、测试命令、已知限制和后续依赖。

---

## 16. 总体验收标准

系统完成后必须能够：

```text
加载 Native/外部 Eval Case
-> 在隔离 Workspace 中运行 CodeDen 或外部 Agent
-> 收集结构化事件、Patch、日志、Token、成本和耗时
-> 在独立验证阶段评分
-> 保存可审计 TrialResult
-> 汇总并与历史 Baseline 比较
-> 对失败进行证据化归因
-> 生成单变量 AgentCandidate
-> 运行 Champion/Challenger 实验
-> 使用 Holdout 与 Promotion Gate 决定是否升级
```

第一条纵向闭环完成并通过端到端测试之前，不得以“某个具体模块功能丰富”代替整体完成。
