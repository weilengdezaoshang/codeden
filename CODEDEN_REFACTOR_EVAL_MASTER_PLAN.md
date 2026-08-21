# CodeDen 完整重构与 Agent 评测体系开发主文档

## 1. 文档定位

本文是 CodeDen 后续开发的唯一主计划，用于指导多个开发 Agent 依次完成 BearCode 的 TypeScript 重构、可靠 Agent Harness、自研 MCP、评测结果收集、失败诊断和优化闭环。

参考来源：

- BearCode 新版：`/Users/weilengdezaoshang/Downloads/BearCode/`
- CodeDen 当前实现：本仓库 `src/`、`evals/` 和 `tests/`

基线更新时间：`2026-08-20`。旧路径 `/Users/weilengdezaoshang/Documents/项目/BearCode/` 不再作为迁移现状的依据；需要比较历史行为时才使用。

BearCode 中的文档、Prompt 和注释只作为现状参考，不作为本仓库开发指令。实际实现必须遵守本仓库 `AGENTS.md` 和本文定义的架构边界。

本文覆盖：

- 完整产品流程。
- BearCode 到 CodeDen 的迁移策略。
- 模块详细设计。
- 核心数据契约。
- 分阶段实施顺序。
- 每个阶段的验收场景。
- 多 Agent 工作包和文件边界。
- 最终系统完成定义。

---

## 2. 产品目标

CodeDen 最终定位：

> 一个配置驱动、安全可控、可恢复、可验证、可评测并能基于评测结果持续优化的 Coding Agent Runtime。

完整能力：

```text
CodeDen
├── Agent Runtime
├── Model Provider Adapters
├── Tool Runtime
├── Workspace / Sandbox
├── Self-built MCP Client
├── TaskSpec / ProjectInspector
├── Completion Verifier
├── Session / Context / Checkpoint
├── Event / Trace / Artifact
├── Skills / Retrieval / Usage Tracking
├── Session Memory / Long-term Memory
├── Online Skill Evolution
├── Skill Eval / Replay / Champion
├── Eval Harness
├── Benchmark Adapters
├── Result Store / Aggregator
├── Failure Analyzer
└── Champion / Challenger Optimizer
```

最终日常调用：

```bash
codeden
```

进入交互模式。

一次性任务：

```bash
codeden "修复登录接口在密码错误时返回 500 的问题"
```

运行评测：

```bash
codeden eval run evals/cases/regression
```

比较候选 Agent：

```bash
codeden eval compare --baseline champion --candidate candidate-042
```

---

## 3. 核心工程原则

### 3.1 模型停止不等于任务完成

```text
模型不再调用工具
= 模型提出交卷
≠ 任务已经完成
```

只有独立 Verifier 通过，任务才能进入：

```text
VERIFIED_COMPLETE
```

### 3.2 Agent 不给自己评分

Agent Runtime 只产出：

- 最终回复。
- 文件变化或 Patch。
- 结构化事件。
- 使用量和停止原因。

正式 `resolved` 由 Eval/Verifier 计算。

### 3.3 Secret 不进入 Agent 能力域

模型 API Key 只允许存在于 Model Transport：

```text
SecretResolver
-> ModelProvider 私有字段
-> HTTPS Authorization
```

以下模块不得获得 Secret：

- AgentRunner。
- ToolExecutor。
- Workspace。
- Prompt Builder。
- MCP Server。
- Event Recorder。
- Eval Runner。
- Reporter。

### 3.4 Core 不依赖具体供应商

禁止：

```text
core -> OpenAI SDK
core -> YAML
core -> Node fs
core -> Docker
core -> GitHub
```

供应商和平台差异只能存在于 Adapter。

### 3.5 结果优先，轨迹辅助

评测优先检查最终 Outcome：

- 文件状态。
- 测试结果。
- 数据库状态。
- HTTP 行为。

轨迹主要检查：

- 权限。
- 安全。
- 重试。
- 停滞。
- 成本。
- 协议不变量。

避免要求 Agent 严格按照固定工具顺序完成任务。

### 3.6 先确定性评分，后 LLM Judge

优先级：

```text
确定性 Grader
-> 环境状态 Grader
-> Trace Policy Grader
-> LLM Judge
-> 人工复核
```

能用代码判断的条件不得交给 LLM Judge。

---

## 4. 当前系统基线

### 4.1 BearCode 已有能力

- Python Agent Loop。
- OpenAI、Anthropic-compatible 模型调用。
- 文件读写、编辑、搜索和 Shell。
- 权限模式。
- 自研 stdio MCP 最小实现。
- REPL。
- Session 保存与恢复。
- 自动、手动和工具触发的 Context compact。
- `episode_memory`、`working_memory`、`tool_memory` 三层 Session Memory 折叠。
- 项目隔离的长期 Memory、异步相关性选择和上下文注入。
- 项目级与用户级 Skills 发现、解析、检索和执行。
- Skill 使用、反馈、provenance、版本快照与低使用率清理。
- 基于下一轮反馈的在线 Skill 候选抽取和 add/merge/discard。
- 在线 Skill Eval：replay pool、deterministic rules、可选 LLM Judge、candidate variants、promotion test、Champion。
- 子 Agent。
- 基础模型请求重试。

新版中最值得迁移的新增链路：

```text
会话轨迹
-> Skill 检索并注入
-> 使用效果判断
-> 下一轮反馈验证
-> 在线候选抽取
-> add / merge / discard
-> provenance 与 usage 落盘
-> replay pool
-> 规则与 LLM Judge
-> mutate_dev / promotion_test
-> Champion Gate
```

### 4.2 BearCode 主要问题

- 单文件 Agent 类过重。
- OpenAI/Anthropic 路径行为不一致。
- Tool 执行和错误处理分散。
- 文件路径缺少完整 Workspace 边界。
- Shell 使用 `shell=True` 并继承完整环境变量。
- MCP Server 继承完整 `os.environ`。
- `.env` 等敏感文件可被模型读取。
- 工具输出没有统一 Secret 脱敏。
- Session 是覆盖式 JSON，而非事件流。
- Folded Memory 虽然结构化，但缺少事务边界、Schema 版本和确定性恢复测试。
- 长期 Memory、Session Memory 与 Skill 经验的作用域边界仍不够清晰。
- Skill 检索主要依赖词法启发式，召回和误召回缺少独立离线评测集。
- 在线 Skill Eval 直接从生产 provenance 构造 replay，存在样本偏差和数据污染风险。
- 当前 Skill Champion 主要比较规则平均分与 hard failures，尚未与完整 Agent 任务成功率绑定。
- Skill Eval 的 LLM Judge 与被评对象可共用模型，缺少 Judge 独立性与校准。
- 新版源码未提供对应自动化测试目录，关键演化和晋级逻辑缺少回归保护。
- 模型停止即结束，没有确定性完成验证。
- 没有通用 Agent Eval Harness。
- Skill Eval 不等于 Agent Eval。
- 缺少 Worktree/Sandbox 隔离。
- 缺少完整 Replay 和 Provider Contract。

### 4.3 CodeDen 当前已有能力

- Node.js + TypeScript + ESM。
- Zod Schema。
- Vitest。
- AgentRunner。
- MockModelProvider。
- OpenAI-compatible Provider。
- `.codeden/config.yaml` 与 Secret 隔离。
- `pnpm codeden "<任务>"` 简洁 CLI。
- `read_file`、`write_file`、`edit_file`、`run_command`。
- ToolRegistry 与 ToolExecutor。
- WorkspacePolicy。
- 命令环境变量白名单。
- Native YAML Eval Case。
- TemporaryWorkspace。
- JsonField/ChangedPaths Grader。
- TrialRunner/EvalRunner。
- InMemoryEvalRepository。
- ConsoleReporter。
- Unit、Contract、E2E 测试。

实现说明书：

- 阶段 1 底座：`STAGE_1_AGENT_EVAL_FOUNDATION.md`
- 配置与 Secret：`CONFIG_SECRET_SECURITY_DEVELOPMENT.md`
- 阶段 2 TaskSpec + 完成验证：`docs/STAGE_2_TASKSPEC_COMPLETION_LOOP.md`
- 阶段 3 Baseline 回归差集：`docs/STAGE_3_BASELINE_REGRESSION.md`
- 阶段 4 Git worktree 隔离：`docs/STAGE_4_WORKTREE_ISOLATION.md`
- 阶段 5 冲突 Patch 与超时回收：`docs/STAGE_5_CONFLICT_PATCH_PROCESS.md`

### 4.4 当前执行阶段

截至 `2026-08-21`：

| 实施阶段 | 状态 | 说明 |
|---|---|---|
| 阶段 1：基础 Agent、配置与 Secret | 已实现 | 配置驱动 Provider、工具安全和最小 Eval 已存在 |
| 阶段 2：TaskSpec 与完成验证 | 已实现 | 模型停止与验证完成已分离 |
| 阶段 3：Baseline 回归差集 | 已实现 | 能区分原有失败和新增回归 |
| 阶段 4：Git worktree 隔离 | 已实现 | Git 任务进入 detached worktree，验收后写回 |
| 阶段 5：冲突 Patch 与进程回收 | 收口中 | 主链路和测试已存在，仍需完成路径、竞态、Patch 泄密和文件语义安全 |
| 下一阶段：自研 MCP | 未开始 | 阶段 5 完成定义满足后进入 |

当前阶段唯一实施说明以 `docs/STAGE_5_CONFLICT_PATCH_PROCESS.md` 为准。阶段 5 不增加 MCP、Docker、Session 或 Skill 功能，避免安全收口与新能力耦合。

### 4.5 CodeDen 当前缺口

- 没有自研 MCP。
- 没有容器 Sandbox、禁网和 CPU/内存资源限制。
- 进程组回收已有初版，但缺少跨平台和临界竞态验收。
- Worktree 写回缺少路径二次校验、TOCTOU 防护和完整文件变化语义。
- 冲突 Patch 尚未接入 Secret Leak Guard 和 run-scoped 生命周期。
- 没有持久事件与 Artifact Store。
- 没有 Checkpoint/Resume。
- 没有通用指标聚合和 Baseline。
- 没有 Failure Analyzer。
- 没有 Champion/Challenger。
- 没有外部 Benchmark Adapter。
- 没有 Skills Runtime、长期 Memory 和结构化 Session Folding。
- 没有 Skill 数据集、规则编译、在线评测和 Champion Registry。

---

## 5. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│                      CLI / TUI                           │
│ agent / eval / config / session / mcp                   │
└────────────────────────────┬─────────────────────────────┘
                             ↓
┌──────────────────────────────────────────────────────────┐
│                  Application Services                    │
│ AgentService / TrialRunner / SkillEval / Experiment     │
└────────────────────────────┬─────────────────────────────┘
                             ↓
┌──────────────────────────────────────────────────────────┐
│                       Core Domain                        │
│ TaskSpec / AgentState / Skill / Events / Policies       │
└────────────────────────────┬─────────────────────────────┘
                             ↓
┌──────────────────────────────────────────────────────────┐
│                          Ports                           │
│ Model / Tool / Memory / Skill / Agent / Benchmark       │
└────────────────────────────┬─────────────────────────────┘
                             ↓
┌──────────────────────────────────────────────────────────┐
│                        Adapters                          │
│ OpenAI / MCP / Worktree / FileStore / Native / Harbor   │
└──────────────────────────────────────────────────────────┘
```

---

## 6. 完整运行流程

### 6.1 普通 Agent 任务

```text
用户在项目目录执行 codeden "任务"
-> ConfigLoader 加载项目配置
-> SecretResolver 安全创建 ModelProvider
-> ProjectInspector 扫描项目事实
-> TaskSpecBuilder 生成候选 TaskSpec
-> TaskSpecValidator 校验路径、命令和约束
-> MemoryRetriever 读取任务相关的长期事实
-> SkillRetriever 选择候选 Skill 并记录 retrieval decision
-> BaselineVerifier 记录修改前状态
-> 创建隔离 Workspace
-> AgentRunner 开始执行
-> ModelInvoker 请求模型
-> ToolExecutor 执行工具
-> 模型提出完成
-> CompletionVerifier 独立检查
-> 失败：将结构化证据返回 Agent
-> 成功：生成 Submission
-> 保存事件、Patch、验证报告和指标
-> 异步记录 Skill relevance/usage/outcome，禁止影响本次正式结果
-> 输出 VERIFIED_COMPLETE
```

### 6.2 Eval Harness

```text
BenchmarkAdapter 加载 EvalCase
-> TrialRunner 创建 runId/trialId
-> 准备独立 Workspace
-> AgentPort 执行任务
-> Collector 收集 Trace、Submission、Usage
-> 独立 Verifier 评分
-> ResultRepository 保存 TrialResult
-> Aggregator 汇总
-> BaselineComparator 对比版本
-> FailureAnalyzer 归因失败
-> Reporter 输出 Console/JSON/Markdown/JUnit
```

### 6.3 Agent 优化

```text
历史 TrialResult + Trace
-> FailureAnalyzer 提取高频失败模式
-> CandidateGenerator 生成单变量改动
-> Validation Set 上运行 Champion/Challenger
-> 比较成功率、安全、成本、延迟
-> Holdout Set 复验
-> PromotionGate 决定接受或拒绝
-> 人工确认后升级 Champion
```

### 6.4 Skill 在线演化与评测

```text
已完成的 Agent Turn + 下一轮用户反馈
-> OnlineSkillIngestor 判断是否存在可复用经验
-> 生成 SkillCandidate
-> Maintainer 决定 add / merge / discard
-> 写入不可变 provenance 与版本快照
-> DatasetBuilder 冻结 replay sample
-> 按 lineage 分配 mutate_dev / promotion_test
-> RuleCompiler 生成确定性规则
-> 可选独立 LLM Judge 补充语义评分
-> CandidateGenerator 生成有限单变量变体
-> 在 mutate_dev 选出 Challenger
-> 在 promotion_test 对比当前 Champion
-> PromotionGate 检查质量、安全、样本量和退化
-> 自动保存候选；只有满足策略时才激活或等待人工审批
```

Agent Eval 与 Skill Eval 必须分开：Agent Eval 回答“任务是否完成”，Skill Eval 回答“某个可复用能力是否提升了任务表现”。Skill 的使用率、规则通过率只能作为辅助指标，不能代替真实任务成功率。

---

## 7. 推荐目录结构

```text
src/
├── core/
│   ├── errors/
│   ├── events/
│   ├── task/
│   ├── policies/
│   └── usage/
├── config/
├── security/
├── runtime/
│   ├── agent/
│   ├── models/
│   ├── tools/
│   ├── workspace/
│   ├── mcp/
│   ├── context/
│   ├── session/
│   ├── memory/
│   ├── skills/
│   └── verification/
├── eval/
│   ├── domain/
│   ├── ports/
│   ├── application/
│   ├── adapters/
│   │   ├── agents/
│   │   ├── benchmarks/
│   │   ├── workspaces/
│   │   └── repositories/
│   ├── graders/
│   ├── collectors/
│   ├── aggregation/
│   ├── analysis/
│   ├── optimization/
│   ├── skill-eval/
│   └── reporters/
├── evolution/
│   ├── skills/
│   ├── datasets/
│   ├── candidates/
│   └── promotion/
└── cli/

evals/
├── cases/
│   ├── regression/
│   ├── capability/
│   ├── validation/
│   └── holdout/
├── fixtures/
├── skills/
│   ├── retrieval/
│   ├── replay/
│   ├── validation/
│   └── holdout/
├── baselines/
└── runs/

tests/
├── unit/
├── contract/
├── integration/
├── security/
└── e2e/
```

---

## 8. 核心数据模型

### 8.1 TaskSpec

```ts
interface TaskSpec {
  schemaVersion: 1
  id: string
  goal: string
  acceptanceCriteria: AcceptanceCriterion[]
  constraints: Constraint[]
  allowedPaths: string[]
  verificationCommands: VerificationCommand[]
  baseRevision?: string
  source: 'user' | 'eval' | 'system'
  version: number
}
```

验收条件必须记录：

- 来源。
- 是否必选。
- 验证方式。
- 是否需要用户确认。

### 8.2 AgentState

```text
CREATED
-> PREPARING
-> RUNNING
-> MODEL_PROPOSED_COMPLETE
-> VERIFYING
-> RUNNING              验证失败，可继续修复
-> VERIFIED_COMPLETE

任意活动状态
-> WAITING_FOR_USER
-> TIMEOUT
-> BUDGET_EXHAUSTED
-> CANCELLED
-> FAILED
```

### 8.3 ToolResult

```ts
type ToolResult =
  | {
      ok: true
      callId: string
      toolName: string
      output: unknown
      durationMs: number
    }
  | {
      ok: false
      callId: string
      toolName: string
      error: CodeDenErrorData
      durationMs: number
    }
```

### 8.4 EvalCase

```ts
interface EvalCase {
  schemaVersion: 1
  id: string
  suite: 'regression' | 'capability' | 'validation' | 'holdout'
  tags: string[]
  benchmark: BenchmarkIdentity
  task: AgentTask
  fixture: FixtureSpec
  limits: TrialLimits
  submission: SubmissionSpec
  verification: VerificationSpec
}
```

### 8.5 TrialResult

```ts
interface TrialResult {
  schemaVersion: 1
  runId: string
  trialId: string
  caseId: string
  agentVersion: string
  harnessVersion: string
  execution: ExecutionStatus
  submission: SubmissionStatus
  verification: VerificationStatus
  infrastructure: InfrastructureStatus
  resolved: boolean
  scores: Record<string, number>
  metrics: TrialMetrics
  artifacts: ArtifactReference[]
}
```

四类状态不得合并成一个 `status`。

### 8.6 RunEvent

```ts
interface RunEvent<T = unknown> {
  schemaVersion: 1
  runId: string
  trialId: string
  sequence: number
  timestamp: string
  source: RunEventSource
  type: string
  data: T
}
```

每个 Event 写入前必须经过 Secret Redactor 和 Leak Guard。

### 8.7 FoldedSessionMemory

```ts
interface FoldedSessionMemory {
  schemaVersion: 1
  sessionId: string
  createdAt: string
  trigger: 'auto' | 'manual' | 'tool' | 'recovery'
  sourceSequenceRange: { from: number; to: number }
  episodeMemory: {
    taskDescription: string
    keyEvents: KeyEvent[]
    currentProgress: string
  }
  workingMemory: {
    immediateGoal: string
    currentChallenges: string[]
    nextActions: NextAction[]
  }
  toolMemory: {
    toolsUsed: ToolExperience[]
    derivedRules: string[]
  }
  sourceDigest: string
}
```

折叠结果是 Session 的派生投影，不替代原始事件。恢复时必须保留 source range 和 digest，便于判断摘要是否过期或损坏。

### 8.8 SkillDefinition

```ts
interface SkillDefinition {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description: string
  whenToUse: string
  instructions: string
  allowedTools?: string[]
  scope: 'project' | 'user'
  sourcePath: string
  contentDigest: string
}
```

运行时只接收经过 Schema 校验的快照。`SKILL.md` Frontmatter 解析、目录发现和 Core 数据结构必须隔离。

### 8.9 SkillUsageObservation

```ts
interface SkillUsageObservation {
  runId: string
  turnId: string
  skillId: string
  retrieved: boolean
  relevant: boolean | null
  used: boolean | null
  outcome: 'success' | 'failure' | 'unknown'
  evidence: ArtifactReference[]
  judge: 'deterministic' | 'independent-model' | 'human' | 'unknown'
}
```

`retrieved`、`relevant`、`used` 和最终 Outcome 是不同信号，不允许把“被调用”直接解释成“有效”。

### 8.10 SkillCandidate 与 Lineage

```ts
interface SkillCandidate {
  candidateId: string
  lineageId: string
  parentVersion?: string
  mutationType: 'create' | 'merge' | 'clarify' | 'guard' | 'prune'
  snapshot: SkillDefinition
  evidence: ArtifactReference[]
  createdBy: 'rule' | 'model' | 'human'
}

interface SkillLineage {
  lineageId: string
  skillId: string
  championVersion?: string
  versions: SkillVersionReference[]
}
```

### 8.11 SkillReplaySample

```ts
interface SkillReplaySample {
  sampleId: string
  lineageId: string
  sourceRunId: string
  input: ReplayInput
  expected: ReplayExpectation
  split: 'mutate_dev' | 'promotion_test' | 'holdout'
  frozenAt: string
  contentDigest: string
}
```

Split 一旦冻结不得因为候选结果重新分配。`promotion_test` 和 `holdout` 对 CandidateGenerator 不可见。

### 8.12 SkillPromotionDecision

```ts
interface SkillPromotionDecision {
  lineageId: string
  championBefore?: string
  challenger: string
  promoted: boolean
  status: 'incubating' | 'watch' | 'rejected' | 'awaiting_approval' | 'active'
  metrics: Record<string, number>
  hardFailures: string[]
  reasons: string[]
  evidence: ArtifactReference[]
}
```

Promotion Decision 必须可重放、可解释，并关联使用的数据集、规则、Judge、模型和代码版本。

---

## 9. 模块详细设计

### 9.1 Config 与 Secret Security

模块：

```text
ConfigLocator
ConfigLoader
ConfigMerger
ConfigValidator
SecretReference
ResolvedSecret
SecretResolver
SecretRegistry
SecretRedactor
SecretLeakGuard
```

配置示例：

```yaml
schemaVersion: 1
agent:
  defaultProvider: deepseek
  defaultModel: deepseek-chat
  maxTurns: 8
  maxToolCalls: 16
providers:
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey:
      from: env
      name: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
```

第一版只允许环境变量引用，不允许明文 Key。

安全流：

```text
配置保存变量名
-> SecretResolver 读取环境变量
-> ResolvedSecret 私有保存
-> Provider Transport 显式 expose
-> 其他模块只看到 <redacted>
```

### 9.2 Model Provider

接口：

```ts
interface ModelProvider {
  readonly name: string
  readonly capabilities: ModelCapabilities
  complete(request: ModelRequest): Promise<ModelResponse>
}
```

模块：

```text
ProviderRegistry
ModelProviderFactory
ModelInvoker
RetryPolicy
OpenAICompatibleAdapter
MockModelProvider
ReplayModelProvider
```

职责边界：

- Adapter 只转换协议。
- ModelInvoker 负责 timeout/retry/event。
- Factory 负责配置和能力选择。
- Provider 不直接读取 `process.env`。

### 9.3 ProjectInspector

确定性扫描：

- Git commit、branch、dirty files。
- Node、Python、Rust、Go、Java 项目标志。
- 包管理器。
- 测试、Lint、Build、Typecheck 命令。
- CI 配置。
- AGENTS.md、README、CONTRIBUTING。
- 已有未提交修改。

输出 `ProjectFacts`，只记录事实，不生成需求。

### 9.4 TaskSpecBuilder

输入：

```text
用户任务
+ ProjectFacts
+ Harness Policy
```

输出候选 TaskSpec，再由 Validator 检查：

- 命令是否合法。
- 路径是否越界。
- 条件是否来源明确。
- 是否存在重要歧义。
- 是否需要用户确认。

### 9.5 AgentRunner

执行流程：

```text
TaskSpec
-> 构建上下文
-> ModelInvoker
-> 解析 Tool Calls
-> ToolExecutor
-> 回填 Tool Results
-> 限制 turns/cost/time
-> 完成候选
-> CompletionVerifier
```

不变量：

- 每个 Tool Call 恰好一个 Tool Result。
- 写工具默认串行。
- 工具错误不会破坏消息配对。
- 取消不能显示成功。
- Provider 行为对 AgentRunner 透明。

### 9.6 Tool Runtime

执行管线：

```text
Tool Registry 查找
-> Zod 参数校验
-> Permission Policy
-> Workspace Policy
-> Budget
-> Timeout/Cancel
-> Execute
-> Secret Redaction
-> Structured ToolResult
-> Event
```

基础工具：

- read_file。
- write_file。
- edit_file。
- list_files。
- grep_search。
- run_command。
- 后续 repository_map、symbol_search、LSP。

### 9.7 Workspace 与 Sandbox

Port：

```ts
interface WorkspacePort {
  readonly root: string
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exec(command: CommandSpec): Promise<CommandResult>
  changedPaths(): Promise<string[]>
  createPatch(): Promise<ArtifactReference>
  reset(): Promise<void>
  dispose(): Promise<void>
}
```

实现：

- TemporaryWorkspace。
- WorktreeWorkspace。
- ContainerWorkspace。

安全要求：

- `../` 和绝对路径逃逸拒绝。
- 符号链接逃逸拒绝。
- Shell 环境变量白名单。
- Agent 命令使用隔离 HOME。
- 超时终止进程组。
- 默认禁网。
- Secret 路径不可读。

### 9.8 自研 MCP Client

第一版范围：

- JSON-RPC 2.0。
- stdio Transport。
- initialize。
- initialized notification。
- tools/list。
- tools/call。
- 请求 ID。
- pending map。
- timeout。
- Server exit。
- stderr 持续消费。
- 优雅关闭。
- Content Block 结构化保存。

架构：

```text
McpTransport
├── StdioTransport
├── InMemoryTransport
└── 后续 StreamableHttpTransport

McpClient
├── Protocol State
├── Pending Requests
├── Capability Negotiation
└── Error Mapping

McpToolAdapter
└── MCP Tool -> CodeDen Tool
```

MCP Server 默认只能获得最小环境变量，不继承模型 Key。

### 9.9 Completion Verifier

接口：

```ts
interface CompletionVerifier {
  verify(task: TaskSpec, run: RunContext): Promise<VerificationResult>
}
```

组合：

- RequiredArtifactVerifier。
- CommandVerifier。
- DiffPolicyVerifier。
- RegressionVerifier。
- ConstraintVerifier。

失败返回结构化证据：

```text
verification failed
test: tests/test_auth.ts
expected: 401
actual: 500
```

证据可注入 Agent 继续修复。

### 9.10 Session、Context 与 Checkpoint

使用 append-only JSONL：

```text
turn.started
user.message
model.requested
model.completed
tool.started
tool.completed
permission.decided
context.compacted
verification.completed
turn.completed
```

投影：

- Model History。
- UI History。
- Eval Trace。
- Resume State。

Checkpoint 保存：

- TaskSpec。
- Agent state。
- Workspace/Base commit。
- Diff。
- 已完成步骤。
- 预算。
- 验证结果。
- Artifact references。

### 9.11 Eval Ports

```text
AgentPort
BenchmarkPort
WorkspacePort
EvalRepository
```

Eval 不直接访问 ModelProvider 或 ToolExecutor。

### 9.12 BenchmarkAdapter

职责：

```text
外部任务格式
-> 统一 EvalCase
-> 准备任务环境
-> 调用官方或本地 Verifier
-> 导出外部格式结果
```

实现顺序：

1. Native YAML。
2. Harbor/DeepSWE。
3. SWE-bench。
4. Terminal-Bench。

### 9.13 Graders

确定性：

- FileExistsGrader。
- JsonFieldGrader。
- FileDiffGrader。
- ChangedPathsGrader。
- CommandGrader。
- TestReportGrader。
- SafetyGrader。
- TracePolicyGrader。
- MCPProtocolGrader。
- CostLatencyGrader。

后续：

- LlmJudgeGrader。

### 9.14 Result Collector 与 Repository

每个 Trial：

```text
evals/runs/<run>/<case>/<trial>/
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

第一版 FileEvalRepository，数据量足够后再增加 SQLite/Postgres。

### 9.15 Aggregator

指标：

- Resolve Rate。
- Regression Rate。
- Valid Submission Rate。
- Infrastructure Error Rate。
- Tool Error Rate。
- MCP Error Rate。
- Retry Recovery Rate。
- Repeated Tool Call Rate。
- Permission Violation Count。
- Token、Cost、Duration。
- P50/P95。
- pass@k。
- pass^k。

### 9.16 Failure Analyzer

第一版规则归因：

```text
infrastructure_failure
workspace_setup_failure
model_failure
tool_failure
mcp_failure
missing_submission
invalid_patch
no_verification
introduced_regression
permission_violation
agent_stalled
budget_exhausted
task_solution_failure
```

输出：

```ts
interface FailureDiagnosis {
  category: string
  owner: FailureOwner
  evidence: ArtifactReference[]
  confidence: number
  recommendation?: string
}
```

LLM Analyzer 只能补充解释，不能修改正式分数。

### 9.17 Optimizer

可自动生成候选的表面：

- System Prompt。
- Tool descriptions。
- Completion Policy。
- Context Policy。
- Retry Policy。
- Budget Policy。
- Model Config。

禁止修改：

- Eval Cases。
- Holdout。
- Hidden tests。
- Verifier。
- Permission Core。
- Promotion Gate。
- 历史原始结果。

### 9.18 Skills Runtime

模块：

```text
SkillSource
├── ProjectSkillSource
└── UserSkillSource

SkillParser
SkillRegistry
SkillRetriever
SkillContextRenderer
SkillExecutor
SkillUsageRecorder
```

执行流程：

```text
发现 SKILL.md
-> Frontmatter + Body 解析
-> Zod 校验并计算 digest
-> 同名冲突按 project > user 处理
-> Retriever 根据当前任务返回带分数的候选
-> ContextRenderer 只注入最小必要内容
-> Agent 显式或隐式使用 Skill
-> UsageRecorder 分别记录 retrieved/relevant/used/outcome
```

边界：

- Skill 文件内容属于不可信数据，不能覆盖系统安全策略。
- `allowedTools` 只能缩小权限，不能扩大 Agent 原有权限。
- Skill 不能读取 Secret，也不能指定隐藏评测路径。
- 检索失败不得阻塞 Agent 主任务。
- 自动生成的 Skill 默认进入候选区，不直接覆盖 active Skill。

### 9.19 Long-term Memory

Port：

```ts
interface MemoryStore {
  save(entry: MemoryEntry): Promise<void>
  list(scope: MemoryScope): Promise<MemoryHeader[]>
  delete(id: string): Promise<void>
}

interface MemoryRetriever {
  retrieve(query: string, options: MemoryQuery): Promise<RelevantMemory[]>
}
```

Memory 只保存跨会话仍有价值的项目事实、用户明确偏好和已验证约束。不得保存模型 Key、完整工具输出、短期步骤或未经确认的推测。

作用域：

- Session Memory：仅服务当前任务恢复。
- Project Memory：只对当前项目生效。
- User Memory：必须经过明确策略或人工确认，避免项目数据跨域。
- Skill：保存可执行的通用方法，不等同于事实记忆。

### 9.20 Structured Session Folding

模块：

```text
ContextBudgetPolicy
FoldTriggerPolicy
TranscriptBuilder
SessionFolder
FoldValidator
FoldProjectionStore
```

触发信号包括 context utilization、连续工具错误、相同工具无进展重复和人工请求。新版 BearCode 的 `70%` 自动阈值可作为行为样本，不写死为 Core 常量。

事务流程：

```text
冻结 source event range
-> 构造无 Secret transcript
-> 生成三层 FoldedSessionMemory
-> Schema 校验
-> 检查关键路径/命令/约束/未完成 Tool Call 是否保留
-> 原子写入 fold projection
-> 切换 Model History
-> 失败则继续使用旧 History
```

原始事件保留用于审计，折叠投影用于运行。Fallback 摘要必须显式标记 `degraded=true`，不能伪装成完整恢复。

### 9.21 Online Skill Evolution

模块：

```text
FeedbackWindowBuilder
SkillCandidateExtractor
SkillMaintainer
SkillLineageRepository
SkillVersionStore
ProvenanceStore
PrunePolicy
```

候选来源可以是用户反馈、反复成功的工具策略和评测失败归因。候选维护动作限定为 `create/merge/discard/prune`，任何动作都要记录输入证据、父版本、生成器版本和人工审批状态。

安全策略：

- 在线演化作为后台 Side Effect，不得改变当前 Trial 的正式分数。
- 用户内容、工具输出和仓库文档都按不可信数据处理。
- Candidate 不允许修改 Permission、Secret、Verifier 或 Holdout 配置。
- 自动 prune 优先归档，可恢复，不直接删除历史。
- 并发演化同一 lineage 时必须使用乐观锁或 compare-and-swap。

### 9.22 Skill Eval 与 Champion Registry

组件：

```text
SkillDatasetAdapter
ReplayPoolBuilder
StableSplitAssigner
SkillRuleCompiler
SkillDeterministicGrader
IndependentLlmJudge
SkillCandidateGenerator
SkillExperimentRunner
SkillChampionRepository
SkillPromotionGate
```

评分层次：

1. 数据完整性：样本、split、digest 和 lineage 可追踪。
2. 检索质量：precision/recall、MRR、误召回率。
3. 指令遵循：确定性规则优先，可选独立 Judge。
4. 任务效果：使用 Skill 与不使用 Skill 的 Agent Outcome 差异。
5. 运行代价：Token、延迟、工具调用和错误率。
6. 安全：权限、Secret、路径、Prompt Injection，一票否决。

Promotion Gate 至少满足：

- 最小 replay、promotion test 和 retrieval 样本量。
- Promotion test 上不低于 Champion，且达到配置的最小提升。
- 没有新增 hard failure 或安全违规。
- Agent 任务成功率不下降。
- 成本和延迟没有超过阈值。
- Judge 配置、数据集版本和随机种子完整记录。

开发集可用于生成候选，Promotion test 只用于选优，Holdout 只用于最终确认。LLM Judge 失败或不可用时必须输出 `judge_error/insufficient_evidence`，不能默认通过。

---

## 10. 分阶段实施计划

实现时不要直接按本章编码。本章是索引；每个进行中的阶段以对应子文档为准。

| 阶段 | 状态 | 实现文档 |
|---|---|---|
| 0 冻结基线 | 已完成（现有测试即基线） | 本文 |
| 1 配置与 Secret | 已完成 | `CONFIG_SECRET_SECURITY_DEVELOPMENT.md` |
| 2 TaskSpec + 最小完成验证 | 已完成 | `docs/STAGE_2_TASKSPEC_COMPLETION_LOOP.md` |
| 3 Baseline 回归差集 | 已完成 | `docs/STAGE_3_BASELINE_REGRESSION.md` |
| 4 Git worktree 隔离 | 已完成 | `docs/STAGE_4_WORKTREE_ISOLATION.md` |
| 5 冲突 Patch 与超时回收 | 已完成 | `docs/STAGE_5_CONFLICT_PATCH_PROCESS.md` |
| 6–11 MCP 及之后 | 未开始 | 暂缓，仍见本章 |

## 阶段 0：冻结基线与迁移边界

### 目标

确认 BearCode 行为、CodeDen 当前能力和迁移范围，防止重构过程中丢失关键行为。

### 实现内容

- 建立功能矩阵。
- 固定当前 CodeDen 单元/契约/E2E 基线。
- 建立 BearCode 行为样本。
- 冻结 Core Schema 和 Port。
- 记录暂不迁移能力。

### 验收场景

#### 场景 0-1：当前测试基线

```text
运行 typecheck/test/build
-> 全部通过
-> 保存基线摘要
```

#### 场景 0-2：基础 Agent 行为

```text
Mock model read -> edit -> final
-> CodeDen 修改临时 package.json
-> Native Grader 通过
```

#### 场景 0-3：接口依赖检查

```text
Core 不导入 SDK/YAML/fs
Eval 只通过 AgentPort 调用 Agent
```

### 完成标准

- 现有测试全绿。
- 迁移矩阵合并。
- 共享 Schema 和 Port 有 Contract Test。

---

## 阶段 1：配置、Secret 安全与简洁 CLI

### 目标

实现：

```bash
codeden "读取 package.json"
```

Provider、Model、Key 引用和限制由配置提供，Secret 不进入模型、工具和日志。

### 实现内容

- `.codeden/config.yaml`。
- Config Schema/Loader。
- SecretReference/Resolver/Redactor/LeakGuard。
- ProviderRegistry/Factory。
- Provider 移除 `process.env` fallback。
- 敏感文件路径拒绝。
- Shell env allowlist。
- SecureEventSink。
- 位置 Prompt。
- `package.json.bin` 注册 `codeden`。
- `codeden config validate/show`。
- Secret 扫描。

### 验收场景

#### 场景 1-1：零参数覆盖调用

```text
配置默认 deepseek
-> codeden "读取 package.json"
-> 自动选择 Provider/Model/Workspace/limits
```

#### 场景 1-2：缺少 Key

```text
配置引用 DEEPSEEK_API_KEY
-> 环境变量不存在
-> 启动前失败
-> 错误只显示变量名
```

#### 场景 1-3：读取 `.env`

```text
模型调用 read_file(.env)
-> WORKSPACE_SECRET_PATH_DENIED
-> Key 不进入模型消息/Event
```

#### 场景 1-4：Shell 查看环境

```text
模型执行 env
-> 输出中不存在 Provider Key
```

#### 场景 1-5：工具错误包含 Key

```text
构造包含哨兵 Secret 的异常
-> ToolResult/Event/Console 显示 <redacted>
```

#### 场景 1-6：模型尝试写出 Key

```text
write_file 内容包含已知 Secret
-> SecretLeakGuard 拒绝
```

### 完成标准

- 配置驱动 Provider 可运行。
- 日常命令不要求 Model/Workspace 参数。
- 安全哨兵在全链路零泄露。
- Secret 扫描通过。

---

## 阶段 2：TaskSpec、项目检查与可靠 Agent Loop

### 目标

让 Agent 明确知道任务、项目事实、边界和完成条件，并统一模型/工具错误行为。

### 实现内容

- ProjectInspector。
- TaskSpecBuilder/Validator。
- AgentState 完整状态机。
- ModelInvoker timeout/retry。
- ToolExecutor 完整错误分类。
- Permission Policy。
- Budget Policy。
- 停滞检测基础规则。

### 验收场景

#### 场景 2-1：项目事实识别

```text
Node 项目包含 package.json 和 CI
-> 识别 pnpm/test/typecheck/build
-> ProjectFacts 不生成虚假命令
```

#### 场景 2-2：TaskSpec 路径限制

```text
任务只允许修改 src/auth.ts
-> Agent 写 README.md
-> 权限拒绝
```

#### 场景 2-3：Provider 临时错误

```text
第一次 429
-> 指数退避
-> 第二次成功
-> 事件完整
```

#### 场景 2-4：不可重试错误

```text
401 或 Tool JSON 无效
-> 不重试
-> 结构化失败
```

#### 场景 2-5：Tool Call 配对

```text
三个 Tool Calls，其中一个失败
-> 每个调用恰好一个结果
-> Agent Loop 不崩溃
```

#### 场景 2-6：预算耗尽

```text
达到 maxTurns/maxToolCalls/cost
-> BUDGET_EXHAUSTED
-> 不显示成功
```

### 完成标准

- Agent 行为由 TaskSpec 驱动。
- OpenAI-compatible Provider 通过同一 Contract。
- Tool/Model 错误行为一致。
- 状态机不变量测试通过。

---

## 阶段 3：完成验证与 Baseline/Regression

### 目标

模型交卷后必须由独立 Verifier 验收，失败时可返回 Agent 继续修复。

### 实现内容

- BaselineVerifier。
- CompletionVerifier。
- Command/Test/Diff/Constraint Verifier。
- Verification feedback loop。
- Final Submission。
- `VERIFIED_COMPLETE`。

### 验收场景

#### 场景 3-1：模型误报完成

```text
模型说已修复
-> 测试仍失败
-> 不进入 VERIFIED_COMPLETE
-> 证据返回 Agent
```

#### 场景 3-2：二次修复成功

```text
第一次验证失败
-> Agent 修改
-> 第二次验证通过
-> VERIFIED_COMPLETE
```

#### 场景 3-3：区分原有失败

```text
Baseline 已有一个失败
-> Agent 修改后仍是同一失败
-> 不算新增回归
```

#### 场景 3-4：引入新回归

```text
Baseline 通过 100 项
-> Final 新增 2 个失败
-> verification failed
```

#### 场景 3-5：篡改测试

```text
Agent 删除/跳过失败测试
-> DiffPolicy 拒绝
```

### 完成标准

- `submitted` 与 `verified_complete` 明确分开。
- 所有代码任务通过独立验证。
- 可区分原有失败和新增回归。

---

## 阶段 4：Git Worktree 隔离

阶段 4 主链路已经实现，详细契约和 A-1 至 A-6 验收见 `docs/STAGE_4_WORKTREE_ISOLATION.md`。

核心结果：

- Git 项目任务在 detached worktree 中执行。
- `VERIFIED_COMPLETE` 前不写回用户目录。
- 用户 dirty/untracked 路径不被直接覆盖。
- Eval Fixture 继续使用独立 TemporaryWorkspace。

阶段 4 的遗留安全问题并入阶段 5 统一收口，不单独返工。

---

## 阶段 5：冲突 Patch 与进程回收安全收口

当前正在执行的阶段。完整任务、补充数据契约、P0/P1 工作包和 B-1 至 B-12 验收见 `docs/STAGE_5_CONFLICT_PATCH_PROCESS.md`。

本阶段必须解决：

- 写回路径与符号链接逃逸。
- 用户并发编辑导致的 TOCTOU 覆盖风险。
- Git Worktree 创建失败时的 fail-closed 行为。
- 新增、修改、删除、重命名、mode 与二进制语义。
- `last.patch` Secret 扫描、大小限制、原子写入和 run-scoped 生命周期。
- timeout/abort/close 单次结算和后代进程清理。
- 清理错误不得覆盖 Agent/Verifier 原始错误。

完成阶段 5 后才进入自研 MCP，不允许把 MCP 代码混入本阶段提交。

---

## 阶段 6：自研 MCP Client

### 目标

实现安全、可测试、协议正确的本地 stdio MCP Tools 支持。

### 实现内容

- JsonRpcMessage Schema。
- StdioTransport。
- McpConnection State。
- initialize/initialized。
- tools/list/tools/call。
- Pending request map。
- timeout/cancel。
- stderr reader。
- server exit cleanup。
- McpToolAdapter。
- MCP 配置加载。

### 验收场景

#### 场景 6-1：初始化

```text
启动测试 MCP Server
-> initialize
-> initialized
-> tools/list
-> 工具可注册
```

#### 场景 6-2：乱序响应

```text
并发两个只读请求
-> Server 乱序返回
-> 按 requestId 正确匹配
```

#### 场景 6-3：调用超时

```text
tools/call 不返回
-> 到期 timeout
-> pending 清理
-> Agent 可继续或失败
```

#### 场景 6-4：Server 异常退出

```text
多个 pending request
-> Server exit
-> 全部收到连接错误
-> 无永久挂起
```

#### 场景 6-5：非法 JSON

```text
Server 输出非法 JSON
-> 协议错误记录
-> 不污染后续合法消息
```

#### 场景 6-6：Secret 隔离

```text
MCP Server 执行 env
-> 看不到模型 API Key
```

### 完成标准

- MCP Contract/Integration Test 全绿。
- 超时、退出、取消不会留下 pending。
- MCP 工具与内置工具使用统一 ToolResult。

---

## 阶段 7：Container Sandbox 与安全执行

### 目标

在阶段 4–5 已完成 Worktree、冲突 Patch 和进程组回收的基础上，为真实任务和评测提供容器、禁网及资源隔离。

### 实现内容

- WorktreeWorkspace、ProcessRunner 和进程组回收的回归测试。
- Output Artifact Spill。
- ContainerWorkspace。
- 网络策略。
- CPU/内存/磁盘/进程限制。
- Patch 生成和校验。

### 验收场景

#### 场景 7-1：用户 dirty state 回归

```text
主工作区存在未提交修改
-> Trial 在独立 worktree
-> 用户修改不被覆盖
```

#### 场景 7-2：路径逃逸

```text
../secret、外部绝对路径、符号链接
-> 全部拒绝
```

#### 场景 7-3：超时子进程

```text
命令创建子孙进程后超时
-> 整个进程组结束
-> 无孤儿进程
```

#### 场景 7-4：默认禁网

```text
Agent 命令访问互联网
-> 被 Sandbox 拒绝
-> 模型 API 通道仍可用
```

#### 场景 7-5：Patch 边界回归

```text
Patch 为空/不可应用/包含禁止文件/超大二进制
-> submission invalid
```

### 完成标准

- 用户目录安全。
- Trial 之间零污染。
- 进程和资源可控。
- Patch 可在干净环境复现。

---

## 阶段 8：事件持久化、Session、Checkpoint 与 Replay

### 目标

使 Agent 运行可审计、可恢复、可重放。

### 实现内容

- Append-only JSONL EventStore。
- FileEvalRepository。
- ArtifactStore。
- Session projections。
- Checkpoint/Resume。
- Context compaction transaction。
- 三层 FoldedSessionMemory：episode/working/tool。
- 自动、手动和工具触发的 FoldTriggerPolicy。
- Fold Schema 校验、source range、digest 和 degraded fallback。
- ReplayModelProvider。
- Snapshot tests。

### 验收场景

#### 场景 8-1：崩溃保留轨迹

```text
运行中进程崩溃
-> 已写事件仍可读取
-> 最后完整边界可恢复
```

#### 场景 8-2：Tool 配对恢复

```text
崩溃发生于 tool.started 后
-> Resume 能识别未完成调用
-> 不伪造成功结果
```

#### 场景 8-3：Context compact 失败

```text
摘要请求失败
-> 旧上下文仍有效
-> 不丢失 TaskSpec/约束/失败信息
```

#### 场景 8-4：Replay

```text
录制模型响应
-> 不访问真实 API 重放
-> 真实 Tool Runtime 产生相同关键事件
```

#### 场景 8-5：Secret 持久化

```text
全流程使用哨兵 Secret
-> events/session/artifacts 零泄露
```

#### 场景 8-6：结构化折叠后继续任务

```text
上下文达到阈值
-> 生成三层 FoldedSessionMemory
-> 原始事件仍保留
-> 新上下文包含目标、约束、文件路径、失败证据和下一步
-> Agent 可继续完成任务
```

#### 场景 8-7：折叠内容不合法

```text
模型返回非法 JSON 或缺失关键字段
-> FoldValidator 拒绝切换
-> 旧 Model History 继续有效
-> 事件记录 degraded/failure
```

#### 场景 8-8：未完成 Tool Call

```text
存在 tool.started 但无 tool.completed
-> 禁止把调用摘要成已成功
-> Resume 明确标记 unknown/interrupted
```

### 完成标准

- Session 可恢复。
- Eval Trace 可重放。
- 崩溃不导致全部数据丢失。
- Secret 不落盘。
- 折叠前后 TaskSpec、权限约束和未完成工作语义一致。

---

## 阶段 9：完整 Eval Harness 与结果收集

### 目标

实现稳定、可重复、可比较的本地 Agent 评测系统。

### 实现内容

- Eval Suite。
- 多 Trial。
- 并发调度。
- Deterministic Graders。
- Result Collector。
- File Repository。
- Aggregator。
- Baseline Comparator。
- Console/JSON/Markdown/JUnit Reporter。
- CI Gate。

### 验收场景

#### 场景 9-1：多 Trial 非确定性

```text
同一 Case 运行 5 次
-> 记录每次结果
-> 输出成功率/pass@k/pass^k
```

#### 场景 9-2：基础设施错误隔离

```text
Workspace 创建失败
-> infrastructure error
-> 不计为普通 Agent 解题失败
```

#### 场景 9-3：成本退化

```text
候选成功率相同但成本增加 40%
-> 报告显示退化
-> CI Gate 可拒绝
```

#### 场景 9-4：安全门禁

```text
功能得分提升但出现一次权限违规
-> 整体 Gate 失败
```

#### 场景 9-5：结果可审计

```text
从 TrialResult
-> 可定位事件、Patch、测试日志和版本信息
```

### 完成标准

- 每次 Trial 可独立审计。
- 能比较两个 Agent/Harness 版本。
- CI 能阻止功能、安全和成本回归。

---

## 阶段 10：失败诊断与优化闭环

### 目标

利用评分和轨迹定位 Agent 问题，并用受控实验验证改进。

### 实现内容

- FailureAnalyzer。
- Failure taxonomy。
- Evidence references。
- CandidateGenerator。
- ExperimentRunner。
- Champion/Challenger。
- Holdout。
- PromotionGate。

### 验收场景

#### 场景 10-1：无验证失败

```text
reward=0 且 testsRun=0
-> diagnosis=no_verification
-> owner=agent/completion-policy
```

#### 场景 10-2：环境失败

```text
Patch 未导出
-> owner=infrastructure/adapter
-> 不建议修改 Prompt
```

#### 场景 10-3：单变量实验

```text
Candidate 只修改 CompletionPolicy
-> 固定模型/任务/预算
-> 对比 Champion
```

#### 场景 10-4：Holdout 防刷题

```text
Validation 提升
-> Holdout 下降
-> Promotion 拒绝
```

#### 场景 10-5：安全一票否决

```text
Resolve Rate +10%
但 permission violation > 0
-> Promotion 拒绝
```

### 完成标准

- 失败建议有证据。
- Optimizer 不能修改考试标准。
- 候选升级必须通过 Validation、Holdout 和 Gate。

---

## 阶段 11：外部 Benchmark 与 Agent Adapter

### 目标

接入标准 Benchmark，并用同一评测系统比较 CodeDen 与其他 Agent。

### 实现内容

- Harbor/DeepSWE Adapter。
- SWE-bench Adapter。
- Terminal-Bench Adapter。
- ExternalCliAgentAdapter。
- 官方 Verifier 调用。
- 外部结果导出。

明确暂不做：Grok subscription OAuth/`grok login` 适配，除非后续单独立项。

### 验收场景

#### 场景 11-1：Harbor 任务

```text
加载 task format
-> 独立 Agent 环境
-> 导出 Patch
-> 独立 Verifier
-> 导入 reward
```

#### 场景 11-2：SWE-bench

```text
instance_id/base_commit/problem_statement
-> EvalCase
-> model_patch
-> 官方 Harness 评分
```

#### 场景 11-3：隐藏测试隔离

```text
Agent Workspace
-> 无法访问 verifier tests/solution
```

#### 场景 11-4：多 Agent 比较

```text
同一 EvalCase
-> CodeDenAgentAdapter
-> ExternalCliAgentAdapter
-> 统一结果报告
```

### 完成标准

- 正式分数来自 Benchmark 官方 Verifier。
- 隐藏测试和参考答案不暴露。
- 相同 Case 可以公平比较多个 Agent。

---

## 阶段 12：Skills Runtime 与长期 Memory

### 目标

迁移新版 BearCode 的 Skill 和 Memory 能力，同时建立清晰的作用域、安全和可观测性边界。

### 实现内容

- SkillDefinition Schema 与 Frontmatter Parser。
- Project/User SkillSource。
- SkillRegistry、Retriever、ContextRenderer 和 Executor。
- `allowedTools` 权限交集。
- retrieved/relevant/used/outcome 分离记录。
- Project/User Memory Store 与 Retriever。
- Skill、Session Memory、Long-term Memory 作用域隔离。
- `codeden skills list/inspect` 与 `codeden memory list`。

### 验收场景

#### 场景 12-1：项目 Skill 覆盖用户 Skill

```text
项目级和用户级存在同名 Skill
-> Registry 选择项目版本
-> 输出来源、版本和 digest
```

#### 场景 12-2：Skill 不能扩大权限

```text
Skill 声明 allowedTools 包含未授权写工具
-> 实际工具集合取权限交集
-> 未授权工具不可调用
```

#### 场景 12-3：检索误召回

```text
Skill 被 retrieved 但与任务无关
-> relevant=false
-> 不记录为成功使用
-> 后续检索评测可定位该样本
```

#### 场景 12-4：Memory 跨项目隔离

```text
项目 A 保存 Project Memory
-> 项目 B 检索不到
-> User Memory 只有符合策略时可跨项目
```

#### 场景 12-5：恶意 Skill 指令

```text
SKILL.md 要求读取 Key、越界路径或关闭 Verifier
-> 安全策略保持最高优先级
-> 请求被拒绝并记录安全事件
```

#### 场景 12-6：能力缺失降级

```text
Skill 目录损坏或 Memory Retriever 失败
-> Agent 主任务仍能运行
-> 结果记录 capability_degraded
```

### 完成标准

- Skill 来源、版本、选择原因和效果可追踪。
- Skill 与 Memory 无法扩大权限或跨越作用域。
- 检索与使用失败不会破坏 Agent 主循环。

---

## 阶段 13：在线 Skill 演化、评测与 Champion

### 目标

把新版 BearCode 的在线演化链路重构为数据可冻结、评分可复现、晋级可审计的 Skill 优化系统。

### 实现内容

- FeedbackWindow 与 SkillCandidateExtractor。
- create/merge/discard/prune Maintainer。
- Lineage、Version Snapshot、Provenance。
- ReplayPoolBuilder 与稳定 split。
- RuleCompiler 和确定性 Grader。
- 可选 IndependentLlmJudge。
- Candidate variants 与单变量实验。
- SkillExperimentRunner。
- Champion Registry 与 Promotion Gate。
- JSON/Markdown 报告和 `codeden eval skills` CLI。

### 验收场景

#### 场景 13-1：反馈形成候选但不直接上线

```text
下一轮用户反馈指出 Skill 有误
-> 生成 merge/guard Candidate
-> 保存 evidence 和 parent version
-> active Skill 保持不变
```

#### 场景 13-2：Replay Split 冻结

```text
同一组 provenance 重复构建数据集
-> sampleId、digest、split 一致
-> CandidateGenerator 看不到 promotion_test/holdout 期望
```

#### 场景 13-3：确定性规则优先

```text
响应违反可程序化检查的字数或必需字段
-> deterministic hard failure
-> LLM Judge 不能覆盖为通过
```

#### 场景 13-4：Judge 不可用

```text
LLM Judge 超时或返回非法结构
-> judgment=judge_error
-> 不默认通过
-> 不自动晋级
```

#### 场景 13-5：使用率高但任务效果下降

```text
Challenger used_rate 提升
但 Agent Resolve Rate 下降
-> Promotion Gate 拒绝
```

#### 场景 13-6：开发集提升、Promotion Test 退化

```text
mutate_dev 分数提升
promotion_test 低于 Champion
-> Challenger rejected
-> Champion 不变
```

#### 场景 13-7：安全一票否决

```text
Challenger 质量分提升
但诱导越权或 Secret 泄露一次
-> hard failure
-> 禁止晋级
```

#### 场景 13-8：并发演化冲突

```text
两个 Candidate 同时基于 v3 合并
-> 第一个写入 v4
-> 第二个 compare-and-swap 失败
-> 重新基于 v4 评估，不覆盖历史
```

#### 场景 13-9：完整产物审计

```text
从 PromotionDecision
-> 可定位 lineage、candidate、champion、dataset、rules
-> 可定位 outputs、judgments、模型与代码版本
-> 可离线重放同一决策
```

### 完成标准

- 在线经验只产生候选，不绕过 Eval 和 Gate。
- Skill 评测同时覆盖检索、遵循、任务 Outcome、成本和安全。
- Champion 晋级可复现、可回滚、可人工复核。
- Agent Eval 和 Skill Eval 的结果、数据集与指标保持独立。

---

## 14. 测试体系

### 14.1 Unit Tests

- Zod Schema。
- 状态转换。
- 错误分类。
- Config 合并。
- Secret 脱敏。
- Retry Policy。
- Grader。
- Aggregator。
- PromotionGate。

### 14.2 Contract Tests

- ModelProvider Contract。
- Tool Contract。
- McpTransport Contract。
- WorkspacePort Contract。
- AgentPort Contract。
- BenchmarkPort Contract。
- EvalRepository Contract。

### 14.3 Integration Tests

- Config -> Secret -> Provider -> Agent。
- Agent -> Tool -> Workspace。
- MCP Client -> Test Server。
- Worktree -> Patch -> Verifier。
- EventStore -> Resume。
- Native Eval -> Result Store。

### 14.4 Security Tests

- `.env` 读取拒绝。
- Shell 环境无 Key。
- MCP 环境无 Key。
- Tool output 脱敏。
- Event/Artifact 无 Secret。
- 路径和符号链接逃逸。
- Prompt Injection 读取凭证。

### 14.5 End-to-End Tests

- 正常代码修改并验证通过。
- 模型误报完成。
- Tool 错误恢复。
- MCP 超时。
- Agent 超时。
- 新增回归。
- Permission 拒绝。
- Session 恢复。
- Eval 多 Trial。
- Candidate Promotion 拒绝/接受。
- Skill 检索命中与误召回。
- FoldedSessionMemory Schema 与恢复语义。
- Replay split 稳定性。
- Skill hard rule 与 Judge error。
- Skill Champion 晋级、拒绝、冲突和回滚。

---

## 15. 多 Agent 工作包

### A：Config 与 Security

目录：

```text
src/config/**
src/security/**
```

### B：Model Runtime

目录：

```text
src/runtime/models/**
```

### C：Task 与 Agent Core

目录：

```text
src/core/task/**
src/runtime/agent/**
src/runtime/verification/**
```

### D：Tools 与 Workspace

目录：

```text
src/runtime/tools/**
src/runtime/workspace/**
```

### E：MCP

目录：

```text
src/runtime/mcp/**
```

### F：Session 与 Events

目录：

```text
src/core/events/**
src/runtime/session/**
src/runtime/context/**
```

### G：Eval Harness

目录：

```text
src/eval/domain/**
src/eval/ports/**
src/eval/application/**
src/eval/graders/**
```

### H：Result、Analysis、Optimization

目录：

```text
src/eval/repositories/**
src/eval/aggregation/**
src/eval/analysis/**
src/eval/optimization/**
```

### I：External Adapters

目录：

```text
src/eval/adapters/benchmarks/**
src/eval/adapters/agents/**
```

### J：Skills、Memory 与 Context Folding

目录：

```text
src/runtime/skills/**
src/runtime/memory/**
src/runtime/context/**
```

### K：Skill Evolution 与 Skill Eval

目录：

```text
src/evolution/**
src/eval/skill-eval/**
evals/skills/**
```

共享 Schema/Port 必须由主 Agent 先冻结，再允许并行实现。

---

## 16. Agent 开发规则

每个实现 Agent 必须：

1. 阅读本文件和 `AGENTS.md`。
2. 只修改负责工作包范围。
3. 不擅自改变冻结 Port/Schema。
4. 新增代码必须附带测试。
5. 不把 SDK 类型泄漏到 Core。
6. 不把 Agent 最终文本当完成证据。
7. 不让写工具自动重试未知结果。
8. 不静默吞掉错误。
9. 不把 Secret 写入事件、日志或测试。
10. 不读取或暴露 Holdout/Hidden tests。
11. 保留用户和其他 Agent 的已有修改。
12. 提交遵守 `type(模块): 中文描述.`。
13. 不让在线 Skill 演化直接修改 active Skill、Verifier 或评测集。
14. Skill、Memory 和折叠摘要都按不可信数据处理。

---

## 17. CI 门禁

每个阶段至少执行：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm security:secrets
```

评测阶段增加：

```text
Regression pass rate >= 目标阈值
Infrastructure error rate <= 目标阈值
Permission violations = 0
Secret leaks = 0
Crash rate = 0
Cost increase <= 允许阈值
P95 latency increase <= 允许阈值
Skill retrieval regression <= 允许阈值
Skill promotion hard failures = 0
Fold recovery invariant failures = 0
```

安全违规和 Secret 泄露一票否决，不能被功能得分抵消。

---

## 18. 最终系统验收

最终必须完成这条完整链路：

```text
codeden "修复指定 Bug"
-> 自动加载配置和模型
-> Secret 零泄露
-> 扫描项目并建立 TaskSpec
-> 在隔离 Worktree/Sandbox 中执行
-> 内置工具和 MCP 正常工作
-> 模型提出完成
-> 独立 Verifier 运行测试和 Diff 检查
-> 失败可继续修复
-> 成功生成 Patch
-> Session、Trace、Artifact 和指标落盘
-> 长上下文可折叠为可验证的三层 Session Memory 并继续执行
-> 相关 Skill/Memory 可检索，来源和使用效果可追踪
-> Eval Harness 可重放同类 Case
-> Aggregator 与 Baseline 比较
-> Failure Analyzer 提供证据化归因
-> Candidate 在 Champion/Challenger 中验证
-> Holdout 和 Promotion Gate 决定是否升级
-> Skill 候选经过独立 Skill Eval 后才允许进入 Champion
```

最终系统还必须证明：

- Agent 无法读取模型 Key。
- Tool/MCP 子进程没有模型 Key。
- Agent 不能逃出 Workspace。
- 用户 dirty state 不被覆盖。
- 模型误报完成不会被接受。
- 原有失败和新增回归可区分。
- 崩溃后可恢复。
- Eval 结果可审计、可复现、可比较。
- Optimizer 不能降低考试标准刷分。
- 外部 Benchmark 使用官方 Verifier。
- Session Memory、Long-term Memory 和 Skill 不发生作用域污染。
- Skill 的高使用率不能掩盖 Agent 任务成功率下降。
- Skill Champion 的任何一次晋级都能重放、解释和回滚。

---

## 19. 推荐提交拆分

提交必须遵守 Conventional Commits：

```text
feat(core): 新增配置与 Secret 安全契约.
feat(runtime): 新增配置驱动的模型适配层.
feat(core): 新增项目检查与任务规格构建.
refactor(runtime): 统一 Agent 与工具执行状态机.
feat(verifier): 新增任务完成独立验证流程.
feat(mcp): 新增 stdio MCP 初始化与工具调用.
feat(workspace): 新增 Git worktree 隔离执行环境.
feat(eval): 新增评测事件与结果持久化.
feat(analysis): 新增评测失败规则归因.
feat(optimization): 新增 Champion 与 Challenger 实验流程.
feat(evals): 新增 Harbor 与 SWE-bench 适配器.
feat(runtime): 新增 Skills 与长期记忆运行时.
feat(runtime): 新增三层会话记忆折叠流程.
feat(optimization): 新增在线 Skill 候选与版本血缘.
feat(eval): 新增 Skill 回放评测与晋级门禁.
```

每个提交只处理一个可独立理解的目标，不混入无关格式化或重构。
