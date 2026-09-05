# 待办盘点（2026-09-06）

状态依据：代码核对 + 各方案文档。上下文工程的执行修订见 `docs/CONTEXT_ENGINEERING_DEVELOPMENT.md` 附录 B，此处不重复，只列索引。

## 一、上下文工程（CE-1～CE-7）

| 项 | 说明 | 验收 |
|---|---|---|
| 第 0 项：`context.folding.enabled` 开关 | 补 M2b 欠账（R8）：config-schema 字段 + CLI 接线，默认关闭即现状；A/B 对照组前提 | 开关关闭时行为与主干一致 |
| M1 工具结果统一裁剪 | 第 0 步盘点工具自律封顶值定默认预算；runner 入历史 head+tail + `[truncated]` 标记；`resultBudgetChars` | EX-7 |
| M3 子 Agent 摘要回传 | 父上下文只收 ≤2000 字符结构化摘要；`subagent.summaryMode` 开关；未完成 ≠ 成功 | EX-14 |
| M4 缓存与 max_tokens 恢复 | 与 M3 并行：稳定前缀 `cache_control`、cache token 字段、ModelProfile 驱动 max_tokens、截断续写一次 | EX-2 |
| M5 mock 剧本扩展 + case 套件 | 第 N 轮错误/截断/超长/非法摘要语法；`evals/cases/robustness|validation/` 落 case | 关门 EX-7/9/10/11/13/14；EX-15/16/18/19 补 case |
| M2 收尾小项 | ①连续工具错误触发（独立于熔断信号，需 runner→session 事件回流）；②恢复时 `sourceDigest` 过期检测（当前仅损坏检测） | — |
| M6 长期记忆自动提取 | P2，启动条件：M2 验收通过 | 见本文档 M6 |
| M7 Checkpoint/Replay | P2，衔接主计划阶段 8；未完成 tool call 恢复标记 `unknown` | 主计划场景 8-1~8-5/8-8 |

## 二、评测与验收基建

| 项 | 说明 | 状态 |
|---|---|---|
| 重复评测 P0 第 7 步 | Playwright 浏览器验收（`tests/browser/` + `pnpm test:browser`），见 REPEAT_EXPERIMENTS §12.4/§13.7 | **缺失**（前 6 步模块已提交） |
| 真实冒烟（M0/M2 DoD 残留） | 真实模型触发折叠 + Anthropic 通道注记可见性；`/context` 交互展示 | 未跑 |
| A/B 门禁链核查 | `baselineJobId` 对比端点与 Wilson 区间可用性；统计模块实际落在 `eval-platform/src/platform/statistics.ts`，与 REPEAT_EXPERIMENTS §8 计划位置（eval-engine）不一致，需统一口径 | 待核查 |

## 三、文档与配置卫生

| 项 | 说明 |
|---|---|
| README 未交付清单更新 | 「结构化 Session Folding 摘要压缩」已交付待验收：标注"待验收（依赖 M5 case + A/B）"而非直接划线；M5+M4 完成后划线 |
| `docs/prd/context-engineering-modules.md` 状态 | 仍为"草案 v1"；按全局完成定义第 4 条，在里程碑关门时更新为已交付并附实现索引 |
| `docs/SESSION_MANAGEMENT.md` | 持久化格式小节补 `fold-projection.json`（折叠投影已入会话目录） |
| `docs/REPEAT_EXPERIMENTS_DEVELOPMENT.md` §8 | 统计模块落点口径修正（eval-engine → eval-platform） |
| `gui-test-screenshots/` | 未跟踪：入库 / 加 .gitignore / 删除，三选一 |

## 四、远期（README 未交付清单其余项）

完整多 Agent 编排、LLM Judge、Champion/Challenger、线上交互评测、Skills Runtime 使用观测与演化——均有专项 PRD/规划文档，不在本轮启动。
