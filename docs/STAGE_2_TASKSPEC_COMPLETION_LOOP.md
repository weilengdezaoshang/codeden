# CodeDen 阶段 2：TaskSpec 与完成验证闭环

## 1. 目标

日常命令 `pnpm codeden "<任务>"` 只有独立 Verifier 通过才算成功。模型说「已完成」不等于任务完成。

```text
配置 + Secret
-> ProjectInspector
-> TaskSpecBuilder
-> AgentRunner
-> 模型提出完成
-> CompletionVerifier（改动路径 + 可选命令）
-> 失败则回灌证据继续修
-> 成功则 VERIFIED_COMPLETE，退出码 0
```

Eval Harness 的 `resolved` 仍由 Native Grader 计算，本阶段不改评测路径。

## 2. 必须完成

- `ProjectFacts` 与 `ProjectInspector`
- `TaskSpecBuilder`
- Agent 状态 `VERIFIED_COMPLETE`
- `DiffPolicyVerifier`、`CommandVerifier`、`CompletionVerifier`
- Agent 验证失败回环
- CLI：仅 `verified_complete` 退出 0

## 3. 明确不做

MCP、worktree、Docker、Session、Skills、Baseline 回归差集、防删测试、LLM Judge、新文件搜索工具。

## 4. 契约

### ProjectFacts

```ts
{
  root: string
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'unknown'
  hasPackageJson: boolean
  scripts: { test?: string; typecheck?: string; build?: string; lint?: string }
  git: { available: boolean; dirty: boolean }
}
```

只记录仓库里真实存在的脚本，不编造命令。

### CompletionVerifier

```ts
verify(taskSpec, workspace) -> { passed: boolean; message: string; evidence: string[] }
```

- DiffPolicy：`changedPaths` 不得超出 `allowedPaths`。若 `allowedPaths` 不是笼统的 `.`，还必须至少改动其中一个允许路径。`.git/` 等版本库内部文件不计入改动。
- CommandVerifier：`verificationCommands` 为空则跳过；否则每条必须 exitCode 0。
- `passed` 只由 Verifier 计算。

## 5. 验收

| 编号 | 必须看到 |
|---|---|
| A-1 | Inspector 识别 package.json / pnpm / 真实 scripts |
| A-2 | Mock 不改文件直接交卷 → 不是 VERIFIED_COMPLETE，退出码非 0 |
| A-3 | 只允许 package.json 却写 README → 不得验证通过 |
| A-4 | Mock 正确改 version → VERIFIED_COMPLETE，退出码 0 |
| A-5 | 第一次交卷失败、第二次改对 → 最终 VERIFIED_COMPLETE |
| A-6 | 一直交卷但不改对直到 maxTurns → 失败，不得显示成功 |
| A-7 | AgentRunner 不得自行把状态设为验证通过 |

```bash
pnpm typecheck && pnpm test && pnpm build
```
