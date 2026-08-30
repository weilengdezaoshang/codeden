# 人格、Token 与评测证据链

## 当前链路

交互任务 → 本地脱敏 Trace → 用户明确授权后生成元数据上传队列。

独立合成 fixture → 隐私检测、容器复现、人工复审 → 审核方签名回执 → 校验签名与 fixture 内容 → 候选入库。

离线运行 → 人格与 Token Grader → 保存 TrialResult 和运行清单 → 从仓库重建统计 → Champion/Challenger 发布门禁。

这些评分不在用户交互过程中额外调用模型，也不阻塞用户等待人工审核。

## 人格和 Token

EvalCase 的 `persona.instruction` 通过既有 PromptComposer 注入用户风格层，不能提升权限。
离线 TrialRunner 只加载 fixture 根目录中的指令，不隐式继承用户 SOUL.md 或 fixture 外的父目录指令；该策略同样传递给子 Agent。正常交互仍加载用户与项目指令。需要评测某种人格时，将其写入 EvalCase 或 fixture，由清单绑定。
`persona-rubric` 支持 `contains`、`not_contains`、`max_chars`、`max_lines`，按权重评分；`critical: true` 的规则不可被其他得分抵消。空回复不能通过，重复规则编号无效。

这是可复现的规则评分，不是语义 LLM Judge，不能据此声称已经验证人格的全部语义、真实性或多轮一致性。

`token-budget` 使用供应商计量，检查 `maxTokens` 和可选的 `maxRequests`。缺失任何请求的用量时失败关闭，不把缺失当作零消耗。根任务计量包含子 Agent。部分供应商的缓存、推理 Token 细分及费用尚未独立建模，当前统计的是统一 input/output。

任务超时且不响应取消、或异常抛出而未返回结果时，从已观察的模型事件恢复消耗，并设置 `tokenUsage.collectionComplete: false`。这些数值是已知下限，不能声称是全部消耗；包含此类试验的汇总覆盖率保守置零，阻止以不完整统计通过 Token 门禁。

可运行内置合成用例：

```sh
codeden eval --case evals/cases/regression/persona-concise.yaml --model mock
```

Mock 只验证接线，不代表真实模型的人格质量。单元测试使用固定模型响应覆盖成功、失败、缺失计量及子 Agent 汇总。

## 本地 Trace 与隐私

`.codeden/traces/<runId>.jsonl` 包含提示词来源、来源内容摘要、最终 Prompt 摘要、模型标识、实际请求消息和工具定义、模型响应、工具结果、最终执行状态及 Token 完整性。通过 `agentSpanId` 和 `agentDepth` 区分父子 Agent。

首个请求保存完整上下文，后续仅保存新增消息；前缀或工具定义变化时保存新的快照。连续文本增量合并，超过大小限制明确标记 `trace.truncated`，预留终态空间。存在截断的 Trace 不应作为完整重放证据。
过长的终态会压缩错误正文，保留状态、计量、父子身份及授权摘要；根任务终态后不再追加事件。可配置的事件和 Trace 字节上限至少为 2000。

本地默认最多保留 500 个、30 天内的已结束 Trace；清理会跳过近期写入与未结束记录。崩溃后未写入终态的文件需人工处理。文件权限为 0600；已知密钥脱敏不等于个人信息完全匿名化，因此本地 Trace 仍需按敏感数据保管。

只有**用户级** `~/.codeden/config.yaml` 可以授权队列：

```yaml
telemetry:
  enabled: true
  consentId: my-explicit-consent-v1
  traceRetentionDays: 30
  maxTraceFiles: 500
```

默认禁用。项目配置不能设置 enabled 或 consentId。授权后只入队事件计数、提示词摘要、Token 数值等白名单元数据，不上传原始代码、对话和工具输出。

授权摘要随终态持久化。终态写入成功但入队失败时，下次启动会补偿（每次最多尝试 20 条），且要求当前授权与记录时一致；未授权、授权已变更或缺少授权摘要的旧 Trace 不补传。待补偿的已授权 Trace 暂缓清理，可能临时超过保留数量。队列按 Trace 身份幂等入队，送达后保留本地轻量回执，防止重启再次排队。终态本身未成功写入的崩溃场景仍需人工处理。

当前没有远程上传服务或自动审核签发服务；outbox 是本地待发送队列，并不表示服务器已经收到数据。完整 Trace 的服务端采集还需要独立的授权、脱敏审核和传输端点。

## 候选入库

```sh
codeden eval candidate-promote --candidate candidate.json --receipt receipt.json --trusted-key reviewer-public.pem
```

审核方使用 Ed25519 私钥，签名内容为 `contentDigest(parseEvalCandidate(candidate))` 的 UTF-8 十六进制字符串。回执结构：

```json
{
  "schemaVersion": 1,
  "candidateDigest": "完整候选的SHA256摘要",
  "signature": "Base64编码的Ed25519签名"
}
```

公钥必须由评测管理员事先信任，不能使用候选作者随附的公钥。私钥不得保存在被评测项目中。签名证明审核方认可完整候选中的隐私、复现和人工复审结果，不代替实际检查；签发方负责至少两次稳定容器复现与所需复审。本实现不会为了生成回执在用户项目执行未知脚本。

`digestCandidateFixture` 计算独立目录摘要，包含路径、内容与执行位，拒绝链接、特殊文件和过大目录。修改 fixture、人格、评分规则或审核结论都需重新审核。加载候选集时再次校验，旧的无回执记录失败关闭，必须补审。并发写入通过目录锁保护；进程异常留下锁时，确认没有晋级进程后再人工清理 `.codeden/evals/candidates.lock`。

## 发布证据与门禁

```sh
codeden eval --case evals/cases/regression/persona-concise.yaml --model mock --release-evidence
codeden eval release-check --champion-run RUN_A --challenger-run RUN_B
```

`--case`、`--champion-run`、`--challenger-run` 均可重复。发布证据模式绑定本地 fixture、Agent 实现和模型配置、评分器实现及配置、Node/平台/依赖锁文件摘要；暂只支持本地独立 fixture。旧运行未记录清单时不可参与发布比较。

逐样本记录内容与评分器摘要，按样本 ID 排序聚合，因此同一批样本的顺序或分批方式不影响发布摘要。缺少逐样本评分器摘要的旧运行需要重跑。通过判定统一为“独立验证通过且基础设施正常”；预算耗尽不否定已经通过独立验证的文件结果。

release-check 从本地结果仓库读取已完成运行并重算统计，拒绝错误归属、缺失/重复样本、矛盾结果以及计量不完整。两个版本必须覆盖相同 regression、validation、holdout 样本；默认 holdout 至少 100 条。因此一个示例用例只能验证接线，不能通过正式发布门禁。

本地结果仓库属于可信评测操作环境，不具备防管理员篡改或远程证明能力。生产 CI 仍须隔离仓库写权限并保存不可变运行产物；Node/依赖摘要也不等价于完整 Docker 镜像证明。
