# CodeDen 阶段 4：Git worktree 隔离

## 1. 目标

`pnpm codeden` 不再直接改用户工作区。Git 仓库里的任务在独立 worktree 中执行；只有 `VERIFIED_COMPLETE` 才把无冲突的改动写回原目录。

```text
配置 + Inspector + TaskSpec
-> 若是 Git 仓库：git worktree add（脱离 HEAD）
-> Baseline + Agent 都在 worktree 里跑
-> 验收通过：把 changedPaths 拷回原目录（跳过当前脏/未跟踪路径）
-> 验收失败或异常：不写回
-> dispose：git worktree remove
```

无 Git 仓库时保持阶段 3 行为：在 `--workspace` 原地执行。

Eval 仍用 fixture 临时目录，本阶段不改评测路径。

## 2. 必须完成

- `GitWorktreeSession.open(originRoot)`：创建隔离 worktree，Agent 的 `workspace.root` 指向其中对应子目录
- 原目录未提交修改不得被覆盖
- `VERIFIED_COMPLETE` 后按 `changedPaths` 写回干净文件；冲突路径列入 `conflicts` 不覆盖
- 敏感路径不写回
- 失败/超时/预算耗尽不写回
- `dispose` 删除 worktree，原 `git worktree list` 不再包含它
- CLI 打印隔离方式、已写回路径、冲突路径
- 验收 A-1…A-6，不依赖真实 API Key

## 3. 明确不做

MCP、Docker、禁网、进程组回收、自动 `pnpm install`、把未提交修改同步进 worktree、改 Eval `resolved`。

## 4. 契约

```ts
open(originRoot) -> {
  originRoot: string
  workspace: WorkspacePort   // worktree 内路径
  isolated: boolean
  applyToOrigin(changedPaths): Promise<{ applied: string[]; conflicts: string[] }>
  dispose(): Promise<void>
}
```

- 有 Git：`isolated === true`，从仓库顶层 `git worktree add --detach <tmp> HEAD`
- 用户传的 `--workspace` 若是子目录，Agent 根为 worktree 内同一相对路径；HEAD 里没有该目录时创建空目录，不把未跟踪文件同步进去
- 不把原目录 `node_modules` 链进 worktree，避免写穿
- 无 Git 或 `worktree add` 失败：退回原地 `fromExisting`，`isolated === false`
- 写回时：`git status --porcelain` 中的脏/未跟踪路径为冲突；其余 changedPaths 从 worktree 拷到原目录

## 5. 验收

| 编号 | 必须看到 |
|---|---|
| A-1 | 无 Git 仓库 → 原地执行，行为与阶段 3 相同 |
| A-2 | Git 仓库中用户已改的文件，Agent 跑完后原内容不变 |
| A-3 | `VERIFIED_COMPLETE` 且原文件干净 → 该文件被写回 |
| A-4 | Agent 改了用户正在改的同一文件 → 冲突，不覆盖 |
| A-5 | 验收失败 → 原目录无新改动，worktree 被删除 |
| A-6 | Eval / `fromFixture` 路径不变 |

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```
