# CodeDen 会话管理设计

## 当前产品模型

普通会话按项目工作目录组织。多个会话共享当前磁盘文件、Git Diff 和未提交修改；聊天记录、模型上下文、权限模式、Plan 模式、Provider、模型、Persona、Active Skill、用量和运行活动按会话隔离。

切换会话时，CodeDen 等待当前写入完成，恢复目标会话的历史和设置，清除来源会话的结果与验证快照，然后继续读取共享工作区的最新内容。普通会话切换不恢复文件快照、不回滚文件，也不清空 Git Diff。需要文件隔离的并行任务应使用独立 Git worktree。

## 当前持久化格式

当前版本继续使用：

```text
.codeden/sessions/<session-id>.json
```

快照保存完整模型消息、可恢复的 UI 轮次与活动、压缩摘要、累计轮次与 Token/成本统计、稳定标题和预览、下一轮序号、Plan 模式、权限模式、Provider、模型、Persona 和 Active Skill。旧快照缺少新增字段时从仍保留的轮次兼容推导。

保存使用串行写入、临时文件和原子 rename，文件权限为 `0600`，写入前统一进行 Secret 脱敏。切换和退出前必须 flush。保存失败不删除内存历史，终端会提示退出后可能丢失；后续保存成功时提示恢复。

## 命令语义

- `/new`：保存并关闭当前会话，创建空会话；保留共享工作区。
- `/resume <id>`：保存当前会话并恢复目标会话；保留共享工作区。
- `/clear`：清空当前聊天和模型上下文，保留 Session ID 与会话设置。
- `/delete`：确认后删除当前会话 JSON，创建新的空会话；不修改项目文件。
- `/permission ask|auto`：设置当前会话的工具审批模式。

终端提交期间不会接收另一条命令，因此运行中的会话不能同时切换或删除。取消只作用于当前会话正在执行的任务。

## 后续范围

后续独立提交再引入 `summary.json`、`updates.jsonl`、`chat_history.jsonl`、`settings.json` 四文件结构，以及 sequence 校验、损坏尾行恢复、单写者锁、旧 JSON 读时迁移和目录级回收删除。本次不实现 Checkpoint、Replay、工作区快照、Rewind、三层 Session Memory 或子 Agent 状态恢复。
