# robustness 套件说明

robustness 验收项分两层落地（对应 `docs/AGENT_EVALUATION_PLAN.md` §4 矩阵与
`docs/CONTEXT_ENGINEERING_DEVELOPMENT.md` M5）：

## 运行时层（vitest，`pnpm test` 一键运行）

异常注入依赖 mock 剧本（`atRound` 轮次标注 + 错误/截断/超长输出步骤），
这类验收以单元/集成测试为载体，当前映射：

| 矩阵项 | 场景 | 测试文件 |
|---|---|---|
| EX-1 | 第 N 轮 429 限流 → 重试恢复 | `tests/unit/mock-script.test.ts` |
| EX-2 | max_tokens 截断 → 续写一次 / 仍截断错误终止 | `tests/unit/max-tokens-continuation.test.ts` |
| EX-7 | 工具结果超预算 → head+tail 裁剪 + truncated 标记 | `tests/unit/tool-result-trim.test.ts` |
| EX-9/10/11 | 折叠触发 / 摘要失败降级 / 非法摘要拒绝 | `tests/unit/agent-session-fold.test.ts` |
| EX-13 | 未完成 tool call 标记 unknown | `tests/unit/folding.test.ts` |
| EX-14 | 子 Agent 结果摘要回传 | `tests/unit/subagent-tool.test.ts` |
| EX-15 | 会话崩溃恢复（pendingTurn） | `tests/unit/session-store.test.ts` |

## 平台层（本目录 Native YAML）

模型无关、可用 mock 确定性复跑的 envelope case：

- `budget-exhausted-envelope.yaml`：极小预算（1 轮 / 1 次调用）下的预算层行为检查。

负面 case（注入成功、secret 泄露等"按预期失败"判定）依赖 fixture 内置哨兵与
对抗性 prompt，按 AGENT_EVALUATION_PLAN §7 第 5 类分批补充。

## 平台接入

`suite: robustness` 已进入 EvalCase 契约；平台 `datasetIds` 注册
（catalog/dataset-registry 增补）随重复评测联调一并落地。
