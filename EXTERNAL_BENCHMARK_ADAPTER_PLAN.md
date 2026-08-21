# 外部开源评测集适配开发方案

## 1. 目标

在不改动 Agent Runtime 核心执行流程的前提下，接入 SWE-bench Lite、HumanEval 等外部评测集，并统一转换为 CodeDen 内部 `EvalCase`，最终复用现有的 Trial Runner、Grader 和结果报告能力。

## 2. 总体流程

```text
外部数据集
  → 数据下载与版本校验
  → BenchmarkAdapter
  → EvalCase
  → FixtureProvider 准备工作区
  → TrialRunner 执行 Agent
  → Grader 验证
  → TrialResult
  → ResultStore 落盘
```

原则：外部数据格式只允许出现在 Adapter 内部，`src/eval/domain`、`TrialRunner` 和 Agent Runtime 不依赖具体数据集。

## 3. 内部统一模型扩展

扩展 `EvalCase`，增加可选来源和执行元数据：

```ts
interface EvalCase {
  id: string
  prompt: string
  fixture: FixtureRef
  verification: VerificationSpec
  limits: TrialLimits
  metadata?: {
    source: string
    version?: string
    upstreamId?: string
    license?: string
  }
}
```

`FixtureRef` 支持以下来源：

- 本地 fixture 目录
- Git 仓库与 commit
- 已下载的数据集快照

## 4. 模块设计

### 4.1 BenchmarkAdapter

目录：`src/eval/adapters/benchmarks/`

```ts
interface BenchmarkAdapter {
  readonly name: string
  load(source: DatasetSource): Promise<EvalCase[]>
}
```

首批实现：

```text
benchmarks/
├── benchmark-adapter.ts
├── benchmark-registry.ts
├── native/
├── swebench/
│   ├── swebench.adapter.ts
│   ├── swebench.schema.ts
│   └── swebench.loader.ts
└── humaneval/
    ├── humaneval.adapter.ts
    └── humaneval.schema.ts
```

第一阶段只实现 `native` 和 `swebench-lite`，HumanEval 放在第二阶段。

### 4.2 数据集下载与缓存

目录：`src/eval/datasets/`

```text
dataset-fetcher.ts       下载数据集
dataset-cache.ts         本地缓存
dataset-manifest.ts      版本、来源、许可证、校验和
checksum-verifier.ts     SHA256 校验
```

要求：

- 数据集版本必须显式指定
- 默认缓存到用户缓存目录，不写入仓库
- 下载完成后校验 SHA256
- 支持离线读取已有缓存
- 结果中记录数据集名称和版本

### 4.3 FixtureProvider

目录：`src/eval/adapters/fixtures/`

```ts
interface FixtureProvider {
  prepare(input: FixtureRef): Promise<PreparedWorkspace>
}
```

SWE-bench Lite 的准备流程：

```text
获取仓库
  → checkout base commit
  → 创建隔离 Worktree
  → 安装依赖
  → 返回 PreparedWorkspace
```

必须复用现有 Worktree 和进程超时能力。

### 4.4 Grader 扩展

新增：

- `command`：执行测试或编译命令
- `pytest`：Python 测试结果解析
- `patch-apply`：验证补丁是否可应用
- `test-count`：统计通过/失败测试数

所有 Grader 统一返回：

```ts
interface GraderResult {
  passed: boolean
  score?: number
  message: string
  evidence: string[]
}
```

### 4.5 ResultStore

第一阶段使用 JSONL：

```text
.codeden/results/<runId>.jsonl
```

每行记录：

- `runId`
- `caseId`
- `dataset`
- `datasetVersion`
- Agent 版本和模型
- Trial 状态
- Grader 结果
- 耗时、Token、工具调用次数
- 错误和失败归因

后续再增加 SQLite 查询能力。

## 5. CLI 设计

保持现有 Native Case 命令兼容：

```bash
pnpm codeden eval --case evals/cases/regression/update-package-version.yaml
```

增加外部数据集命令：

```bash
pnpm codeden eval \
  --benchmark swebench-lite \
  --split test \
  --version 1.0 \
  --limit 10
```

支持离线模式：

```bash
pnpm codeden eval --benchmark swebench-lite --offline
```

禁止通过 CLI 传递 API Key，继续使用现有配置和 Secret Resolver。

## 6. 分阶段实施

### 阶段 1：统一模型与注册机制

实现：

- `BenchmarkAdapter` 接口
- `BenchmarkRegistry`
- `DatasetSource` 和来源元数据
- `EvalCase` 可选 metadata
- Native Adapter 迁移

验收：现有 Native YAML 评测全部通过，行为不变。

### 阶段 2：数据集缓存基础设施

实现：

- DatasetFetcher
- DatasetCache
- Manifest
- SHA256 校验
- 离线读取

验收：同一版本只下载一次，篡改文件会被拒绝，离线缓存可正常运行。

### 阶段 3：SWE-bench Lite Adapter

实现：

- 外部 JSON/JSONL Schema
- Issue 到 EvalCase 转换
- base commit 解析
- 测试命令映射
- 仓库 Fixture 准备

验收：至少运行 3 个公开案例，Agent 能完成准备、执行、验证和结果落盘。

### 阶段 4：Command Grader 与结果持久化

实现：

- Command Grader
- 测试输出解析
- JSONL ResultStore
- Console Reporter 汇总

验收：结果可区分通过、失败、超时、环境错误，并可按 caseId 查询。

### 阶段 5：安全与许可证审计

实现：

- 数据集来源和许可证记录
- 下载内容校验
- 外部命令沙箱策略
- 网络访问配置
- Secret 泄露扫描

验收：评测过程中不能读取或输出宿主机 Secret；未声明许可证的数据集不能执行。

## 7. 首批推荐范围

不要一开始接入完整 SWE-bench。建议顺序：

1. 当前 Native YAML 作为回归基线
2. SWE-bench Lite，先固定 3～10 个案例
3. HumanEval 或 MBPP，用于函数级生成验证
4. 再扩展完整 SWE-bench 和多语言数据集

## 8. 风险与约束

- 外部仓库依赖安装可能失败，必须区分 Agent 失败和环境失败
- 测试命令可能长时间运行，必须使用超时和进程组清理
- 数据集和上游仓库可能有不同许可证，必须保留来源信息
- 不允许把下载的数据集和 Secret 写入 Git
- 外部数据格式变更只能影响对应 Adapter

## 9. 最终验收标准

- Native YAML 评测全部回归通过
- 至少一个外部数据集 Adapter 可运行
- 数据集版本、来源、许可证和校验和完整记录
- 单个 Case 失败不会中断整个批次
- 每个 Trial 都有可解析的 JSONL 结果
- Agent Runtime 不依赖具体外部数据集格式
- Secret Scan、Lint、Typecheck 和全量测试通过
