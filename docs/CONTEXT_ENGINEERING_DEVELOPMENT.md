# 上下文工程开发文档：最小模块拆分与完成标准

状态：草案 v1（2026-09-05）
上游文档：需求见 `docs/prd/context-engineering-modules.md`（CE-1～CE-7）；验收方式见 `docs/AGENT_EVALUATION_PLAN.md`（EX 矩阵）。
架构对齐：`CODEDEN_REFACTOR_EVAL_MASTER_PLAN.md` 9.20/8.7（折叠契约不改名、不改语义）。

---

## 1. 拆分原则

- **每个模块可独立交付、独立回滚**：合入主干后不开启新行为路径时与现状等价（事件类增量除外）。
- **确定性先行**：凡能用确定性规则完成的（截断、占位、校验、回退）不依赖模型调用；LLM 摘要一律作为增强层，失败必须降级到确定性路径。
- **契约不改写**：`FoldedSessionMemory`、`FoldValidator`、折叠事务流程沿用主计划 9.20/8.7 命名。
- 提交遵守 `AGENTS.md`：`feat(runtime): 新增上下文预算层.` 一类，一个模块一组提交。

## 2. 模块总览与依赖

| 模块 | 内容 | 对应 PRD | 优先级 | 依赖 |
|---|---|---|---|---|
| M0 | 上下文预算基座 + Anthropic system 消息缺陷修复 | CE-1（部分） | P0 | 无 |
| M1 | 工具结果统一裁剪 | CE-3.1/3.3 | P0 | 无（可与 M0 并行） |
| M2 | 结构化 Session Folding | CE-2 | P0 | M0（阈值信号） |
| M3 | 子 Agent 摘要回传 | CE-4 | P1 | 无（建议在 M2 后） |
| M4 | Provider 缓存与 max_tokens 恢复 | CE-5 | P1 | 无 |
| M5 | Mock 剧本扩展 + robustness/长任务 case 套件 | 评估方案 §4/§7 | P0 | M0–M3 交付后跑验收；case 编写可先行 |
| M6 | 长期记忆自动提取 | CE-6 | P2 | M2 |
| M7 | Checkpoint/Replay | CE-7 | P2 | 主计划阶段 8 |

实施顺序：`M0 → M2 → M3 → M5（验收 M0–M3）`，`M1`、`M4` 并行插队；`M6/M7` 待 P0 全部验收后启动。

## 3. 模块定义

### M0 上下文预算基座 + Anthropic system 消息缺陷修复

**范围**
- 新增 `packages/agent-runtime/src/context/`：
  - `token-estimate.ts`：`estimateTokens(text, coefficient?)`，默认 4 字符/token，系数可由配置覆盖；结果带 `estimated: true`。
  - `context-budget.ts`：`ContextBudgetPolicy { utilizationThreshold=0.70, estimateCoefficient, reserveOutputTokens }`；`computeUtilization(messages, profile)`。
- `models/model-types.ts` 增加 `ModelProfile { contextWindowTokens?, maxOutputTokens?, supportsPromptCaching? }`（全部可选）；`models/builtin-providers.ts` 为内置 provider 填充；未知模型给保守默认并置 `estimated=true`。
- `agent-runner.ts` 每次模型请求前计算 utilization 并发 `context.utilization` 事件（仅观测，不改行为；阈值触发逻辑留待 M2 接线）。事件类型需在 `packages/core/src/events/run-event.ts` 的事件联合中新增 `context.*` 源（当前不存在，属 core 契约增量，需同步 telemetry 白名单）。
- 缺陷修复：`anthropic-model-provider.ts` 不再只取第一条 system 消息——多条 system 合并为单条有序块（现有 `compactionNote` 因此丢失）。
- `apps/agent` 新增 `/context` 命令：窗口、估算占用、距阈值余量。

**非目标**：不引入 tiktoken；不改 `max_tokens` 请求值（M4 处理）；不做折叠。

**异常场景实现清单**：窗口未知（estimated 标记 + 保守默认）；真实 usage 到达后校准估算系数（记录偏差，供配置调参）。

**测试清单**
- 单测：estimateTokens 边界（空串/多字节字符/超长）；utilization 计算（含 reserveOutput）；未知窗口默认值。
- 契约：Anthropic 多条 system 消息合并顺序与内容（现有 `tests/contract/model-provider.contract.test.ts` 扩展）。
- 回归：`pnpm typecheck/test` 全绿。

**完成标准（DoD）**
1. 上述测试全绿，`pnpm build` 通过。
2. 交互会话中 `/context` 能展示估算占用；长对话能观察到 `context.utilization` 事件。
3. Anthropic 通道折叠注记丢失缺陷有契约测试覆盖且修复（评估方案 EX-12 的断言可运行）。
4. 不开启任何压缩行为变化（对比主干，仅新增事件与命令）。

**回滚方式**：模块删除 + provider 修复单独 revert（契约测试保证不静默回归）。

### M1 工具结果统一裁剪

**范围**
- `agent-runner.ts`：工具结果入历史前按 token 估算裁剪——超限时保留 head+tail（各半），注入 `[truncated: 原始 N 字符，已截断]` 标记；上限来自 `ContextBudgetPolicy`（如 `toolResultBudgetTokens`，默认对齐现有单工具自律值，不放大行为差异）。
- `tools/tool.ts` 的 `ToolDefinition` 增加可选 `resultBudgetChars` 覆盖，供 `run_command` 等放宽；无配置走统一默认。
- 现有各工具自律封顶保留（输入侧限制不变），本模块只管"入历史"这一层。

**非目标**：不做历史占位符折叠（M2 的保留策略处理）；不改 session/trace 全量落盘。

**异常场景实现清单**：EX-7（大输出截断后任务可继续、标记可见）。

**测试清单**：单测裁剪函数（精确边界、多字节截断不劈半个字符）；集成：mock 剧本返回超长输出，断言历史中的结果带截断标记且下轮请求 token 下降。

**DoD**
1. 裁剪单测 + EX-7 case 通过。
2. 现有全部工具测试不回归（自律封顶值不变）。
3. trace 中保留未裁剪原文（断言），运行历史为裁剪后文本（断言）。

**回滚方式**：裁剪上限设 `Infinity` 等价关闭；模块可整体禁用。

### M2 结构化 Session Folding

**范围**（两步提交，均在同一模块 DoD 内）
- **2a 确定性折叠底座**：新增 `packages/agent-runtime/src/context/folding/`：
  - `folded-memory.ts`：`FoldedSessionMemory` schema（主计划 8.7 原样）+ zod 校验。
  - `transcript-builder.ts`：冻结源区间、构造无 Secret transcript（复用 redactor）。
  - `session-folder.ts`：确定性抽取（目标、约束、allowedPaths、关键文件、失败证据、未完成 tool call、最近保留轮），产出三层结构；`FoldValidator` 校验必保留项，缺项拒绝切换。
  - 折叠投影落盘（`FoldProjectionStore`）：原子写、含 `sourceSequenceRange`/`sourceDigest`；session 目录新增 fold 投影文件，原始事件不删。
- **2b 触发与 LLM 增强**：
  - 触发接线：M0 阈值信号、连续工具错误、无进展重复（复用熔断信号）、手动 `/fold`（`/compact` 别名保留）。
  - LLM 摘要填充三层记忆文本字段（替换现有"40 条×2000 字符"摘要逻辑）；失败/非法输出 → `degraded=true` 确定性回退，事件记 `context.compacted { ok, degraded, trigger }`。
  - 折叠注记注入改为单 system 结构化段落（配合 M0 修复，Anthropic/OpenAI 两通道行为一致）。
  - 恢复语义：恢复会话时校验 fold 投影 `sourceDigest`，过期/损坏则按确定性路径重建或回退旧历史。

**非目标**：不删原始事件；不改 `WorkspacePolicy`；不做跨会话折叠。

**异常场景实现清单**：EX-9（阈值触发后任务继续）、EX-10（摘要失败旧历史有效）、EX-11（非法 JSON 拒绝切换 + degraded 事件）、EX-13（未完成 tool call 不得摘要为成功）、主计划场景 8-6/8-7/8-8。

**测试清单**
- 单测：确定性抽取保留必留项；FoldValidator 拒绝缺项；degraded 回退路径。
- 集成：mock 剧本触发阈值 → 折叠 → 任务完成（EX-9 case）；摘要注入错误（EX-10/11）；session 恢复后折叠语义一致。
- 契约：折叠注记在两个 provider 通道的请求体中存在。

**DoD**
1. EX-9/10/11/13 case 全过（依赖 M5 mock 扩展，交付顺序上 M5 的 mock 部分先行合入）。
2. 折叠后 `.codeden/sessions/` 原始事件完整（断言）；`/fold` 与阈值触发均可用。
3. 长任务 case（评估方案 §7 第 3 类）折叠前后均能 resolved，且折叠后 input tokens 显著下降（A/B 记录，见评估方案 §5）。
4. 失败注入下不出现"伪成功"：未完成 tool call 与 degraded 均如实标注。

**回滚方式**：触发开关 `context.folding.enabled`（默认关闭即现状行为）；折叠投影文件独立，关闭后旧历史继续有效。

### M3 子 Agent 摘要回传

**范围**
- `tools/builtins/subagent.ts`：子任务结束后产出结构化摘要（结论、关键证据、涉及文件、失败/未完成原因）+ 元信息（轮数、工具调用数、终止原因），≤2000 字符；父上下文只注入摘要与元信息。
- 摘要生成：确定性优先（末条消息 + 结构化字段拼装）；可选 LLM 增强，失败降级为强制截断 + `degraded` 标记。
- 完整 `turnTranscript` 继续写入 session/trace，不进父运行上下文。

**非目标**：不放宽子 Agent 现有限制（3 轮/6 调用/并发 2/只读）；不做子 Agent 间通信。

**异常场景实现清单**：EX-14（父轮输入下降断言）；子任务熔断/超时必须保留"未完成"语义（禁止摘要为成功）。

**测试清单**：单测摘要拼装与降级；集成：mock 子任务超长轨迹，断言父上下文注入 ≤2000 字符且 trace 全量。

**DoD**
1. EX-14 断言通过；父任务用子结果继续完成任务的功能 case 通过。
2. 子 Agent 失败场景摘要语义正确（未完成 ≠ 成功）。
3. 现有 subagent 限制测试不回归。

**回滚方式**：开关 `subagent.summaryMode: full|summary`，默认 summary，可切回 full。

### M4 Provider 缓存与 max_tokens 恢复

**范围**
- `prompt-composer.ts` 拆分稳定前缀（身份/规则/工具定义/Memory/Skill 清单等低频变化段）与动态段（goal、会话）；Anthropic 请求体对稳定段加 `cache_control`（配置开关，默认开）。
- `ModelUsageSchema` 增加可选 cache token 字段（read/creation），缺失记 `unavailable`，不当作 0；`/cost` 与 TrialMetrics 透传。
- `max_tokens`：取 `ModelProfile.maxOutputTokens` 替换硬编码；`stopReason='max_tokens'` 时先做一次续写请求（携带"从截断处继续"指令），仍截断则按错误终止并明确标注（不得当完成）。

**非目标**：OpenAI 兼容通道不做自动缓存（留接口）；不改重试策略（现有 `requestModelWithRetry` 不动）。

**异常场景实现清单**：EX-2（截断不得 VERIFIED_COMPLETE）；缓存不可用时正常运行。

**测试清单**：契约测试（请求体含 cache_control、cache token 解析、截断→续写→完成/终止三态）；单测 profile 驱动 max_tokens。

**DoD**
1. EX-2 case 通过；续写仅一次（断言请求次数）。
2. Anthropic 真实冒烟（可选跑）中 cache token 被记录；mock 全绿。
3. 其他 provider 行为无回归。

**回滚方式**：`cache_control` 与续写各有独立开关，均可关回现状。

### M5 Mock 剧本扩展 + robustness/长任务 case 套件

**范围**
- mock provider（`packages/agent-runtime/src/models/mock-model-provider.ts`）剧本语法扩展：第 N 轮返回指定错误（429/5xx/截断/超长输出/非法折叠摘要）；不访问网络（评估方案 §7 第 6 类）。
- case 落地：§7 backlog 第 3/5/6 类先行（长任务、对抗安全、异常注入）；EX-15/16/18/19 机制已有项补 case。
- `evals/cases/robustness/` 与 `evals/cases/validation/` 目录建立，Native YAML 契约不变。

**非目标**：不做外部 benchmark 数据下载自动化；holdout 套件 ≥100 例分批积累，不阻塞本模块。

**DoD**
1. robustness 套件可一键运行（平台 datasetId 或 `pnpm eval` 批量），夜间节奏可挂。
2. 评估方案 §4 矩阵中全部"缺失"行更新为"已验收"，附 case 路径。
3. M2/M3 的验收 case 在本套件内可复跑。

**回滚方式**：纯增量（新目录、新剧本字段向后兼容）。

### M6 长期记忆自动提取（P2，启动条件：M2 验收通过）

**范围**：轮次结束异步提取候选记忆 → 待审队列（`/memory review`）→ 确认入库；`auto` 模式显式开启；候选来源按不可信数据处理；记忆版本化覆盖保留历史。
**DoD**：提取不阻塞主任务（失败静默跳过）；注入通道不变；冲突记忆有版本历史；审查流可拒绝全部候选。

### M7 Checkpoint / Replay（P2，衔接主计划阶段 8）

**范围**：轮级 checkpoint（TaskSpec/state/预算/验证结果/base commit+diff）；未完成 tool call 恢复标记 `unknown`；eval 侧录制模型响应离线回放（主计划场景 8-4），作为 M0–M5 的长期回归资产。
**DoD**：以主计划阶段 8 文档验收场景为准（8-1～8-5、8-8）。

## 4. 提交拆分建议（Conventional Commits）

| 提交 | 内容 |
|---|---|
| `feat(runtime): 新增上下文 token 预算与 ModelProfile 契约.` | M0 契约部分 |
| `fix(runtime): 修复 Anthropic 通道丢弃多条 system 消息.` | M0 缺陷修复（独立提交，含契约测试） |
| `feat(cli): 新增 /context 上下文占用视图.` | M0 CLI |
| `feat(runtime): 新增工具结果入历史统一裁剪.` | M1 |
| `feat(runtime): 新增 FoldedSessionMemory 确定性折叠底座.` | M2a |
| `feat(runtime): 接入折叠触发与降级摘要.` | M2b |
| `feat(runtime): 子 Agent 结果压缩回传父上下文.` | M3 |
| `feat(runtime): 接入 Anthropic 提示缓存与 max_tokens 恢复.` | M4 |
| `test(evals): 新增 robustness 评测套件与 mock 异常剧本.` | M5 |

## 5. 全局完成定义（上下文工程里程碑）

1. 评估方案 §4 矩阵 22 项全部"已有/已验收"，无"缺失"。
2. 长任务 case 在开启折叠后：resolved 不回退、input tokens 下降、无伪成功（A/B 记录入 ReleaseEvidence）。
3. `pnpm typecheck/test/build` 全绿；回归、validation（含折叠开关两组）可在平台重复评测。
4. README「当前仍未交付」中"结构化 Session Folding 摘要压缩"一项移除；`docs/prd/context-engineering-modules.md` 状态更新为已交付并附实现索引。

---

## 附录 A：评审记录（2026-09-05，评审对象：PRD v1 + 评估方案 v1 初稿）

见下方评审结论表（评审维度：异常场景覆盖是否与代码现状对应、口径是否与既有文档冲突、模块边界是否可独立交付）。

| # | 评审发现 | 处置 |
|---|---|---|
| R1 | 初稿评估方案开头"关系说明"引用了错误的文档名并混入自指句 | 已修正为指向根目录 `AGENT_EVAL_IMPLEMENTATION_PLAN.md` 的正确关系表述 |
| R2 | PRD 初稿将"权限拒绝回传模型"误写为现状，实际实现是终止整轮（防模型立即重试） | 已核对 `agent-runner.ts` 后在评估方案 EX-6 中按事实标注"已有"，PRD 不再出现该表述 |
| R3 | EX-6（ask 模式权限拒绝）在 eval 路径不可触发：`agent-launcher.ts` 写死 `approvalMode:'auto'`，纯平台 case 无法覆盖交互路径 | 评估方案 EX-6 现状列已注明"eval 路径固定 auto，需在交互路径验证"；M5 范围限定为平台可运行 case，交互路径由 e2e/手工剧本覆盖 |
| R4 | 折叠验收 case 依赖 mock 异常剧本，但 mock 扩展原属 M5，存在"用未交付工具验收已交付模块"的顺序矛盾 | M2 DoD 明确标注依赖 M5 的 mock 部分先行合入；M5 描述改为"mock 剧本部分先行" |
| R5 | 评估方案统计口径若自行定义 pass@k 会与重复评测方案的 `statisticsVersion=1` 冲突 | 已改为只引用 `docs/REPEAT_EXPERIMENTS_DEVELOPMENT.md`，pass@k/all-k 标注为该方案统计模块交付后的消费项 |
| R6 | PRD 初稿未列"Anthropic 折叠注记丢失"这一已确认缺陷的具体修复位置 | CE-2 FR-2.6 与 M0 范围均已落到 `anthropic-model-provider.ts` 多 system 消息合并，EX-12 提供断言 |
| R7 | M0 若同时改 provider 修复与新增预算层，违反"一个提交一个目标" | 提交拆分表将缺陷修复独立为 `fix(runtime)` 提交 |

评审结论：PRD 与评估方案在 R1–R7 修正后通过评审，可进入 M0 开发。
