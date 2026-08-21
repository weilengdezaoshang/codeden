# CodeDen 阶段 5：冲突 Patch 与超时进程回收

## 1. 目标

隔离验收通过后，冲突文件不再随 worktree 丢失。命令超时必须杀掉整个进程组。

```text
隔离环境验收通过
-> 干净文件写回原目录
-> 冲突文件写入 .codeden/last.patch（不覆盖原文件）
-> 验收失败：不写回、不创建或替换本次 Patch，保留上一轮有效产物
-> 命令超时：杀掉进程组，不留孤儿
```

## 2. 必须完成

- `ApplyResult.patchPath`：有冲突且验收通过时写出 unified diff
- 路径为原工作区 `.codeden/last.patch`
- 敏感路径不进入 patch
- 验收通过且无冲突：清理 latest 指针；验收失败：不得删除上一轮有效 Patch
- `workspace.exec` 与 `run_command` 超时使用进程组 SIGKILL（Windows 用 taskkill /T）
- CLI 打印 `Patch: <path>`
- 验收 A-1…A-5，不依赖真实 API Key

当前实现已经覆盖上述主链路，但在宣布阶段完成前还必须补齐以下安全收口：

- `changedPaths` 在写回前重新做相对路径、绝对路径和符号链接边界校验
- 写回每个文件前重新检查原文件，避免用户在 Agent 运行期间新增修改后被覆盖
- Git 仓库创建 worktree 失败时默认 fail closed；只有用户显式允许才能原地执行
- 明确定义新增、修改、删除、重命名、可执行位和二进制文件的处理方式
- `.codeden/last.patch` 写入前执行 Secret Leak Guard、大小限制和原子替换
- 清理失败不得掩盖 Agent 或 Verifier 的原始错误
- 进程超时、取消和自然退出只能结算一次，并验证后代进程确实退出

## 3. 明确不做

MCP、Docker、禁网、CPU/内存限额、Checkpoint/Resume、改 Eval `resolved`。

## 4. 契约

```ts
ApplyResult {
  applied: string[]
  conflicts: string[]
  patchPath?: string
}
```

- 仅 `isolated === true` 且 `VERIFIED_COMPLETE` 时写 patch
- patch 只包含 conflicts 对应的 worktree 相对原文件的 diff
- 超时：`detached` 新进程组，`kill(-pid)`；杀不死再 `child.kill('SIGKILL')`

## 5. 验收

| 编号 | 必须看到 |
|---|---|
| A-1 | 干净文件仍写回工作区 |
| A-2 | 冲突文件不覆盖，`.codeden/last.patch` 含隔离环境改动 |
| A-3 | 验收失败：不写回、不创建或替换本次 last.patch |
| A-4 | 命令超时后主进程与子进程都不在 |
| A-5 | Eval 路径不变 |

上表是最小功能验收。完成当前阶段还必须通过第 9 节的安全与边界验收。

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## 6. 当前实现状态

截至 `2026-08-21`，已经存在：

```text
src/runtime/workspace/git-worktree-session.ts
src/runtime/workspace/conflict-patch.ts
src/runtime/process/kill-process-group.ts
tests/e2e/git-worktree-session.test.ts
tests/e2e/process-timeout.test.ts
```

当前验证结果：

```text
typecheck: passed
tests: 142 passed, 1 skipped
lint: passed
build: passed
```

本轮已完成的 P0 子项：

- Git worktree 创建失败不再静默降级到原地执行。
- 写回路径拒绝绝对路径、`..` 和已知符号链接逃逸。
- 写回前后重新检查 Origin 相对 HEAD 的差异，识别会话期间的用户修改。
- 冲突 Patch 接入 Secret Leak Guard。
- 失败运行不再删除上一轮冲突 Patch。
- 新增 B-1、B-2、B-8 回归测试。
- Mock CLI 已验证配置、Worktree、Agent、Verifier、写回和清理主流程。

这仍不能证明完整写回边界已经安全。阶段状态定义为：

```text
P0_PARTIALLY_HARDENED_PENDING_ACCEPTANCE
```

仍未完成的 P0/P1：

- 更细粒度的 base/current/candidate digest、原子替换和完整 TOCTOU 防护。
- 删除、重命名、mode 和二进制文件语义。
- `last.patch` 的 run-scoped 生命周期与上一轮产物保留。
- timeout/abort/close 临界竞态和跨平台进程树验收。
- 清理错误与 Agent 原始错误的双重报告。

## 7. 写回事务详细设计

写回不能直接理解为“把 worktree 文件复制回去”，而应当是一笔可验证事务：

```text
Agent VERIFIED_COMPLETE
-> 冻结 Submission changedPaths
-> PathBoundaryPolicy 规范化并校验全部路径
-> 为每个路径读取 origin/current、base/HEAD、candidate/worktree
-> 分类 added / modified / deleted / renamed / mode-changed / binary
-> ConflictDetector 在写回瞬间重新检查 origin
-> 生成 ApplyPlan
-> SecretLeakGuard 检查将写入的内容和 Patch
-> 原子应用无冲突项
-> 冲突项生成 last.patch
-> 保存 ApplyReport
-> 清理 worktree
```

### 7.1 路径不变量

每个输入路径必须同时满足：

- 是非空 workspace-relative 路径
- 不是绝对路径
- 规范化后不包含 `..`
- `resolve(originRoot, path)` 仍位于 originRoot 内
- `resolve(worktreeRoot, path)` 仍位于 worktreeRoot 内
- 父目录和目标符号链接解析后不逃出各自根目录
- 不属于 SensitivePathPolicy 或 ignored paths

任何一个路径非法时，不得部分忽略后继续静默写回。应返回结构化拒绝原因并产生安全事件。

### 7.2 冲突判断

只在 Session 开始时读取一次 `git status` 不够，因为用户可能在 Agent 执行期间继续编辑。至少保存并比较：

```text
baseDigest       Agent 开始时原文件状态
currentDigest    准备写回时原文件状态
candidateDigest  worktree 最终状态
```

判断规则：

```text
currentDigest == baseDigest
-> 可以自动写回

currentDigest != baseDigest
-> 用户或其他进程修改过
-> 冲突，不覆盖
```

写回动作前再次读取 `currentDigest`，并使用临时文件加原子 rename，缩小检查与写入之间的竞态窗口。

### 7.3 文件变化语义

| 变化 | 自动写回条件 | 冲突产物 |
|---|---|---|
| 新增文本文件 | 原路径仍不存在 | unified patch |
| 修改文本文件 | origin digest 未变化 | unified patch |
| 删除文件 | origin digest 未变化 | delete patch |
| 重命名 | old/new 两侧均无用户变化 | rename 或 delete+add patch |
| 可执行位变化 | 内容和 mode 均无用户变化 | mode change patch |
| 二进制文件 | 策略明确允许且大小合规 | 默认不放文本 Patch，输出 artifact 引用 |
| 符号链接 | 目标在边界内且策略允许 | 默认拒绝自动写回 |

第一版如果不支持某种变化，必须返回 `unsupported`，不能把删除当成普通冲突、把二进制当 UTF-8 或静默丢掉文件 mode。

### 7.4 ApplyResult

建议把当前契约扩展为：

```ts
interface ApplyResult {
  applied: ApplyItem[]
  conflicts: ApplyIssue[]
  skipped: ApplyIssue[]
  patchPath?: string
  reportPath: string
}

interface ApplyItem {
  path: string
  changeType: 'added' | 'modified' | 'deleted' | 'renamed' | 'mode_changed'
}

interface ApplyIssue {
  path: string
  reason:
    | 'user_modified'
    | 'path_outside_workspace'
    | 'sensitive_path'
    | 'symlink_escape'
    | 'binary_unsupported'
    | 'unsupported_change'
}
```

若本阶段不扩展公开契约，也必须在内部保留同等信息并写入事件，不能只有路径字符串。

## 8. Patch 安全与生命周期

`.codeden/last.patch` 是用户可取回的冲突产物，不是普通日志，但仍可能携带模型误写的 Secret。

生成流程：

```text
构造候选 Patch
-> 限制单文件和总大小
-> SecretRedactor 扫描已知 Secret
-> SecretLeakGuard 扫描高风险模式
-> 命中泄漏：拒绝落盘，记录安全错误
-> 写入同目录临时文件
-> fsync/close
-> 原子 rename 为 last.patch
```

生命周期：

- 新任务开始时不立即删除上一份 Patch
- 新任务成功产生新的 ApplyReport 后再替换旧 Patch
- 验收失败时，只删除“本次运行创建的临时 Patch”，不要误删用户尚未处理的上一份 Patch
- Patch 需要关联 runId、base commit 和 createdAt；元数据放在 ApplyReport，不污染 unified diff
- `.codeden/last.patch` 和 ApplyReport 必须处于 Git ignore 范围

当前代码在失败时直接删除固定 `last.patch`，可能删除上一轮仍有价值的冲突结果。实现时应改成 run-scoped 临时产物和最终指针。

## 9. 补充验收场景

### B-1：路径逃逸

```text
changedPaths 包含 ../outside.txt 或绝对路径
-> 写回被拒绝
-> workspace 外文件不变
-> 记录 path_outside_workspace
```

### B-2：符号链接逃逸

```text
originRoot/link -> workspace 外目录
candidate 修改 link/secret.txt
-> 不跟随链接写回
-> 记录 symlink_escape
```

### B-3：写回期间用户继续编辑

```text
Session 开始时文件干净
Agent 完成前用户修改同一文件
-> currentDigest != baseDigest
-> 不覆盖用户内容
-> 生成冲突产物
```

### B-4：Worktree 创建失败

```text
Git 仓库中 worktree add 失败
-> 默认终止并报告 isolation_setup_failed
-> 不降级到原地写入
```

非 Git 目录可以维持原地模式，但 CLI 必须明确显示 `Isolation: inplace`；后续 Sandbox 阶段再统一隔离。

### B-5：删除文件

```text
Agent 删除干净的 tracked file
-> ApplyPlan changeType=deleted
-> 自动删除或输出明确 unsupported
-> 不得仅因为 source 不存在而产生含糊冲突
```

### B-6：二进制文件

```text
Agent 修改二进制文件
-> 不使用 UTF-8 fallback diff
-> 默认输出 binary_unsupported 或独立 artifact
-> 不产生损坏 Patch
```

### B-7：可执行位

```text
Agent 新增可执行脚本
-> 写回后 mode 可验证
或明确返回 mode change unsupported
```

### B-8：Patch 包含 Secret

```text
候选冲突内容包含哨兵 Secret
-> Leak Guard 拒绝写入 last.patch
-> 控制台、事件、ApplyReport 均不出现明文
```

### B-9：保留上一轮 Patch

```text
上一轮存在未处理 last.patch
-> 新一轮 Agent 验收失败
-> 上一轮 Patch 仍存在且内容不变
```

### B-10：超时与取消竞态

```text
命令在 timeout 和 close 临界点退出
-> Promise 只结算一次
-> 无未处理 rejection
-> 父子进程均退出
```

### B-11：清理失败

```text
Agent 原始结果为 verifier failure
且 worktree remove 失败
-> 最终报告同时保留 primary error 与 cleanup warning
-> 不把任务显示为成功
```

### B-12：Eval 不受写回影响

```text
运行 Native Eval Fixture
-> 不创建原仓库 worktree 写回事务
-> resolved 和 artifacts 与阶段 3 基线一致
```

## 10. 实施工作包

### P0：写回安全

- 增加 PathBoundaryPolicy 校验
- 增加 base/current/candidate digest
- Git 仓库隔离失败改为 fail closed
- 增加路径逃逸、符号链接和并发编辑测试

### P0：Patch 防泄漏

- 接入 SecretRedactor 与 SecretLeakGuard
- 增加 Patch 大小限制和原子写入
- 改为 run-scoped Patch 生命周期
- 增加哨兵 Secret E2E

### P1：完整文件语义

- 明确新增、删除、重命名、mode 和二进制策略
- 扩展 ApplyReport
- 增加对应 Contract/E2E 测试

### P1：进程生命周期

- timeout、abort、close 共用单一结算器
- POSIX 进程组和 Windows process tree 分别测试
- 保存 termination reason 和 cleanup result

### P2：可观测性

- 事件记录 apply planned/applied/conflicted/skipped
- CLI 输出结构化原因，不只打印路径
- ApplyReport 关联 runId、commit 和 artifact

## 11. 阶段完成定义

阶段 5 只有在以下条件全部成立时才完成：

- A-1 至 A-5 和 B-1 至 B-12 全部通过
- Git 仓库隔离失败不会静默原地执行
- 任意 `changedPaths` 都无法写出 originRoot
- 用户在 Agent 运行期间的修改不会被覆盖
- 删除、二进制、mode 和符号链接都有明确且经过测试的行为
- Patch、事件、报告和控制台的哨兵 Secret 泄漏数为 0
- 超时或取消后没有存活的后代进程
- 原始错误不会被清理错误覆盖
- Eval 回归基线保持不变
- `pnpm typecheck && pnpm test && pnpm lint && pnpm build` 全部通过

阶段完成后，下一阶段进入自研 MCP Client；Docker/禁网/CPU 与内存限制仍留给后续 Sandbox 阶段。
