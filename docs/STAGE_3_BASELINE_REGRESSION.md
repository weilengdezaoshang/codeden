# CodeDen 阶段 3：Baseline 回归差集

## 1. 目标

修改类任务在开工前拍一次测试基线。交卷时只把**新增失败**当成验收失败；原有失败不算回归。

```text
配置 + Secret + Inspector + TaskSpec
-> 修改类且仓库有真实 test 脚本：开工前跑一次测试，记下失败身份（Baseline）
-> Agent 改文件
-> 模型提出完成
-> DiffPolicy（阶段 2 已有）
-> 再跑同一条测试
-> 回归差集 = 终态失败 − 基线失败
-> 有新增失败或测试文件被删 → 回灌证据继续修
-> 没有新增失败 → VERIFIED_COMPLETE
```

只读提问（例如「读取 package.json 并告诉我项目名」）不跑测试，行为与阶段 2 相同。

Eval 的 `resolved` 仍由 Native Grader 计算，本阶段不改评测路径。

## 2. 必须完成

- `BaselineSnapshot`：开工前命令结果、失败身份、测试文件清单
- `FailureIdentityParser`：从 stdout/stderr 抽出失败身份；抽不出时用规范化输出指纹兜底
- `RegressionVerifier`：只比较差集，不把基线失败当成新回归
- 修改类任务且 `facts.scripts.test` 存在时，自动写入真实的 `pnpm test` / `npm test` / `yarn test`，不编造脚本
- 有验证命令时，禁止删除测试文件（`tests/`、`*.test.*`、`*.spec.*`）
- CLI：开工前拍基线并交给 CompletionVerifier；失败时打印新增回归
- 新 fixture：带 `node --test` 的小项目，不引入 vitest 依赖
- 验收测试 A-1…A-8，不依赖真实 API Key

## 3. 明确不做

MCP、worktree、Docker、Session、Skills、LLM Judge、Eval Baseline CLI、Champion/Challenger、解析完整 JSON reporter、改 Eval `resolved`。

不把「测试被改空 / 被 skip」做成完整静态分析；本阶段只拦**删除测试文件**。

## 4. 契约

### BaselineSnapshot

```ts
{
  command: string
  exitCode: number
  failing: string[]
  fingerprint?: string
  testFiles: string[]
}
```

- `failing`：解析出的失败身份，例如 `tests/old-fail.test.js`
- `fingerprint`：解析结果为空且 `exitCode !== 0` 时，对规范化 stdout+stderr 做短哈希
- `testFiles`：开工前测试文件的相对路径

### FailureIdentityParser

优先识别：

- Node TAP / `node --test`：`not ok` 行里的测试名或文件
- Vitest/Jest 常见输出：`FAIL path/to/file`

解析规则必须有单测。识别不出名字时：

| 基线 exit | 终态 exit | 结果 |
|---|---|---|
| 0 | 0 | 通过 |
| 0 | 非 0 | 新回归 |
| 非 0 | 0 | 通过 |
| 非 0 | 非 0，指纹相同 | 原有失败，通过 |
| 非 0 | 非 0，指纹不同 | 新回归 |

### RegressionVerifier

```ts
verify(taskSpec, workspace, baseline?) -> CompletionCheck
```

- 无 `verificationCommands`：跳过（与现有 CommandVerifier 一致）
- 无 baseline（只读任务）：命令必须 exit 0
- 有 baseline：只检查 `final.failing - baseline.failing`（或上表指纹规则）
- `testFiles` 中有文件在终态消失 → 失败，证据列出被删路径

CompletionVerifier 顺序：DiffPolicy → 敏感路径（已有）→ Regression/Command。

### TaskSpecBuilder

- 修改类（`EDIT_HINT` 或已经收窄的 `allowedPaths`）且 `facts.scripts.test` 存在 → 自动加入对应包管理器的 test 命令
- 只读类：不加
- 没有 `scripts.test`：不加，不编造

## 5. 验收

| 编号 | 必须看到 |
|---|---|
| A-1 | 只读提问不加 `verificationCommands`，不跑测试 |
| A-2 | 修改类 + 真实 test 脚本 → TaskSpec 含 `pnpm test`（或 npm/yarn） |
| A-3 | 没有 `scripts.test` → 仍不加命令 |
| A-4 | 基线已有 1 个失败，Agent 只改目标文件、未引入新失败 → `VERIFIED_COMPLETE` |
| A-5 | 基线全绿，Agent 改坏另一个测试 → 不是 `verified_complete`，证据含新失败身份 |
| A-6 | 基线失败与终态失败相同（身份或指纹相同）→ 通过 |
| A-7 | Agent 删除 `tests/` 下文件 → 不得验证通过 |
| A-8 | AgentRunner 不得在未跑差集的情况下自行 `VERIFIED_COMPLETE` |

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

人肉验证（有 API Key 时）使用 `/tmp/codeden-ws` 副本，不要直接改本仓库。
