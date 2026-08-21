# CodeDen 阶段 1 开发文档：Agent 重构与最小评测底座

## 1. 文档用途

本文只描述 CodeDen 第一阶段的实现任务，供其他开发 Agent 直接阅读、拆解和编码。

阶段 1 的目标不是完成全部 Agent 产品，也不是建设完整 Benchmark 平台，而是交付第一条真实、可测试、可评测的纵向链路：

```text
读取一个 Native Eval Case
-> 创建隔离的临时 Workspace
-> 用真实 CodeDen Agent Loop 执行任务
-> Mock Model 驱动真实工具调用
-> Agent 生成 Submission
-> 独立确定性 Grader 验证结果
-> 收集事件、指标和结果
-> 输出评测报告
```

Mock 只能用于替代模型响应和注入故障。以下部分必须是真实实现：

- Agent Loop。
- Tool Registry 和 Tool Executor。
- 文件工具。
- WorkspacePolicy。
- Eval Runner 和 Trial Runner。
- Submission 收集。
- Grader。
- 事件与结果存储接口。

---

## 2. 阶段范围

### 2.1 必须完成

Agent Runtime：

- TypeScript + ESM 工程基础。
- `TaskSpec`。
- `AgentRunner`。
- `AgentState` 状态机。
- `ModelProvider` 接口。
- `MockModelProvider`。
- 一个最小真实 `OpenAIModelProvider`。
- `ToolRegistry`。
- `ToolExecutor`。
- `read_file`。
- `write_file`。
- `edit_file`。
- `run_command` 的安全最小版本。
- `WorkspacePolicy`。
- 结构化错误。
- 结构化 `RunEvent`。
- `CodeDenAgentAdapter`。

Eval Foundation：

- `EvalCase` Schema。
- `TrialResult` Schema。
- `AgentSubmission` Schema。
- `AgentPort`。
- `BenchmarkPort`。
- `WorkspacePort`。
- `EvalRepository`。
- `TrialRunner`。
- `EvalRunner`。
- 最小 `NativeBenchmarkAdapter`。
- JSON 字段 Grader。
- Changed Paths Grader。
- `TemporaryWorkspaceAdapter`。
- `InMemoryEvalRepository`。
- `ConsoleReporter`。

Testing：

- 单元测试。
- Port Contract Tests。
- Agent + Eval 端到端测试。
- 一个真实 Provider 冒烟测试入口，默认不在 CI 中调用真实 API。

### 2.2 明确不做

- MCP Client。
- Harbor、DeepSWE、SWE-bench。
- Docker Sandbox。
- Git worktree。
- 多 Agent。
- Skills 和 Memory。
- 长期 Session 恢复。
- 复杂 Context Compaction。
- LLM Judge。
- Failure Analyzer。
- Baseline Comparator。
- Champion/Challenger。
- 自动优化 Agent。
- Web UI 或可视化看板。
- SQLite/Postgres。

这些内容不得以“顺手实现”为由进入阶段 1。

---

## 3. 阶段 1 技术栈

```text
Node.js
TypeScript
pnpm
ESM
Zod
Vitest
YAML parser
OpenAI SDK（只用于第一种真实 Provider）
```

工程要求：

- `package.json` 使用 `type: module`。
- TypeScript 使用严格模式。
- 源码不得依赖编译后的目录。
- 所有外部输入必须经过 Zod 校验。
- 测试不能依赖真实模型 API、网络或用户全局配置。

建议脚本：

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "eval": "tsx src/cli/eval-command.ts",
    "agent": "tsx src/cli/agent-command.ts"
  }
}
```

具体依赖版本由初始化 Agent按照当前兼容版本确定并锁定，不在业务代码中使用未声明依赖。

---

## 4. 阶段 1 目录结构

实现 Agent 应创建以下结构。若需要增加辅助文件，可以增加，但不得改变模块责任。

```text
src/
├── core/
│   ├── errors/
│   │   ├── codeden-error.ts
│   │   └── error-codes.ts
│   ├── events/
│   │   ├── run-event.ts
│   │   └── event-sink.ts
│   └── task/
│       ├── task-spec.ts
│       └── task-state.ts
│
├── runtime/
│   ├── agent/
│   │   ├── agent-runner.ts
│   │   ├── agent-types.ts
│   │   └── completion-policy.ts
│   ├── models/
│   │   ├── model-provider.ts
│   │   ├── model-types.ts
│   │   ├── mock-model-provider.ts
│   │   └── openai-model-provider.ts
│   ├── tools/
│   │   ├── tool.ts
│   │   ├── tool-registry.ts
│   │   ├── tool-executor.ts
│   │   ├── tool-result.ts
│   │   └── builtins/
│   │       ├── read-file.ts
│   │       ├── write-file.ts
│   │       ├── edit-file.ts
│   │       └── run-command.ts
│   └── workspace/
│       ├── workspace-policy.ts
│       └── path-guard.ts
│
├── eval/
│   ├── domain/
│   │   ├── eval-case.ts
│   │   ├── eval-run.ts
│   │   ├── trial-result.ts
│   │   ├── verification-result.ts
│   │   ├── agent-submission.ts
│   │   └── metrics.ts
│   ├── ports/
│   │   ├── agent.port.ts
│   │   ├── benchmark.port.ts
│   │   ├── workspace.port.ts
│   │   └── eval-repository.port.ts
│   ├── application/
│   │   ├── eval-runner.ts
│   │   ├── trial-runner.ts
│   │   └── event-recorder.ts
│   ├── adapters/
│   │   ├── agents/
│   │   │   └── codeden-agent.adapter.ts
│   │   ├── benchmarks/
│   │   │   └── native/
│   │   │       ├── native-benchmark.adapter.ts
│   │   │       ├── native-case-loader.ts
│   │   │       └── native-case-schema.ts
│   │   ├── workspaces/
│   │   │   └── temporary-workspace.adapter.ts
│   │   └── repositories/
│   │       └── in-memory-eval.repository.ts
│   ├── graders/
│   │   ├── grader.ts
│   │   ├── json-field.grader.ts
│   │   ├── changed-paths.grader.ts
│   │   └── composite.grader.ts
│   └── reporters/
│       └── console.reporter.ts
│
└── cli/
    ├── agent-command.ts
    └── eval-command.ts

evals/
├── cases/
│   └── regression/
│       └── update-package-version.yaml
└── fixtures/
    └── basic-node-project/
        └── package.json

tests/
├── unit/
├── contract/
├── integration/
└── e2e/
```

---

## 5. 核心设计规则

### 5.1 Core 不依赖 Adapter

禁止：

```text
core -> OpenAI SDK
core -> Node fs
core -> YAML parser
core -> CLI
```

允许：

```text
application -> core
application -> ports
adapters -> ports/core
cli -> application/adapters
```

### 5.2 Eval 不直接操作模型和工具

Eval Harness 只能调用：

```ts
AgentPort.run(...)
```

不得从 `TrialRunner` 直接调用 `ModelProvider`、`ToolExecutor` 或 OpenAI SDK。

### 5.3 Agent 不给自己打分

Agent 可以运行工具并产生 Submission，但不能设置：

```ts
resolved = true;
```

`resolved` 只能由 Trial Runner 根据独立 `VerificationResult` 计算。

### 5.4 一个调用对应一个结果

必须保证：

```text
每个 Model Request -> 一个 completed 或 failed 事件
每个 Tool Call -> 一个 completed 或 failed Tool Result
每个 Trial -> 一个最终 TrialResult
```

任何异常路径也不得破坏这一不变量。

---

## 6. 数据契约

所有 Schema 文件应导出：

1. Zod Schema。
2. 通过 `z.infer` 得到的 TypeScript 类型。
3. 必要的构造或解析函数。

不要同时手写两份容易漂移的 interface 和 Schema。

### 6.1 TaskSpec

```ts
const TaskSpecSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  allowedPaths: z.array(z.string().min(1)).default(["."]),
  verificationCommands: z.array(z.string().min(1)).default([]),
});
```

### 6.2 AgentTask

```ts
const AgentTaskSchema = z.object({
  taskSpec: TaskSpecSchema,
  prompt: z.string().min(1),
});
```

### 6.3 AgentRunResult

```ts
const AgentRunResultSchema = z.object({
  status: z.enum([
    "submitted",
    "timeout",
    "budget_exhausted",
    "agent_error",
  ]),
  stopReason: z.string().optional(),
  finalResponse: z.string().default(""),
  submission: AgentSubmissionSchema.optional(),
  metrics: TrialMetricsSchema,
});
```

### 6.4 AgentSubmission

阶段 1 支持 `files` 和 `text`，保留 `git-patch` 类型但不要求真实生成 Git Patch。

```ts
const AgentSubmissionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("files"),
    changedPaths: z.array(z.string()),
  }),
  z.object({
    type: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("git-patch"),
    artifactId: z.string(),
  }),
]);
```

### 6.5 EvalCase

阶段 1 Native Case：

```ts
const EvalCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  suite: z.enum(["regression", "training", "validation", "holdout"]),
  tags: z.array(z.string()).default([]),
  task: z.object({
    prompt: z.string().min(1),
    taskSpec: TaskSpecSchema,
  }),
  fixture: z.object({
    path: z.string().min(1),
  }),
  limits: z.object({
    timeoutMs: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  }),
  submission: z.object({
    type: z.enum(["files", "text"]),
    allowedPaths: z.array(z.string()).default([]),
  }),
  verification: z.object({
    graders: z.array(z.unknown()).min(1),
  }),
});
```

### 6.6 TrialResult

```ts
const TrialResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  trialId: z.string().min(1),
  caseId: z.string().min(1),
  execution: z.object({
    status: z.enum([
      "submitted",
      "timeout",
      "budget_exhausted",
      "agent_error",
    ]),
    stopReason: z.string().optional(),
  }),
  submission: z.object({
    status: z.enum(["valid", "empty", "invalid", "missing"]),
  }),
  verification: z.object({
    status: z.enum(["passed", "failed", "error"]),
  }),
  infrastructure: z.object({
    status: z.enum(["ok", "setup_error", "runtime_error"]),
  }),
  resolved: z.boolean(),
  scores: z.record(z.string(), z.number()),
  metrics: TrialMetricsSchema,
  artifacts: z.array(z.string()).default([]),
});
```

### 6.7 RunEvent

```ts
const RunEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  trialId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  source: z.enum([
    "eval",
    "agent",
    "model",
    "tool",
    "workspace",
    "verifier",
  ]),
  type: z.string().min(1),
  data: z.unknown(),
});
```

---

## 7. Agent Runtime 具体实现

### 7.1 Agent 状态机

阶段 1 状态：

```text
CREATED
-> RUNNING
-> MODEL_PROPOSED_COMPLETE
-> SUBMITTED

RUNNING
-> TIMEOUT
-> BUDGET_EXHAUSTED
-> FAILED
```

注意：`SUBMITTED` 不是 `VERIFIED_COMPLETE`。后者属于 Eval/Verifier 结果。

状态转换必须集中实现，不得在 CLI、Provider 和 Tool 中分别修改状态。

### 7.2 Agent Loop

伪代码：

```ts
while (state === "RUNNING") {
  enforceLimits();

  const response = await modelProvider.complete({
    messages,
    tools: toolRegistry.definitions(),
  });

  recordModelUsage(response.usage);

  if (response.toolCalls.length === 0) {
    state = "MODEL_PROPOSED_COMPLETE";
    finalResponse = response.text;
    break;
  }

  for (const toolCall of response.toolCalls) {
    const result = await toolExecutor.execute(toolCall, context);
    messages.push(toModelToolResult(result));
  }
}

if (state === "MODEL_PROPOSED_COMPLETE") {
  submission = await collectSubmission();
  state = "SUBMITTED";
}
```

阶段 1 默认串行执行所有工具，先保证正确性。只读并发放到后续阶段。

### 7.3 ModelProvider

```ts
interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

统一响应：

```ts
interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "unknown";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

`OpenAIModelProvider` 负责把供应商格式转换为上述内部格式，不得把 SDK 类型泄漏到 `AgentRunner`。

`MockModelProvider` 按预先配置的响应队列工作：

```ts
new MockModelProvider([
  toolCall("read_file", { path: "package.json" }),
  toolCall("edit_file", {
    path: "package.json",
    oldText: "\"version\": \"1.0.0\"",
    newText: "\"version\": \"2.0.0\"",
  }),
  finalText("已完成版本修改"),
]);
```

### 7.4 Tool 接口

```ts
interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly sideEffect: "read" | "write" | "process";
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}
```

### 7.5 ToolExecutor

固定执行顺序：

```text
查找工具
-> 校验参数
-> 检查权限和路径
-> 检查 Tool Call 预算
-> emit tool.started
-> 执行并应用 timeout/cancel
-> emit tool.completed 或 tool.failed
-> 返回结构化 ToolResult
```

结构化结果：

```ts
type ToolResult =
  | {
      ok: true;
      callId: string;
      toolName: string;
      output: unknown;
      durationMs: number;
    }
  | {
      ok: false;
      callId: string;
      toolName: string;
      error: CodeDenErrorData;
      durationMs: number;
    };
```

工具业务错误返回失败结果给模型；Agent Runtime 自身不变量损坏才抛出内部异常。

### 7.6 WorkspacePolicy

构造参数：

```ts
interface WorkspacePolicyConfig {
  readableRoots: string[];
  writableRoots: string[];
  allowCommands: boolean;
}
```

路径检查流程：

```text
输入路径
-> 相对于 workspace root 解析
-> realpath/父目录解析
-> 检查是否位于允许根目录
-> 检查符号链接逃逸
-> 根据 read/write 类型授权
```

必须拒绝：

- 工作区外绝对路径。
- `../` 逃逸。
- 指向工作区外的符号链接。
- 未列入 `allowedPaths` 的写入。

### 7.7 阶段 1 工具行为

#### read_file

- 输入：`path`。
- 只允许文本文件。
- 返回内容和字节数。
- 设置最大读取大小。

#### write_file

- 输入：`path`、`content`。
- 不允许越界路径。
- 父目录不存在时是否创建必须由显式选项决定，默认不创建。

#### edit_file

- 输入：`path`、`oldText`、`newText`。
- `oldText` 必须恰好匹配一次。
- 0 次或多次匹配均失败，不进行猜测修改。
- 写入前再次检查目标未在读取后发生变化；阶段 1 可用内容哈希完成。

#### run_command

- 输入必须为命令和参数数组，不接受一整段 Shell 字符串。
- 使用 `shell: false`。
- 固定 `cwd` 为 Workspace root。
- 环境变量使用白名单。
- 设置超时。
- 返回 `exitCode/stdout/stderr/durationMs`。
- 阶段 1 不承诺完整容器隔离，因此默认仅用于测试 Fixture 内的无副作用命令。

---

## 8. Eval Foundation 具体实现

### 8.1 四个 Port

#### AgentPort

```ts
interface AgentPort {
  readonly name: string;
  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult>;
}
```

#### BenchmarkPort

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
}
```

#### WorkspacePort

```ts
interface WorkspacePort {
  readonly root: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: CommandSpec): Promise<CommandResult>;
  changedPaths(): Promise<string[]>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
```

#### EvalRepository

```ts
interface EvalRepository {
  createRun(run: EvalRun): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
  saveTrial(result: TrialResult): Promise<void>;
  getRun(runId: string): Promise<EvalRun | null>;
}
```

### 8.2 TrialRunner

TrialRunner 是阶段 1 的核心编排器。

伪代码：

```ts
async function runTrial(input: RunTrialInput): Promise<TrialResult> {
  const ids = createRunIdentifiers();
  let workspace: WorkspacePort | undefined;

  try {
    emit("eval.trial.started");

    workspace = await workspaceFactory.create(input.evalCase.fixture);
    emit("workspace.prepared");

    const prepared = await benchmark.prepare(input.evalCase, workspace);

    const agentResult = await withTimeout(
      agent.run(prepared.agentTask, createAgentContext(workspace, ids)),
      input.evalCase.limits.timeoutMs,
    );

    const submissionStatus = validateSubmission(agentResult.submission);

    emit("verification.started");
    const verification = await benchmark.verify(
      prepared,
      agentResult.submission,
      createVerificationContext(workspace, ids),
    );
    emit("verification.completed", verification);

    return buildTrialResult({
      agentResult,
      submissionStatus,
      verification,
      resolved: verification.status === "passed",
    });
  } catch (error) {
    return mapFailureToTrialResult(error);
  } finally {
    await workspace?.dispose();
    emit("eval.trial.completed");
  }
}
```

要求：

- `finally` 中清理 Workspace。
- Verifier 异常不能伪装成 Agent 失败。
- Workspace 创建失败属于 `infrastructure.setup_error`。
- Agent 超时属于 `execution.timeout`。
- 缺少 Submission 不应调用依赖 Submission 的 Grader。
- 最终结果必须保存，即使 Trial 失败。

### 8.3 EvalRunner

阶段 1 顺序运行案例，暂不并发：

```text
load cases
-> create EvalRun
-> for each case: TrialRunner.run
-> collect TrialResult
-> calculate basic summary
-> ConsoleReporter.report
```

基础汇总：

- Total Cases。
- Passed Cases。
- Failed Cases。
- Infrastructure Errors。
- Pass Rate。
- 总耗时。
- Tool Calls。
- Token Usage。

### 8.4 Native Case 格式

`evals/cases/regression/update-package-version.yaml`：

```yaml
schemaVersion: 1
id: update-package-version
suite: regression
tags:
  - filesystem
  - json

task:
  prompt: 将 package.json 的版本修改为 2.0.0，不要修改其他字段。
  taskSpec:
    id: update-package-version
    goal: 修改 package.json 版本
    acceptanceCriteria:
      - package.json 的 version 等于 2.0.0
      - 其他字段保持不变
    constraints:
      - 不得修改其他文件
    allowedPaths:
      - package.json
    verificationCommands: []

fixture:
  path: ../../fixtures/basic-node-project

limits:
  timeoutMs: 30000
  maxTurns: 5
  maxToolCalls: 6

submission:
  type: files
  allowedPaths:
    - package.json

verification:
  graders:
    - type: json-field
      path: package.json
      pointer: /version
      equals: 2.0.0
    - type: changed-paths
      allowed:
        - package.json
```

### 8.5 Grader

```ts
interface Grader<TConfig = unknown> {
  readonly type: string;
  grade(config: TConfig, context: GraderContext): Promise<GraderResult>;
}
```

```ts
interface GraderResult {
  graderType: string;
  passed: boolean;
  score: number;
  message: string;
  evidence: string[];
}
```

#### JsonFieldGrader

- 读取 Workspace 中的 JSON 文件。
- 使用 JSON Pointer 定位字段。
- 比较期望值。
- 文件不存在、JSON 非法、Pointer 不存在均返回清晰失败证据。

#### ChangedPathsGrader

- 比较 Fixture 初始快照与 Trial 最终状态。
- 拒绝任何未列入 `allowed` 的新增、修改或删除文件。
- 不依赖 Agent 自报的 changed paths。

#### CompositeGrader

- 顺序运行所有 Grader。
- 保留所有分项结果。
- 阶段 1 采用“全部通过才通过”。
- Grader 自身异常与 Grader 判定失败必须区分。

### 8.6 TemporaryWorkspaceAdapter

阶段 1 使用系统临时目录：

```text
mkdtemp
-> 复制 Fixture
-> 保存初始文件清单和内容哈希
-> Agent 执行
-> 计算 changed paths
-> Verifier 读取
-> dispose 删除临时目录
```

要求：

- 每个 Trial 使用唯一目录。
- Fixture 本身永远不被修改。
- 所有路径操作经过 WorkspacePolicy。
- 测试可注入临时目录工厂，验证 `dispose` 被调用。

### 8.7 InMemoryEvalRepository

阶段 1 仅用于测试和当前进程报告：

```ts
class InMemoryEvalRepository implements EvalRepository {
  runs: Map<string, EvalRun>;
  trials: Map<string, TrialResult>;
  events: Map<string, RunEvent[]>;
}
```

要求：

- 保存时再次通过 Zod 校验。
- 事件按 `trialId` 分组。
- 拒绝重复或倒退的 `sequence`。
- 查询结果返回副本，避免调用方修改内部状态。

---

## 9. 结构化事件与指标

### 9.1 EventRecorder

每个 Trial 只有一个 EventRecorder，负责分配 sequence：

```ts
class EventRecorder {
  private sequence = 0;

  async emit(source: RunEventSource, type: string, data: unknown) {
    const event = RunEventSchema.parse({
      schemaVersion: 1,
      runId: this.runId,
      trialId: this.trialId,
      sequence: this.sequence++,
      timestamp: this.clock.now().toISOString(),
      source,
      type,
      data,
    });

    await this.repository.appendEvent(event);
  }
}
```

测试必须注入 Clock，避免时间不稳定。

### 9.2 阶段 1 事件

```text
eval.trial.started
workspace.prepared
agent.started
model.requested
model.completed
model.failed
tool.started
tool.completed
tool.failed
agent.completion_proposed
agent.submitted
verification.started
verification.completed
verification.failed
workspace.disposed
eval.trial.completed
```

### 9.3 TrialMetrics

```ts
const TrialMetricsSchema = z.object({
  durationMs: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
```

Metric 来源必须明确：

- Turns：AgentRunner。
- Model Requests/Token：ModelProvider 响应。
- Tool Calls/Failures：ToolExecutor。
- Duration：TrialRunner 使用单调时钟。
- Cost：Provider 能可靠提供时才填写，不允许凭空估计。

---

## 10. 错误模型

统一错误数据：

```ts
interface CodeDenErrorData {
  code: string;
  category:
    | "validation"
    | "model"
    | "tool"
    | "workspace"
    | "permission"
    | "timeout"
    | "verifier"
    | "infrastructure"
    | "internal";
  message: string;
  retryable: boolean;
  details?: unknown;
}
```

阶段 1 错误码至少包括：

```text
INVALID_INPUT
MODEL_REQUEST_FAILED
MODEL_RESPONSE_INVALID
TOOL_NOT_FOUND
TOOL_INPUT_INVALID
TOOL_EXECUTION_FAILED
WORKSPACE_PATH_DENIED
WORKSPACE_IO_FAILED
COMMAND_TIMEOUT
AGENT_TIMEOUT
AGENT_BUDGET_EXHAUSTED
SUBMISSION_MISSING
SUBMISSION_INVALID
VERIFIER_FAILED
VERIFIER_ERROR
WORKSPACE_SETUP_FAILED
INTERNAL_INVARIANT_VIOLATION
```

错误映射由边界层完成：

- OpenAI 错误由 `OpenAIModelProvider` 映射。
- Node 文件错误由 Workspace/Tool Adapter 映射。
- Grader 异常由 TrialRunner 映射为 verifier error。

不要通过匹配最终错误字符串决定 Trial 状态。

---

## 11. CLI 流程

### 11.1 Agent CLI

目标命令：

```bash
pnpm agent --prompt "读取 package.json 并告诉我项目名"
```

阶段 1 参数：

```text
--prompt <text>
--model <name>
--workspace <path>
--max-turns <number>
--max-tool-calls <number>
```

要求：

- CLI 只负责参数解析和依赖组装。
- 不在 CLI 中实现 Agent Loop。
- 退出码：成功提交为 0，Agent/配置错误为非 0。

### 11.2 Eval CLI

目标命令：

```bash
pnpm eval --case evals/cases/regression/update-package-version.yaml
```

输出示例：

```text
Case: update-package-version
Agent: codeden/mock-model
Execution: submitted
Submission: valid
Verification: passed
Resolved: yes
Turns: 3
Tool calls: 2
Duration: 42ms
```

退出码：

- 所有 Case resolved：0。
- Case 未通过：1。
- 配置或基础设施无法运行：2。

---

## 12. 实现顺序

其他 Agent 必须按依赖顺序开发，不能从 CLI 或 OpenAI Provider 倒着写。

### Step 1：工程初始化

实现：

- pnpm、TypeScript、ESM。
- Vitest。
- Zod。
- YAML parser。
- 构建、类型检查和测试脚本。

验收：

```bash
pnpm typecheck
pnpm test
pnpm build
```

全部成功。

### Step 2：Core Schema 与错误模型

实现：

- TaskSpec。
- RunEvent。
- AgentSubmission。
- EvalCase。
- TrialResult。
- CodeDenError。

验收：

- 每个 Schema 都有合法和非法输入测试。
- 非法输入错误包含字段路径。

### Step 3：四个 Eval Port 与 Model/Tool 接口

实现接口，不实现复杂逻辑。

验收：

- Core 不导入 Adapter。
- `pnpm typecheck` 通过。

### Step 4：TemporaryWorkspace 与 WorkspacePolicy

先建立安全文件边界，再写文件工具。

验收：

- 正常读写成功。
- `../`、绝对路径、符号链接逃逸失败。
- Fixture 不被污染。
- dispose 始终执行。

### Step 5：Tool Registry、Executor 和文件工具

实现真实 Tool Runtime。

验收：

- 每个 Tool Call 恰好一个 Result。
- 参数错误不会执行工具。
- edit 0 次/多次匹配均失败且文件不变。
- Tool 事件完整闭合。

### Step 6：MockModelProvider 和 AgentRunner

实现真实 Agent Loop。

验收：

- Mock 响应可驱动 read -> edit -> final。
- maxTurns/maxToolCalls 生效。
- 无 Tool Call 时进入 completion proposed，再生成 Submission。

### Step 7：CodeDenAgentAdapter

将 AgentRunner 包装成 AgentPort。

验收：

- Eval 模块只能通过 AgentPort 调用 Agent。
- Agent 事件使用 TrialRunner 提供的 EventRecorder。

### Step 8：Native Case、Grader 与 TrialRunner

实现第一条真实评测链。

验收：

- 正确修改通过。
- 错误版本失败。
- 修改额外文件失败。
- Verifier error 与 failed 分开。

### Step 9：EvalRunner、Repository 和 Reporter

实现整套 Case 运行与汇总。

验收：

- Console 输出准确。
- TrialResult 与 Event 可查询。
- CLI 退出码符合约定。

### Step 10：OpenAIModelProvider 冒烟接入

实现一个真实 Provider，但测试使用 Mock Client 或依赖注入。

验收：

- Provider Contract Test 通过。
- SDK 类型不泄漏到 Agent Core。
- 没有 API Key 时普通测试仍全部通过。
- 手动设置 Key 后可运行一个只读冒烟任务。

---

## 13. 测试矩阵

### 13.1 单元测试

#### Schema

- 合法 Case。
- 缺失 prompt。
- 非法 limits。
- 未知 submission type。
- 非法 TrialResult 状态。

#### WorkspacePolicy

- 工作区内读取。
- 工作区内写入。
- `../` 逃逸。
- 外部绝对路径。
- 符号链接逃逸。
- 未授权写入。

#### ToolExecutor

- 未知工具。
- 参数错误。
- 正常执行。
- 工具异常。
- 工具超时。
- 达到 Tool Call 上限。

#### AgentRunner

- 直接最终回复。
- 单工具调用。
- 多轮工具调用。
- 工具失败后模型修正。
- maxTurns。
- maxToolCalls。
- Provider 错误。

#### Grader

- JSON 字段相等。
- JSON 字段不等。
- JSON 非法。
- 文件不存在。
- 修改额外文件。

### 13.2 Contract Tests

#### AgentPort Contract

- 始终返回可校验 AgentRunResult。
- 超时和错误状态可区分。
- 不设置 Eval 的 resolved。

#### WorkspacePort Contract

- read/write 一致。
- changedPaths 准确。
- reset 恢复初始状态。
- dispose 幂等。

#### EvalRepository Contract

- 保存和读取 Run。
- 按 Trial 保存事件。
- sequence 不能倒退。

#### ModelProvider Contract

- 文本响应标准化。
- Tool Call 标准化。
- Usage 标准化。
- 错误标准化。

### 13.3 端到端测试

#### E2E-1：正常通过

```text
Native Case
-> Temporary Workspace
-> CodeDenAgentAdapter
-> MockModel read/edit/final
-> JSON Grader pass
-> Changed Paths pass
-> resolved=true
```

#### E2E-2：模型错误地声称完成

模型不修改文件，只回复“已完成”。

期望：

```text
execution=submitted
submission=empty 或 valid（按最终设计）
verification=failed
resolved=false
```

#### E2E-3：越界修改

模型尝试写入工作区外。

期望：

- ToolResult 为 permission error。
- 外部文件不变。
- 事件包含 tool.failed。
- Trial 不得 resolved。

#### E2E-4：额外文件修改

目标版本正确，但同时修改 README。

期望：

- JSON Grader 通过。
- Changed Paths Grader 失败。
- 总体验证失败。

#### E2E-5：Agent 超时

期望：

- execution.status=timeout。
- verification 不伪装成普通失败。
- Workspace 已 dispose。
- 仍保存 TrialResult。

#### E2E-6：Verifier 异常

期望：

- execution.status 保留真实 Agent 状态。
- verification.status=error。
- resolved=false。
- infrastructure 不错误归因给 Agent。

---

## 14. 阶段 1 工作包拆分

阶段 1 可以交给多个 Agent，但共享文件必须先由主实现 Agent 冻结。

### 工作包 1：工程与 Core 契约

负责：

- 工程初始化。
- Core Schema。
- 错误模型。
- RunEvent。
- 四个 Eval Port。
- ModelProvider/Tool 基础接口。

交付前冻结：

- `TaskSpec`。
- `AgentRunResult`。
- `AgentSubmission`。
- `EvalCase`。
- `TrialResult`。
- `RunEvent`。

其他工作包必须等待这些契约合并后再并行。

### 工作包 2：Workspace 与 Tool Runtime

负责：

- TemporaryWorkspaceAdapter。
- WorkspacePolicy。
- Path Guard。
- ToolRegistry。
- ToolExecutor。
- 四个内置工具。

不得修改 Eval Runner 或 ModelProvider。

### 工作包 3：Agent Runtime

负责：

- Agent 状态机。
- AgentRunner。
- MockModelProvider。
- CodeDenAgentAdapter。
- Agent/Tool/Model 事件。

依赖工作包 1、2。

### 工作包 4：Native Eval

负责：

- YAML Loader。
- NativeBenchmarkAdapter。
- JsonFieldGrader。
- ChangedPathsGrader。
- CompositeGrader。
- Eval Fixture 和 Case。

不得直接依赖 AgentRunner，只能依赖 AgentPort。

### 工作包 5：Eval Orchestration

负责：

- EventRecorder。
- TrialRunner。
- EvalRunner。
- InMemoryEvalRepository。
- ConsoleReporter。
- Eval CLI。

依赖工作包 1、3、4。

### 工作包 6：真实 Provider

负责：

- OpenAIModelProvider。
- Provider Contract Tests。
- Agent CLI 依赖组装。
- 手动冒烟测试说明。

不得让测试依赖真实 API。

### 工作包 7：端到端集成

负责：

- 串联所有模块。
- 实现 E2E-1 至 E2E-6。
- 修复跨模块契约问题。
- 输出阶段 1 交付说明。

只修复集成问题，不在此工作包新增功能。

---

## 15. 多 Agent 协作规则

每个 Agent 必须遵守：

1. 开始前阅读本文全文。
2. 只修改负责工作包内的目录。
3. 不擅自修改冻结 Schema 和 Port。
4. 发现契约不够用时，先提出最小兼容修改及影响范围。
5. 新代码必须附带测试。
6. 不添加阶段 1 之外的功能。
7. 不将外部 SDK 类型泄漏到 Core。
8. 不吞掉工具、模型、Workspace 或 Verifier 错误。
9. 不使用单一 `status` 混合 Agent、Submission、Verifier 和基础设施失败。
10. 不把 Agent 最终文本当作任务完成证据。
11. 保留用户或其他 Agent 已有修改，不覆盖无关文件。
12. 交付时说明修改文件、测试结果、已知限制和后续依赖。

共享文件所有权：

```text
package.json / tsconfig / vitest config
-> 工作包 1

src/core/** 和 src/eval/ports/**
-> 工作包 1

src/runtime/workspace/** 和 src/runtime/tools/**
-> 工作包 2

src/runtime/agent/** 和 mock model
-> 工作包 3

src/eval/adapters/benchmarks/** 和 graders/**
-> 工作包 4

src/eval/application/**、repository、reporter、eval CLI
-> 工作包 5

openai provider 和 agent CLI
-> 工作包 6

tests/e2e/**
-> 工作包 7
```

---

## 16. 阶段 1 完成定义

只有同时满足以下条件，阶段 1 才算完成。

### Agent Runtime

- CLI 可以运行 CodeDen Agent。
- Agent Loop 通过 Mock Model 完成多轮工具调用。
- 一个真实 Provider 可以完成手动冒烟任务。
- 文件工具全部经过 WorkspacePolicy。
- 每个 Tool Call 恰好一个 Tool Result。
- maxTurns、maxToolCalls 和 timeout 生效。
- Agent 输出结构化停止状态和 Submission。

### Eval Foundation

- Native YAML Case 可以加载和校验。
- TrialRunner 能通过 AgentPort 运行 CodeDen Agent。
- Fixture 在独立临时 Workspace 中执行。
- JsonField 和 ChangedPaths Grader 可独立验证。
- `resolved` 只由 VerificationResult 决定。
- Agent、Submission、Verifier、Infrastructure 状态分别记录。
- 事件 sequence 完整且有序。
- 指标可以从真实运行中收集。
- ConsoleReporter 输出正确结果。

### Quality

- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- E2E-1 至 E2E-6 全部通过。
- 普通 CI 不访问网络、不要求 API Key。
- 没有修改 Fixture 原件。
- 没有已知的 Workspace 路径逃逸。
- 没有静默忽略的关键错误。

### 阶段 1 最终演示

执行：

```bash
pnpm eval --case evals/cases/regression/update-package-version.yaml
```

预期：

```text
CodeDen 使用真实 Agent Loop
-> MockModelProvider 发出 read_file
-> ToolExecutor 读取 package.json
-> MockModelProvider 发出 edit_file
-> ToolExecutor 修改临时 Workspace
-> Agent 提交文件变更
-> JsonFieldGrader 验证 version=2.0.0
-> ChangedPathsGrader 验证只修改 package.json
-> TrialResult.resolved=true
-> ConsoleReporter 输出通过、Turns、Tool Calls 和耗时
-> 临时 Workspace 被清理
```

此演示通过后，才进入阶段 2：Git worktree、持久化结果仓库、完整本地评测与结果收集。
