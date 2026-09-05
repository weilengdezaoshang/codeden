# 上下文工程与缺失模块 PRD（对标开源社区）

状态：草案 v1（2026-09-05）
负责人：产品（本文）→ 开发（见 `docs/CONTEXT_ENGINEERING_DEVELOPMENT.md`）→ 评测（见 `docs/AGENT_EVALUATION_PLAN.md`）

---

## 1. 文档定位

当前 CodeDen 的上下文工程只有"事后计量 + 字符启发式压缩"，缺少完整的预算—裁剪—折叠闭环；README「当前仍未交付」清单中的结构化 Session Folding、长期记忆自动提取、Checkpoint/Replay、Skills Runtime 使用观测均属上下文工程范畴。

本文以产品视角，基于开源社区主流编码 Agent 的公开实践补齐这些模块的需求定义。设计原则：

- 主计划 `CODEDEN_REFACTOR_EVAL_MASTER_PLAN.md` 9.20（Structured Session Folding）与 8.7（FoldedSessionMemory）已有架构设计，本文**细化需求，不推翻契约**。
- 每个模块必须能独立交付、独立评测，不与评测体系耦合（Agent 侧改动通过 `docs/AGENT_EVALUATION_PLAN.md` 的 case 验证）。
- 折叠/压缩只影响运行上下文（投影），原始事件与会话记录永久保留，用于审计与回放。

### 1.1 现状基线（代码事实，2026-09-05）

| 能力 | 现状 | 位置 |
|---|---|---|
| 上下文组装 | 每轮一次性拼接 system prompt + 会话重放 | `packages/agent-runtime/src/prompt/prompt-composer.ts` |
| 自动压缩 | 会话字符数 > 40,000 触发，丢弃旧轮只留 4 轮 + 一段非结构化 `compactionNote` | `packages/agent-runtime/src/session/agent-session.ts` |
| LLM 摘要 | 可选，取最近 40 条、每条截 2000 字符；失败回退固定文案 | `apps/agent/src/agent-command.ts` |
| Token 计量 | 仅事后计量（usage 上报、`/cost`），无窗口感知 | `packages/agent-runtime/src/models/token-usage.ts` |
| 工具结果入历史 | 全量 `JSON.stringify` 入列，runner 层无统一裁剪 | `packages/agent-runtime/src/agent/agent-runner.ts` |
| 子 Agent 回传 | 子 Agent 完整 `turnTranscript` 原样进入父上下文 | `tools/builtins/subagent.ts` + `agent-runner.ts` |
| Prompt 缓存 | 无 `cache_control`；system 前缀内嵌每轮变化的 goal，缓存不友好 | `models/anthropic-model-provider.ts` |
| 已知缺陷 | Anthropic 通道只取第一条 system 消息，`compactionNote`（第二条 system）被静默丢弃 | `models/anthropic-model-provider.ts` |
| `max_tokens` 截断 | `stopReason='max_tokens'` 无恢复分支 | `agent-runner.ts` |
| 记忆 / Skill | 仅手动 `/memory add`、`/skill`，无自动提取、无使用观测 | `memory/memory-store.ts`、`skills/skill-loader.ts` |

## 2. 开源社区对标

| 能力 | Anthropic（Claude Code） | OpenHands（Condenser） | Cline | Gemini CLI | Manus | CodeDen 现状 |
|---|---|---|---|---|---|---|
| 压缩触发 | 接近窗口上限时 | 每步检查 `max_size`（事件数）+ 溢出错误兜底 | 阈值自动摘要（内部约 50% 交接，建议 70–80% 手动重置） | — | KV-cache 友好的 append-only | 固定 40k 字符，与窗口无关 |
| 摘要内容 | 架构决策、未解决 bug、实现细节、最近 5 个文件 | 头部 `keep_first` 逐字保留 + 中部 LLM 摘要 + 尾部近期事件 | 全量摘要替换历史 | — | 文件系统存状态，上下文只留索引 | 丢旧轮 + 非结构化 note |
| 结构化折叠 | —（compaction prompt 先召回后精修） | Condensation 事件（forgotten ids + summary + offset），可 Pipeline 串联 | — | — | — | 无 |
| 工具结果清理 | tool result clearing（平台能力） | Pipeline 一环 | — | — | — | 无，依赖各工具自律封顶 |
| 子 Agent 隔离 | 子代理消耗数万 token 探索，回传 1–2k token 摘要 | — | `new_task` 工具交接 | — | — | 子 Agent 全量轨迹回传父上下文 |
| 上下文可见性 | — | — | 上下文进度条 | — | — | 无占用视图，仅 `/cost` |
| 窗口外记忆 | todo list / memory tool（文件系统） | — | persistent memory（new_task） | session 自动保存/恢复 | NOTES.md、todo recitation | 手动 `/memory` |
| 断点恢复 | — | — | — | checkpointing（恢复对话并重放未决 tool call） | — | 会话可恢复（已交付），无 checkpoint/replay |

结论：CodeDen 在"预算、裁剪、结构化折叠、子 Agent 隔离、可见性"五个能力上均为空白，与社区主流做法差距集中在上下文工程；断点恢复已有一半（会话恢复），缺 eval 侧 Replay。

## 3. 模块需求

### CE-1 上下文预算层（ContextBudget）｜P0

让 Agent 在"事前"知道还剩多少上下文，而不是溢出后被动报错。

- FR-1.1 Provider/模型声明 `ModelProfile`：`contextWindowTokens`、`maxOutputTokens`、`supportsPromptCaching`。内置 provider 全部补齐，未知模型按保守默认并打 `estimated=true` 标记。
- FR-1.2 提供 `estimateTokens(text)`：字符→token 估算（约 4 字符/token 起步，按 provider 可配置系数），不引入重型分词器依赖；估算结果在事件中标注为估算值。
- FR-1.3 每次模型请求前计算 utilization（本轮消息 + 预留输出 vs 窗口），超过阈值（默认 0.70，可配置；参考 Cline/新版 BearCode 行为样本）时触发折叠流程（CE-2）。
- FR-1.4 utilization 作为事件上报（`context.utilization`），并暴露 `/context` 命令与进度视图：窗口大小、已用、缓存命中（如可得）、距阈值余量。
- FR-1.5 阈值触发与"溢出兜底"并存：provider 返回上下文超限类错误时，按折叠兜底路径处理一次后重试（参考 OpenHands 溢出错误 → CondensationRequest 机制）。
- 异常场景：窗口未知（estimated 标记 + 保守阈值）；估算与真实 usage 偏差大（用已采集的真实 usage 校准系数）；溢出兜底再失败（见评估方案 EX-6/EX-7）。
- 验收：长对话 case 中在达到阈值时能观察到 `context.utilization` 事件并在阈值处触发折叠；`/context` 可展示。

### CE-2 结构化 Session Folding｜P0

替换现在的"丢旧轮 + 非结构化 note"，落地主计划 9.20 的模块与 8.7 的数据模型。

- FR-2.1 折叠产物为三层 `FoldedSessionMemory`（episode / working / tool），含 `sourceSequenceRange` 与 `sourceDigest`，schema 校验失败即拒绝切换。
- FR-2.2 折叠事务：冻结源事件区间 → 构造无 Secret transcript → 生成三层记忆 → `FoldValidator` 校验（TaskSpec 目标、约束与 allowed paths、关键文件路径、失败证据、未完成 tool call 必须保留）→ 原子写入折叠投影 → 切换运行历史；任一步失败沿用旧历史。
- FR-2.3 保留策略（对齐 Anthropic 摘要召回清单）：最近若干轮逐字保留（OpenHands `keep_first` + 尾部保留的混合策略）；旧 tool 输出折叠为占位符（原始保留在 session/trace）。
- FR-2.4 触发信号：utilization 超阈值（CE-1）、连续工具错误、相同调用无进展重复（复用现有熔断信号）、手动 `/fold`；现有 `/compact` 保留为别名。
- FR-2.5 折叠摘要生成失败或输出非法时：显式 `degraded=true` 回退（保留结构化字段能填多少填多少 + 固定文案），绝不伪装成功；事件记录 `context.compacted { ok, degraded, trigger }`。
- FR-2.6 修复既有缺陷：Anthropic 通道丢弃第二条 system 消息导致 `compactionNote` 丢失；折叠注记改为单 system 内结构化段落注入。
- 异常场景：见评估方案 EX-6～EX-8；未完成 tool call 禁止被摘要为已成功（主计划场景 8-8）。
- 验收：长任务 case 折叠后能继续完成原任务；折叠后 session 文件仍含原始事件；恢复会话时折叠语义一致。

### CE-3 工具结果裁剪与折叠（Tool Result Clearing）｜P1

- FR-3.1 runner 层统一裁剪：工具结果入历史前超过上限（按 token 估算）时 head+tail 截断并标注 `truncated`；替代目前依赖各工具自律封顶的散乱做法。
- FR-3.2 历史中"深埋"的旧 tool 结果替换为占位符（保留调用参数摘要与结果摘要），只对运行上下文生效，session/trace 保留全量。
- FR-3.3 `read_file`/`read_many_files`/`run_command` 等大输出工具的分页/截断提示文案统一（引导模型用 offset 续读，而不是重读全量）。
- 异常场景：截断后任务仍可继续（EX-10）；占位符不得出现在最终回复引用中造成"幻觉文件内容"。

### CE-4 子 Agent 结果压缩回传｜P1

- FR-4.1 子 Agent 结束时生成结构化摘要（结论、关键证据、涉及文件、失败原因），父上下文只注入摘要 + 子任务元信息（轮数、工具调用数）；目标 ≤ 2000 字符（对齐 Anthropic 子代理回传量级）。
- FR-4.2 完整 `turnTranscript` 只写 session/trace，不进父运行上下文。
- FR-4.3 摘要生成失败时回退为强制截断的原始结果 + `degraded` 标记，不静默丢内容。
- 异常场景：子 Agent 被熔断/超时的摘要语义（必须保留"未完成"事实，不得摘要为成功）。

### CE-5 Provider 上下文契约（窗口、缓存、截断恢复）｜P1

- FR-5.1 `ModelProfile` 声明窗口与输出上限，替换硬编码的 `max_tokens`（8192/16384）。
- FR-5.2 Anthropic prompt caching：稳定前缀（身份/规则/工具定义）与动态内容（goal、会话）分层，稳定段加 `cache_control`；上报 cache read/creation token。
- FR-5.3 `stopReason='max_tokens'` 恢复策略：优先"续写请求"一次，失败则提示模型压缩输出或转人工，而不是静默把截断文本当完成（对齐主计划场景 8-8 的语义诚实原则）。
- FR-5.4 usage 契约扩展 cache token 字段（可选、缺失记 `unavailable`，不当作 0——延续现有计量语义）。
- 异常场景：缓存不可用（无该字段照常运行）；续写仍超限（转人工/降级）。

### CE-6 长期记忆自动提取｜P2

- FR-6.1 会话/轮次结束后异步提取候选记忆（偏好、事实、决策），进入待审队列；默认人工 `/memory review` 确认后入库，`auto` 模式需显式开启。
- FR-6.2 候选来源受不可信数据处理约束：不得改变安全策略、权限、Secret 语义（对齐主计划 9.19 与在线演化安全策略）。
- FR-6.3 记忆注入仍走现有"untrusted persistent memory"通道，不新增授权。
- 异常场景：提取产出与现有记忆冲突（版本化覆盖并保留历史）；提取失败静默跳过，不影响主任务。

### CE-7 Checkpoint / Replay（衔接主计划阶段 8）｜P2

- FR-7.1 轮级 checkpoint：TaskSpec、Agent state、预算、验证结果、workspace base commit + diff（主计划 9.10 清单）。
- FR-7.2 恢复时未完成 tool call 标记 `unknown/interrupted`，禁止伪造结果（主计划场景 8-2/8-8）。
- FR-7.3 eval 侧 Replay：录制模型响应，离线重放产生相同关键事件（主计划场景 8-4），用于上下文模块回归对比。
- 说明：会话恢复已交付（`.codeden/sessions/`），本模块主要是 eval 侧录制回放与轮级粒度，需求细节以主计划阶段 8 文档为准。

## 4. 非目标

- 不做多 Agent 编排（跨任务协作与结果合并）——另行立项。
- 不做 LLM Judge 评分实现——评估方案中只预留契约位。
- 不在本 PRD 内改变 Grader、Verifier、权限模型；折叠/压缩不改变 `WorkspacePolicy` 与审批语义。
- 不引入重型 tokenizer 运行时依赖；token 精度以"可校准的估算"为目标。

## 5. 依赖与排期建议

```text
CE-1 预算层（含 compactionNote 缺陷修复）
  └→ CE-2 结构化折叠（依赖 CE-1 阈值信号）
       └→ CE-3 工具结果裁剪（可独立，先于 CE-2 亦可）
       └→ CE-4 子 Agent 压缩（依赖 CE-2 的折叠投影习惯，可独立先行）
  └→ CE-5 Provider 契约（独立，可并行）
CE-6 记忆自动提取（依赖 CE-2 稳定）
CE-7 Checkpoint/Replay（衔接主计划阶段 8，P2）
```

模块拆分、完成标准与实施顺序见 `docs/CONTEXT_ENGINEERING_DEVELOPMENT.md`；每个模块的评估方式（含异常场景矩阵）见 `docs/AGENT_EVALUATION_PLAN.md`。

### 调研来源

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenHands SDK: Condenser 架构](https://docs.openhands.dev/sdk/arch/condenser)、[OpenHands 博客：Context Condensation](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)
- [Cline: Context Window 进度条](https://cline.bot/blog/understanding-the-new-context-window-progress-bar-in-cline)、[new_task 交接](https://cline.bot/blog/unlocking-persistent-memory-how-clines-new_task-tool-eliminates-context-window-limitations)
- [Gemini CLI: Checkpointing](https://geminicli.com/docs/cli/checkpointing/)、[Session management](https://geminicli.com/docs/cli/session-management/)
- Manus: Context Engineering for AI Agents（KV-cache 稳定前缀、文件系统作为上下文、todo 复述、保留错误）
- [Context Engineering 101（compaction/isolation/memory 对比实验）](https://newsletter.victordibia.com/p/context-engineering-101-how-agents)
