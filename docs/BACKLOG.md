# 待办盘点（2026-09-06）

状态依据：代码核对 + 各方案文档。上下文工程的执行修订见 `docs/CONTEXT_ENGINEERING_DEVELOPMENT.md` 附录 B，此处不重复，只列索引。

## 〇、实现清单（按执行顺序，可执行粒度）

> 每项独立成批提交；开关随模块交付（不欠账）。约定：`feat(runtime)`/`feat(tools)`/`feat(cli)` + 中文描述 + 结尾句点。

### 0. `context.folding.enabled` 开关（补 M2b 欠账）
- `packages/core/src/config/config-schema.ts`：agent 配置段新增 `folding?: { enabled?: boolean }`，缺省 `false`（= 现 40k 字符旧路径）。
- `apps/agent/src/agent-command.ts`：`createSession` 按 config 决定是否传 `sessionOptions.fold`。
- 测试：关闭时 submit 走旧路径不折叠（复用 `tests/unit/agent-session-fold.test.ts` 模式）。

### 1. M1 工具结果统一裁剪（EX-7）
- 第 0 步：盘点 `packages/agent-runtime/src/tools/builtins/` 各工具自律封顶值（read_file / run_command / read_many_files / web_fetch 等），据此定 `ContextBudgetPolicy.toolResultBudgetTokens` 默认值（正常工具不触发）。
- `context-budget.ts`：policy 增加该字段；`tools/tool.ts` 的 `ToolDefinition` 加 `resultBudgetChars?` 覆盖。
- `agent-runner.ts`：工具结果 stringify+脱敏后入历史前裁剪——head+tail 各半，注入 `[truncated: 原始 N 字符，已截断]`；预算设 `Infinity` 即关闭。
- 测试：精确边界、多字节不劈半字符、mock 超长输出后下轮 token 下降且标记可见；现有工具测试自律值不回归。

### 2. M3 子 Agent 摘要回传（EX-14）
- `tools/builtins/subagent.ts`：`subagent.summaryMode: full|summary`（默认 summary，可切回）。
- 新增摘要构造器（复用 M2b「确定性拼装 + LLM 增强 + degraded 回退」模式）：结论、关键证据、涉及文件、失败/未完成原因（禁止摘要为成功）+ 元信息（轮数/调用数/终止原因），≤2000 字符。
- 完整 `turnTranscript` 照常进 session/trace，只挡父上下文。
- 测试：mock 超长子轨迹下父轮输入 token 下降断言；熔断/超时子任务语义为未完成。

### 3. M4 缓存与 max_tokens 恢复（EX-2，可与 2 并行）
- `prompt/prompt-composer.ts`：拆稳定前缀（身份/规则/工具定义/Memory/Skills）与动态段（goal/会话）。
- `models/anthropic-model-provider.ts`：稳定段 `cache_control`（独立开关）；`ModelUsageSchema` 加 cache read/creation 字段（缺失记 `unavailable` 不当 0），`/cost` 与 TrialMetrics 透传。
- `agent-runner.ts`：`max_tokens` 改由 ModelProfile 驱动（替换硬编码 8192/16384）；`stopReason='max_tokens'` 续写一次（带"从截断处继续"指令），仍截断则按错误终止并明确标注（不得当完成）。
- 测试：契约（请求体含 cache_control、cache token 解析）、续写三态（完成/仍截断→终止）、请求次数断言（仅续写一次）。

### 4. M5 mock 剧本扩展 + case 套件
- `models/mock-model-provider.ts`：剧本语法扩展 `{ round: N, kind: 'error'|'truncated'|'oversized'|'invalid-fold-json' }`（向后兼容现有 FIFO）。
- 新建 `evals/cases/robustness/`、`evals/cases/validation/`：EX-7/9/10/11/13/14 各落 case；补 EX-15/16/18/19（机制已有）case。
- 平台侧：robustness 套件 datasetId 接线，夜间可批量跑。
- 完成后：README「结构化 Session Folding」划线（EX-2 项等 M4）。

### 5. 重复评测 P0 第 7 步（唯一缺口）
- devDependency `@playwright/test`；`tests/browser/eval-platform.spec.ts` + `pnpm test:browser`；webServer 复用 `scripts/start-eval-platform.mjs`（mock + 临时库）。
- 覆盖 REPEAT_EXPERIMENTS §12.4 验收清单（创建/进度/取消/刷新/四分展示/筛选分页/对比入口/窄屏键盘/失败展示）。

### 6. 真实冒烟（M0/M2 DoD 残留）
- 真实模型长对话触发折叠：Anthropic 通道核对注记可见（EX-12 真实通道）、`context.compacted` 事件、恢复后语义一致。
- 交互会话核对 `/context` 数字与占用变化。

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
