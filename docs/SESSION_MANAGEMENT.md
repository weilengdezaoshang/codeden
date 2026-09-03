# CodeDen 会话管理设计

## 当前产品模型

普通会话按项目工作目录组织。多个会话共享当前磁盘文件、Git Diff 和未提交修改；聊天记录、模型上下文、权限模式、Plan 模式、Provider、模型、Persona、Active Skill、用量和运行活动按会话隔离。

切换会话时，CodeDen 等待当前写入完成，恢复目标会话的历史和设置，清除来源会话的结果与验证快照，然后继续读取共享工作区的最新内容。普通会话切换不恢复文件快照、不回滚文件，也不清空 Git Diff。需要文件隔离的并行任务应使用独立 Git worktree。

## 当前持久化格式

当前版本使用：

```text
.codeden/sessions/<session-id>/
├── summary.json
├── updates.jsonl
├── chat_history.jsonl
└── settings.json
```

`updates.jsonl` 保存完整 UI 轮次和活动；`chat_history.jsonl` 保存模型上下文快照和压缩摘要；`settings.json` 保存会话设置；`summary.json` 保存列表元数据与累计用量。旧的单 JSON 文件不读取、不迁移，也不会自动删除。

JSONL 使用连续 sequence，最后一行不完整时忽略，中间损坏或 sequence 异常时拒绝恢复。元数据使用临时文件和原子 rename，删除先移动到 `.trash`。所有文件权限为 `0600`，写入前统一进行 Secret 脱敏。设置损坏时使用 `ask` 和非 Plan 的安全默认值。

## 命令语义

- `/new`：保存并关闭当前会话，创建空会话；保留共享工作区。
- `/resume <id>`：保存当前会话并恢复目标会话；保留共享工作区。
- `/clear`：清空当前聊天和模型上下文，保留 Session ID 与会话设置。
- `/delete`：确认后将当前会话目录移入回收目录并创建新的空会话；不修改项目文件。
- `/permission ask|auto`：设置当前会话的工具审批模式。

终端提交期间不会接收另一条命令，因此运行中的会话不能同时切换或删除。取消只作用于当前会话正在执行的任务。

通过 `--reasoning-effort low|medium|high` 设置会话推理等级。OpenAI 映射为 `reasoning_effort`，Anthropic 映射为启用 thinking 及对应预算；设置值和实际请求保持一致。

## 非目标范围

不实现旧 JSON 迁移、同 Session 多进程强一致写入、Checkpoint、Replay、工作区快照、Rewind、三层 Session Memory 或子 Agent 状态恢复。同 Session 被多个终端同时恢复时属于 best-effort，推荐 fork 或独立 worktree。
