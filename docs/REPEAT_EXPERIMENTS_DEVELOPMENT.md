# 重复评测与同条件对比 · 技术实施方案

更新日期：2026-09-04。状态：实施方案（待实施）。

本方案落实 [重复评测实验 P0 需求规格](prd/eval-repeat-experiments.md) 与 [闭环 PRD](prd/eval-platform-closed-loop.md) 中标注为 P0 的能力，范围限定在评测平台（`apps/eval-platform`）与评测引擎（`packages/eval-engine`）的既有链路上做增量改造。不改变 Agent 终端（`apps/agent`）的会话、写回行为，也不涉及线上 Trace 接收、LLM 评审、Champion/Challenger（见文末「非目标」）。

---

## 1. 现状与差距

当前平台已有：PostgreSQL 任务存储（`eval_jobs`/`eval_benchmark_runs`/`eval_trials`/`eval_events`）、pg-boss 队列、Job 级原子领取与心跳、取消/中断恢复、SSE 事件流、Next.js 页面（总览/评测集/历史/详情/实时 Trial）。

与 P0 规格的差距：

| 差距 | 现状 |
|---|---|
| 重复执行模型 | `catalog.repeatCases` 把题目复制成 `caseId#n` 副本，复用「一个 case = 一次 Trial」的旧模型 |
| Trial 身份 | 无 `(caseId, repetitionIndex)` 唯一键；`trialId` 由 `TrialRunner` 运行时生成，无预先冻结的计划 |
| 生命周期 | 只有 Job/BenchmarkRun 状态；Trial 无 lifecycle/verdict 分离 |
| 故障重试 | `PlatformEvalRepository.saveTrial` 用 `onConflictDoNothing` 防重复计数，但无 ExecutionAttempt/ScoreAttempt、无租约 fencing |
| 统计口径 | `JobSummary.passedCases/failedCases` 把未判定与未完成混入失败；无 P/F/U/M、无 Wilson 区间、无 statisticsVersion |
| 历史查询 | `GET /api/jobs` 只有 offset/limit 分页，无服务端筛选；无 cases/trials 分页端点 |
| 同条件对比 | 无 `baselineJobId`、无 comparison 端点 |
| 预算/配置目录 | 无 `agentConfigId`、`budgetPolicyId`、总试次上限校验 |

## 2. 总体设计

```text
创建（POST /api/jobs）
  └─ 同一事务：冻结快照 + 写入全部 Trial 计划（eval_trial_plan，C×R 行）+ 入队
Worker 领取 Job（现有 pg-boss，claim 保持 queued→running 原子转换）
  └─ 每 BenchmarkRun 内：循环「从计划表原子领取下一条 Trial（租约 + fencing token）」
       → preparing（准备环境/工作区，失败可重试 1 次，新 executionAttemptId）
       → running（复用 TrialRunner 执行 Agent，新会话、干净工作区）
       → grading（独立判卷；传输/格式故障追加 1 次 ScoreAttempt）
       → 提交（fencing 校验 + verdict 写回 + TrialResult 落库）
       → completed（verdict = pass/fail/unknown）或 cancelled/interrupted（verdict 空）
统计（查询时聚合）
  └─ P/F/U/M 守恒 + 三比率 + 每题 Wilson 区间，statisticsVersion=1
展示 / 对比
  └─ cases / trials 分页端点；comparison 只读端点；页面四分口径
```

### 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | Trial 计划先行：创建时写入全部计划行，执行按计划驱动；平台路径移除 `repeatCases` 案例复制 | 计划冻结是 P0 硬性要求；`C×R` 全部试次无论成败都要执行，不能依赖「失败后补跑」 |
| D2 | lifecycle/verdict 落在计划行（`eval_trial_plan`）；`TrialResult` 保持 schemaVersion 1，仅新增可选字段 | 结果 jsonb 面向证据，计划行面向调度与统计；避免大改 `TrialResultSchema` 波及 CLI 离线评测 |
| D3 | Execution/Score 尝试以带版本的 jsonb 数组存于计划行，不建独立表 | 尝试记录查询低频、随 Trial 一起读取；与现有 jsonb 快照风格一致，避免过度建表 |
| D4 | Job 级领取维持 pg-boss 单消费者；Trial 级租约用 `FOR UPDATE SKIP LOCKED` + fencing token | Job 认领的原子性已存在；Trial 租约解决 worker 内并发领取、重复投递与迟到提交 |
| D5 | 统计在查询时从计划表聚合，不维护冗余计数列 | 单 Job 计划行最多数千，`GROUP BY` 成本可忽略；计数列必然出现漂移风险 |
| D6 | `agentConfigId`/`budgetPolicyId` 首版为服务端内置目录（mock / configured；default 预算策略），为多配置留接口 | 规格要求「配置 ID 均来自服务端目录」；真实模型仍受 `CODEDEN_EVAL_REAL_MODELS` 与 `allowPaid` 双重约束 |
| D7 | 新增事件类型 `eval.trial.lifecycle` | `RunEvent.type` 是自由字符串（`z.string().min(1)`），新增枚举值对旧消费者向后兼容 |
| D8 | 旧 Job 不改写语义：回填计划行时 `mode='single_smoke'`、`repetitionIndex` 从 `caseId#n` 后缀解析 | 「旧单次历史保持 R=1，不合并到新实验」 |

## 3. 契约变更（`apps/eval-platform/src/platform/contracts.ts`）

### 3.1 创建评测（v2 契约）

```ts
export const JobModeSchema = z.enum(['repeat', 'single_smoke'])

export const CreateJobSchema = z
  .object({
    requestId: z.uuid(),
    datasetId: DatasetIdSchema,
    datasetIds: z.array(DatasetIdSchema).min(1).max(8).optional(),
    /** v2 起必填；缺省返回 400 并提示显式传模式，防止旧客户端意外触发多倍付费。 */
    mode: JobModeSchema,
    /** repeat 模式必填，2–20；single_smoke 必须为 1 或缺省。 */
    repetitionsPerCase: z.number().int().min(1).max(20).optional(),
    agentConfigId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
    budgetPolicyId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
    /** 关联基线创建对比实验；基线必须为终态且快照可加载。 */
    baselineJobId: z.uuid().optional(),
    caseIds: /* 保持现有 */,
    allowPaid: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    // mode='repeat'：repetitionsPerCase 必填且 2–20（缺省视为未显式确认，返回 400）
    // mode='single_smoke'：repetitionsPerCase 缺省按 1；传值非 1 返回 400
    // agentConfigId 缺省时沿用 modelId（modelId 仍保留一个周期作兼容别名）
    // baselineJobId 与 datasetIds/caseIds/repetitions 互斥：对比实验由服务端从基线快照复制
  })
```

兼容规则：

- 旧字段 `repetitions` 从 schema 移除；带 `repetitions` 的请求返回 400（提示改用 `mode` + `repetitionsPerCase`），不复用旧字段做静默换算——避免「省略次数意外触发多倍付费」。
- `modelId` 保留：`agentConfigId` 未传时按现行为解析（`mock` / `configured`）。目录同时返回两者。
- 幂等继续用 `requestId` + `contentDigest(input)`：相同参数返回原 Job；任何影响计划的参数不同（含 `mode`/`repetitionsPerCase`/`agentConfigId`/`baselineJobId`）返回 409 `REQUEST_REUSED`。现有 `JobStore.create` 已实现该机制，无需改动。

### 3.2 新增类型

```ts
export type TrialLifecycle =
  | 'queued' | 'preparing' | 'running' | 'grading'
  | 'completed' | 'cancelled' | 'interrupted'
export type TrialVerdict = 'pass' | 'fail' | 'unknown'

export interface ExecutionAttemptRecord {
  executionAttemptId: string
  stage: 'preparing' | 'running'
  errorCategory?: string          // infrastructure 分类，合法失败不算故障尝试
  startedAt: string
  finishedAt?: string
  inputTokens?: number
  outputTokens?: number
  tokenMeasured?: boolean         // 缺失用量不得当 0
}

export interface ScoreAttemptRecord {
  scoreAttemptId: string
  errorCategory?: string          // 'transport' | 'format'
  startedAt: string
  finishedAt?: string
}

/** statisticsVersion=1 的统计口径。 */
export interface JobStatistics {
  statisticsVersion: 1
  mode: JobMode
  caseCount: number               // C
  repetitionsPerCase: number      // R
  plannedTrials: number           // N = C × R
  passed: number                  // P
  failed: number                  // F
  undecided: number               // U
  unfinished: number              // M（queued/preparing/running/grading/cancelled/interrupted）
  plannedPassRatio: number | null        // P / N
  effectiveSuccessRate: number | null    // P / (P + F)；P+F=0 → null（前端显示「暂无有效判定」）
  effectiveCoverage: number | null       // (P + F) / N
  complete: boolean               // U === 0 && M === 0
}
```

`JobView` / `JobDetail` 增加 `mode`、`repetitionsPerCase`、`baselineJobId`、`statistics: JobStatistics`；现有 `summary` 字段保留，供旧客户端与列表快速展示（内容继续来自执行侧聚合，不参与统计口径）。

## 4. 数据库迁移（版本 3）

在 `database.ts` 的 `migrateDatabase` 中追加版本 3（沿用 `pg_advisory_xact_lock(70130901)` 事务锁）：

```sql
-- eval_jobs 增列
ALTER TABLE eval_jobs
  ADD COLUMN mode text NOT NULL DEFAULT 'single_smoke'
    CHECK (mode IN ('repeat','single_smoke')),
  ADD COLUMN repetitions_per_case integer NOT NULL DEFAULT 1,
  ADD COLUMN agent_config_id text,
  ADD COLUMN budget_policy_id text,
  ADD COLUMN baseline_job_id uuid REFERENCES eval_jobs(id),
  ADD COLUMN stop_reason text;
-- 旧 Job 回填为 single_smoke（默认值即满足）；input 内的旧 repetitions 字段不动。

-- Trial 计划表（调度与统计的事实源）
CREATE TABLE eval_trial_plan (
  job_id uuid NOT NULL REFERENCES eval_jobs(id),
  benchmark_run_id text NOT NULL REFERENCES eval_benchmark_runs(id),
  trial_id text NOT NULL,
  case_id text NOT NULL,
  repetition_index integer NOT NULL CHECK (repetition_index >= 0),
  order_index integer NOT NULL,
  lifecycle text NOT NULL DEFAULT 'queued'
    CHECK (lifecycle IN ('queued','preparing','running','grading','completed','cancelled','interrupted')),
  verdict text CHECK (verdict IN ('pass','fail','unknown')),
  lease_owner text,
  lease_token bigint,
  claimed_at timestamptz,
  execution_attempts integer NOT NULL DEFAULT 0,
  score_attempts integer NOT NULL DEFAULT 0,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (job_id, benchmark_run_id, case_id, repetition_index),
  UNIQUE (job_id, benchmark_run_id, trial_id)
);
CREATE INDEX eval_trial_plan_claim
  ON eval_trial_plan (job_id, order_index) WHERE lifecycle = 'queued';
```

要点：

- **唯一键**即规格要求的 `(jobId, caseId, repetitionIndex)`（benchmarkRun 是 Job 内评测集实例维度，native 单评测集时恒为一行）。
- `trial_id` 创建时预分配（格式 `${caseId}::r${n}::${randomSuffix}`），保证事件流、`eval_trials`、SSE 关联不变；`TrialRunner` 需要支持外部传入 trialId（见 §7）。
- `order_index` 创建时按「轮次间交错题目」生成：外层循环 repetition，内层循环 case（`rep*` 先跑每题第 1 次，再跑第 2 次……），避免一题独占全部执行槽位。
- **回填**：为存量 Job 的每个 `eval_trials` 行解析 `result->>'caseId'`，末尾 `#n` 后缀拆为 `case_id + repetition_index = n-1`（`CreateJobSchema.caseIds` 的正则不允许 `#`，`#n` 只可能来自旧版 `repeatCases`，解析无歧义），`lifecycle='completed'`，`verdict` 按 §8 映射计算，`attempts='[]'`。无 Trial 结果的旧 Job 计划行不回填（其 `completed` 计数为 0，历史详情仍以 `eval_trials` 为准），仅当 `total>0` 时按 `case#n` 去重集合生成 `queued` 计划行并把 lifecycle 置为与 Job 终态一致的 `cancelled`/`interrupted`，保证 `N = P+F+U+M` 守恒。
- `eval_jobs.input` 为 jsonb，不迁移旧值；`toJobView` 读取新列而非 `input.repetitions`。

## 5. Trial 生命周期与状态机

```text
queued ──claim──> preparing ──环境就绪──> running ──Agent 交卷──> grading ──判卷有效──> completed
   │                   │                      │                    │
   │                   └─准备故障（≤1 次重试）─┘                    └─verdict = pass/fail/unknown
   └─ 取消（Job cancelling 时不再领取）            取消/中断 → cancelled/interrupted，verdict 保持 NULL
```

映射约束：

- 只有 `completed` 允许携带 verdict；`pass/fail` 必须来自有效验收（infrastructure ok 且 verification passed/failed），`unknown` 对应证据不足（infrastructure error / verification error / 判卷全部无效）。
- `verdict = NULL` 的 Trial 一律计入 M，不得提前判为能力失败。
- Job 终态转换复用现有 `JobStore.finish` 的 `CASE WHEN cancelling` 保护；计划行终态由提交路径写，两个终态来源互不覆盖（Job 已终态时提交抛错并拒绝，见 §7 fencing）。

## 6. 调度、租约与取消

### 6.1 Trial 领取（`JobStore` 新增 `claimTrial`）

```sql
UPDATE eval_trial_plan SET
  lifecycle = 'preparing',
  lease_owner = $workerEpoch,          -- worker 启动时生成的随机 ID
  lease_token = $fencingToken,         -- worker 内单调递增的 bigint
  claimed_at = now()
WHERE id IN (
  SELECT job_id FROM eval_trial_plan            -- 主键即行定位
  WHERE job_id = $jobId AND benchmark_run_id = $runId AND lifecycle = 'queued'
  ORDER BY order_index
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING trial_id, case_id, repetition_index, execution_attempts;
```

- Job 级仍由 pg-boss 单消费者触发（`EvalWorker.run` → `store.claim`）；BenchmarkRun 内按 `CODEDEN_EVAL_TRIAL_CONCURRENCY` 并发循环领取。`SKIP LOCKED` 使同 Job 多 worker（未来水平扩展或消息重投）也只会各自领到不同 Trial。
- 取消传播：每次领取前检查 Job 状态，`cancelling`/终态则停止领取新 Trial；正在运行的 Trial 通过现有 `monitor` 的 abort 信号停止，已完成结果保留。
- 预算耗尽：整场预算（v1 = 总时限 + 总试次上限）触发时按现有 `finish(id, 'failed', …)` 收口并写 `stop_reason='budget_exhausted'`；已判卷结果不变，未完成计划行由收口事务统一置 `interrupted`（M），不得判为 fail。

### 6.2 迟到提交防护（fencing）

`PlatformEvalRepository.saveTrial` 改造：

1. 事务内读 Job 行 `FOR UPDATE`（现有行为保留：非 running/cancelling 拒绝）。
2. 读计划行，校验 `lease_token = $fencingToken` 且 lifecycle ∈ ('preparing','running','grading')；不匹配抛 `TRIAL_LEASE_STALE`，调用方按「迟到提交」记录日志后丢弃，不产生第二份成绩。
3. 写 verdict 与 lifecycle='completed'（幂等：仅当校验通过，条件更新），插入 `eval_trials` 结果行（保留 `onConflictDoNothing` 作为最后防线）。

心跳丢失（`recoverInterrupted`）时同步把该 Job 的 `preparing/running/grading` 计划行置为 `interrupted`；不自动恢复、不自动重跑（spec §4）。

## 7. 执行链路改造

### 7.1 `TrialRunner`（`packages/eval-engine`）

- `RunTrialInput` 新增可选 `trialId?: string` 与 `onLifecycle?: (stage) => Promise<void>`：传入时使用外部 trialId，并在 preparing→running→grading 边界回调；缺省行为完全不变（CLI 离线 `pnpm eval` 不受影响）。
- 准备阶段失败（工作区创建、benchmark.prepare 抛错）且确认未调用 Agent 时，由平台侧重试 1 次（新 executionAttemptId、新工作区），两次都失败终结为 `completed + unknown`，`failure.stage/category` 落入 attempts 记录。Agent 已调用后的失败不做执行重试。

### 7.2 `executor.ts`：从「case 驱动」改为「计划驱动」

`executeBenchmarkRun` 重构：

```text
preparedHarness = harness.prepare(...)          // run 级，保持不变
loop（trialConcurrency 并发）:
  plan = store.claimTrial(jobId, runId)         // §6.1；无剩余 → 退出
  store.recordAttempt(jobId, plan, 'preparing') // execution_attempts += 1
  result = TrialRunner.run({ trialId: plan.trialId, evalCase: snapshot 中按 plan.case_id 查找, ... })
  verdict = deriveVerdict(result)               // §8 映射
  store.completeTrial(jobId, plan, { verdict, result, fencingToken })
  // cancelled/interrupted 路径：收口事务统一处理，不在 trial 循环内写
```

- `EvalRunner` 在平台路径不再承担「case 列表即计划」的职责；`EvalRunner.run(cases)` 与 `aggregateSummaries` 保留给 CLI 离线评测与单 BenchmarkRun 兼容入口。平台侧的 JobSummary 由执行侧聚合继续产出（列表页复用），统计口径由 §8 的独立模块在查询侧计算，二者不混用。
- `catalog.repeatCases` 删除；`catalog.snapshot` 返回原始冻结案例，重复维度完全由计划表表达。`JobSnapshot.cases` 存原始 C 条案例，`JobSnapshot` 增加 `frozenDigests: { caseSet, grader, environment }`（创建时计算 `contentDigest`），供对比与 VERSION_CHANGED 校验复用。

### 7.3 事件

- 在 preparing/running/grading/completed/cancelled/interrupted 转换时经现有 EventRecorder 发 `type: 'eval.trial.lifecycle'`，`data` 含 `trialId`、`caseId`、`repetitionIndex`、`lifecycle`、`verdict?`。页面 SSE 流自动获得新事件。
- 计划行是调度事实源，事件只做展示与审计；两者不一致时以计划行为准。

## 8. 统计口径（新模块 `packages/eval-engine/src/statistics/repeat-statistics.ts`）

纯函数、无 I/O，便于单测与前端复用（经 API 返回，不在浏览器重复实现）：

```ts
deriveVerdict(result: TrialResult): TrialVerdict
// infrastructure ok && submission valid && verification passed → 'pass'
// infrastructure ok && verification failed → 'fail'（含单 Trial 预算超限但有有效证据）
// 其余（setup_error / runtime_error / verification error / 提交无效且无有效判卷）→ 'unknown'

aggregateStatistics(plans: PlanRow[], mode, R): JobStatistics
// P=Σ(pass) F=Σ(fail) U=Σ(unknown) M=Σ(lifecycle≠'completed')
// 恒等式 N = P+F+U+M；分母为 0 的比率返回 null，不返回 0 或 NaN

wilsonInterval(passed: number, effective: number, z = 1.96): { center, halfWidth } | null
// n = effective = P+F；n=0 → null。5/5 → 约 56.6%–100%（单测锚点）

caseStatistics(plans): CaseStat[]
// 每题 { passCount, failCount, unknownCount, pendingCount }
// 分类：全通过 / 全不通过 / 结果波动 / 结果不完整（有 U 或 M 优先标记）/ 单次结果（R=1）
```

- `statisticsVersion = 1` 写入 `JobStatistics`；口径变更必须升版本，不覆写旧统计。
- 旧 Job（回填计划行）同样按此口径聚合，`mode='single_smoke'`、R=1，不展示稳定性区间。

## 9. API 设计

所有端点继续走 `handlePlatformRequest` 的 loopback + 同源校验与错误脱敏。

| 端点 | 语义与实现要点 |
|---|---|
| `POST /api/jobs` | v2 契约（§3.1）。`baselineJobId` 存在时：加载基线 Job（必须终态），复制其冻结 `datasetIds/caseIds/repetitionsPerCase/mode/budgetPolicyId` 与快照摘要，仅允许新 `agentConfigId`；基线快照不可加载则 409 `BASELINE_UNAVAILABLE`，不静默替换。创建事务内：写 Job + BenchmarkRun + 全部计划行 + 入队（沿用 advisory lock 与 `boss.send` 事务绑定）。校验 `C × R ≤ CODEDEN_EVAL_MAX_TOTAL_TRIALS`（默认 400），超出 429 `BUDGET_EXCEEDED` |
| `GET /api/jobs` | 新增服务端筛选：`datasetId`（匹配 `input.datasetIds` 任一）、`status`（单值或逗号分隔列表）、`createdFrom`/`createdTo`（ISO 时间）、`jobId`（精确）。全部为 SQL 条件，`ORDER BY created_at DESC, id DESC` 不变（现有索引覆盖） |
| `GET /api/jobs/:id` | 增加 `statistics`（§8 聚合）、`mode`、`repetitionsPerCase`、`baselineJobId`、`stopReason`；`trials` 数组改为按 `caseId + repetitionIndex` 排序并携带 `repetitionIndex` |
| `GET /api/jobs/:id/cases` | 分页案例汇总（§8 `caseStatistics`），参数 `offset/limit/benchmarkRunId`；多评测集 Job 未指定 `benchmarkRunId` 时返回 400（与 `eventPage` 现有行为一致） |
| `GET /api/jobs/:id/trials` | 参数 `caseId/benchmarkRunId/offset/limit`，返回 `{ items: [{ trialId, caseId, repetitionIndex, lifecycle, verdict, executionStatus, durationMs, inputTokens, outputTokens, tokenMeasured }], nextOffset }`；校验 caseId 归属，跨任务串读返回 404 |
| `GET /api/jobs/:id/trials/:trialId/events` | 保持现有分页 + SSE，不改协议 |
| `GET /api/jobs/:id/comparison` | 只读；`baselineJobId` 必填。可比性判定见 §10 |
| `GET /api/catalog` | 增加 `agentConfigs`（id/名称/是否 mock/是否需要付费确认）、`budgetPolicies`（v1 仅 `default`：总试次上限、单 Trial 时限）、`modes`（默认 `repeat`、`repetitionsRange: [2,20]`、默认 5、`maxTotalTrials`）、每个 dataset 的 `supportsRepeat`（swebench-official / swe-polybench / terminal-bench 依镜像可复用性声明；不支持的适配器创建时 400 拒绝，不伪装可重复评测） |

错误码沿用 `PlatformError` 模式，全部中文消息、不暴露内部字段：`INVALID_INPUT`(400)、`REQUEST_REUSED`(409)、`BUDGET_EXCEEDED`(429)、`BASELINE_UNAVAILABLE`(409)、`NOT_COMPARABLE`(409)、`TRIAL_NOT_FOUND`(404)。

## 10. 同条件对比

### 10.1 创建

`POST /api/jobs` + `baselineJobId`（§9）。新 Job 落库 `baseline_job_id`；不复制基线的任何 Trial 结果。

### 10.2 可比性检查（comparison 端点）

依次校验，任一不满足返回 `{ comparable: false, reasons: [...] }`（HTTP 200，语义结果而非错误）：

1. 双方 `mode='repeat'`；
2. `frozenDigests.caseSet`、`grader`、`environment` 一致，`repetitionsPerCase` 一致（Agent/模型是被测变量，允许不同；v1 预算与资源策略恒等）；
3. 双方 `complete = true`（U+M=0）；不完整时 `comparable: false, reasons: ['证据不完整']`，仍并列返回原始计数。

可比时返回：

```jsonc
{
  "comparable": true,
  "baseline": { "jobId": "…", "effectiveSuccessRate": 0.75, "coverage": 0.8 },
  "candidate": { "jobId": "…", "effectiveSuccessRate": 0.85, "coverage": 1.0 },
  "overallDelta": { "percentagePoints": 10, "note": "本次观测差异，不构成显著性结论" },
  "cases": [
    { "caseId": "…", "baseline": { "passed": 3, "planned": 5 },
      "candidate": { "passed": 4, "planned": 5 }, "regressed": false }
  ],
  "regressions": ["case-id-…"],   // 全通过 → 非全通过 的题目
  "resources": { "inputTokens": {…}, "durationMs": {…} }
}
```

不触发执行、不自动晋级、不调用 release-gate；「本次观测提高/下降」措辞由前端固定文案保证。

## 11. Web UI 改动（`apps/eval-platform/web`）

| 视图 | 改动 |
|---|---|
| 创建表单 | 模式选择（默认「重复评测」/「单次冒烟」显式标注“不用于判断稳定性”）；每题次数（2–20，默认 5）；展示 C × R = N 总试次与预算提示；`agentConfigId` 下拉来自 catalog；真实模型二次付费确认文案覆盖**全部试次** |
| 任务详情 · 总览 | 顶部四分计数 P/F/U/M + `已处理 (P+F+U)/N`；三比率分母明确展示（`60/100`、`60/80`、`80/100`）；P+F=0 显示「暂无有效判定」；U>0 或 M>0 显示「结果不完整，不用于确定性版本结论」 |
| 任务详情 · 每题成绩 | 「通过 x/R 次」+ 每次状态列表（lifecycle + verdict + 耗时 + Token）；R≥2 显示 Wilson 区间及假设说明；R=1 只显示单次结果；不选最好一次作为全题结果 |
| 任务详情 · Trace | 从每题试次进入对应 trialId 的 SSE 链路（现有 LiveTrialDetail 复用，入口从 case 维度改为 trial 维度） |
| 历史列表 | 筛选器（评测集/状态/时间范围/任务 ID）改为服务端查询参数；摘要显示模式、C/R/N、四分计数 |
| 对比视图 | 详情页「基于此配置创建对比实验」入口（选择新 agentConfig → 重新确认预算）；comparison 结果页含不可比原因展示与「本次观测」文案 |
| 通用 | 统计全部来自 API 的 `JobStatistics`，前端不做口径计算；缺失数据展示「未采集」，不冒充 0 |

## 12. 测试方案

### 12.1 单元测试（中文描述，沿用现有 vitest 分层）

- `repeat-statistics.test.ts`：P/F/U/M 守恒（P=60、F=20、U=10、M=10 → 60/100、60/80、80/100）；全 unknown / 取消 / 预算耗尽时分母 0 不产生 NaN 或假 0%；Wilson 5/5 ≈ [56.6%, 100%]、n=0 返回 null；题目分类（全通过/全不通过/波动/不完整/R=1）。
- `contracts.test.ts`：v2 schema——缺 `mode` 400；repeat 模式次数 0/1/21/非整数 400；`single_smoke` 传次数≠1 400；旧 `repetitions` 字段 400；幂等 digest 含新字段。
- `trial-plan.test.ts`（platform）：计划生成 C×R、order_index 轮转交错、trial_id 预分配唯一。
- `comparison.test.ts`：可比/不可比矩阵（条件变化、证据不完整、单次冒烟混入）。

### 12.2 数据库集成测试（`tests/integration/eval-platform.test.ts` 扩展）

- 两个连接竞争 `claimTrial`：同一 Trial 只被一个领取，顺序按 order_index。
- fencing：token 过期后提交被拒绝，不产生第二份成绩、`completed` 计数不重复。
- 取消竞争：queued 领取与取消并发，仅一个状态转换胜出；取消成功后不再调用 Agent。
- 准备故障重试：两次失败 → `completed + unknown`，attempts 留存 2 条，成本不丢；Agent 已调用后故障 → 不重试。
- 判卷格式故障追加 1 次 ScoreAttempt；合法 fail 不重评。
- 心跳丢失 → Job 与计划行 `interrupted`；重启后不自动重跑、不重复付费。
- 迁移 v3 回填：旧 Job（含 `case#n` 结果）聚合出正确 `mode/R/P/F/U/M`。

### 12.3 E2E（mock 模型）

- 3 题 × 2 次 = 6 个 Trial 全部执行，无成功早停、无失败洗分；每次 Trial 工作区与会话从原始快照开始（上一试次写入的文件不泄漏）。
- 基线 + 候选对比实验全流程：创建 → 执行 → comparison 可比 → 差异与回归题输出。
- 预算上限触发 → `failed` + `stop_reason=budget_exhausted`，已完成结果保留。

### 12.4 浏览器验收（新增基建）

- 引入 `@playwright/test`（devDependency，仅仓库内使用），新增 `tests/browser/eval-platform.spec.ts` 与 `pnpm test:browser`；Playwright `webServer` 复用 `scripts/start-eval-platform.mjs`（mock 模式 + 临时数据库）。
- 覆盖 PRD 验收清单：创建 Mock 重复评测 → 进度逐 Trial 更新 → 取消（排队/运行中）→ 刷新不重复创建、不取消后台任务 → 结果四分展示与每题区间 → 历史筛选与分页 → 对比入口 → 窄屏与键盘操作 → 查询失败与执行失败分别展示。

## 13. 实施顺序与提交拆分

每步独立可验收、可回退，遵循 `type(模块): 中文描述.` 提交规范：

1. `feat(eval-engine): 扩展 TrialResult 重复维度与生命周期回调.` —— `RunTrialInput.trialId/onLifecycle`、`repeat-statistics` 纯函数及单测。
2. `feat(eval-platform): 新增重复评测契约与 Trial 计划迁移.` —— contracts v2、迁移 v3（含回填）、计划生成、catalog 目录增量。
3. `feat(eval-platform): 实现 Trial 级租约调度与生命周期收口.` —— claimTrial/fencing/取消传播/预算收口/executor 改造/事件。
4. `feat(eval-platform): 新增执行历史筛选与案例试次分页接口.` —— GET /api/jobs 筛选、cases、trials、detail 统计。
5. `feat(eval-platform): 实现同条件对比实验与可比性检查.` —— baselineJobId 创建链路 + comparison 端点。
6. `feat(eval-platform): 页面支持重复评测统计与对比视图.` —— Web UI 全部改动。
7. `test(browser): 新增评测平台浏览器验收测试.` —— Playwright 基建与用例。

验收以 PRD §8 表格逐条对照：单测/集成/E2E 映射见 §12；原单次演示测试保留，但不得作为重复评测的替代验收。

## 14. 风险与开放问题

| 风险 | 处置 |
|---|---|
| pg-boss `expireInSeconds=900` 小于 Job 总时限（默认 30 分钟） | 实施 §6 时核对 pg-boss 版本语义：`retryLimit: 0` 下消息过期不重投，但需用集成测试确认；必要时按 Job 级租约改为显式 heartbeat 续期 |
| 外部 Benchmark 的重复隔离 | swebench-official / swe-polybench / terminal-bench 的 `prepare` 是 run 级；per-Trial 隔离依赖各自 workspaceFactory 与验证工作区挂载。首版通过 catalog `supportsRepeat` 逐个声明，未声明的集合拒绝重复模式 |
| 旧 `caseId#n` 解析 | `CreateJobSchema.caseIds` 正则不含 `#`，回填解析无歧义；`repeatCases` 删除后 `#` 不再进入新数据 |
| 计划行与事件流不一致 | 以计划行为准；页面 lifecycle 展示读取计划行聚合，事件仅做时间线下钻 |
| `EvalRunner` 双路径并存 | 平台走计划驱动，CLI 离线评测保留原路径；架构边界测试（`architecture-boundaries.test.ts`）补充「平台不得绕过计划表直接展开重复案例」的约束 |

## 15. 非目标

以下内容不在本方案内，按 PRD 归属后续阶段：LLM 评审（AI Judge）、线上 Trace 接收与人工复审、候选晋级与 Champion/Challenger、只重跑失败子集、自适应追加试次、显著性检验、多人认证与配额结算、任意历史 Agent 版本回放。
