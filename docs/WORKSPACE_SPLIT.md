# Agent 与评测平台拆分

## 实施状态

1. 已完成：执行契约归还 Runtime，指标、提交结果和工作区契约下沉到 Core；消除 Runtime 与 Trace 采集对 Eval 的反向引用。
2. 已完成：迁移为 4 个公共包与 2 个独立应用，增加各自依赖声明、导出、TypeScript 构建和独立部署检查。
3. 待实现：评测 Web、API、持久任务、Worker、进度与结果图表、样本及 Trace 详情。页面技术栈待确认。
4. 待实现：授权线上 Trace 接收、后台评分、人工复审与审计。当前只有本地采集和授权入队，不会自动上传。

本次不改变用户配置、环境变量引用、默认会话恢复、人格、Memory、MCP、Skill、流式输出和工作区写回行为。不迁移用户的 `.codeden/` 数据，也不启用真实模型评测或外部服务。

## 依赖与职责

| 单元 | 职责 | 内部依赖 |
| --- | --- | --- |
| `@codeden/core` | 错误、事件、TaskSpec、配置、密钥安全、公共执行指标 | 无 |
| `@codeden/agent-runtime` | Loop、模型、工具、会话、隔离工作区、任务完成校验 | core |
| `@codeden/telemetry` | 本地 Trace、采集授权、脱敏、Outbox | core |
| `@codeden/agent` | 终端交互与 Agent 装配 | core、agent-runtime、telemetry |
| `@codeden/eval-engine` | 离线编排、Grader、失败诊断、候选和发布门禁 | core、agent-runtime |
| `@codeden/eval-platform` | 评测产品的入口和后续 Web/API/Worker 装配 | core、agent-runtime、telemetry、eval-engine |

任务执行时的完成检查、回归测试和写回冲突门禁仍属于 Runtime。它们不是离线评分，不能随着评测引擎一起从 Agent 删除。

公共包不能导入应用；Core 和 Telemetry 不能依赖 Runtime；任何跨包调用必须使用已声明的包名，禁止用相对路径绕过边界。单元测试检查这些限制。当前子路径导出保留模块粒度，不要求所有调用都经一个巨大 index 文件。

评测引擎目前通过 Runtime 执行契约调用实际执行循环，而不是复制 Loop。将来比较历史 Agent 版本时，Worker 必须启动指定构建产物；目前导入的 Runtime 只代表当前这一版，不声称支持任意历史版本回放。

## 日常使用

```bash
pnpm install
pnpm codeden                         # 默认持续对话，恢复上次记录
pnpm agent --prompt "读取项目" --model mock
pnpm eval --case evals/cases/regression/update-package-version.yaml
```

仓库命令使用源码条件 `codeden-source`，无需预先构建。测试显式映射到源码，避免读取旧 dist；构建不使用测试别名，使用包导出和 TypeScript 项目引用，能发现遗漏的依赖。

## 独立构建与分发

```bash
pnpm build:agent                      # 只构建 Agent 及其 3 个依赖包，不构建 Eval
pnpm build                           # 构建全部应用、旧入口和评测构建指纹
pnpm --filter @codeden/eval-platform build # 单独构建评测应用及其指纹
pnpm --filter @codeden/eval-engine build   # 单独构建引擎时也刷新指纹
pnpm exec codeden --help
pnpm exec codeden-eval --case evals/cases/regression/update-package-version.yaml
node dist/cli/codeden.js --help        # 旧构建入口仍可使用
pnpm test:packaging                   # 临时副本中独立部署、启动和跑 mock 评测
```

各应用的 `bin/` 是稳定 Node 启动器，实际实现位于各自 `dist/`。部署前先构建。当前包是仓库内私有 workspace 包，尚未发布到 npm；这里的独立部署不是公开发布。

所有 `build` 入口统一执行 `scripts/build.mjs`。显式构建使用 `tsc -b --force`，即使 `.cache` 仍在、`dist` 或单个输出文件已删除，也会重新生成所选项目及其依赖的产物。代价是显式构建不再跳过未变更项目；`build:agent` 仍不构建评测模块。

独立部署必须使用 pnpm 的 workspace 依赖注入，不能保留开发软链接。`test:packaging` 会复制构建产物和清单到临时副本，以 `inject-workspace-packages=true` 安装生产依赖，再分别 deploy 两个应用，并断言包路径全部落在部署目录内。检查结束自动清理临时副本。这样不会改变开发目录的依赖模式，也不会把“还依赖源仓库的软链接目录”误认为独立分发物。脚本目前只作验证，不保留分发目录。

单独安装 Agent 时，不会携带 Eval 依赖。`codeden eval` 会转交 PATH 中的独立 `codeden-eval`，未安装时返回退出码 2 和明确提示。仓库内 `pnpm codeden eval ...` 与旧 `dist/cli/codeden.js eval ...` 通过兼容入口按需加载评测应用。

独立程序转发会传递 SIGINT、SIGTERM、SIGHUP。首次取消给予 1 秒宽限，再次取消或超时则强制清理评测进程组；即使评测进程先退出，也清理同组残留后代。转发结束会移除信号监听和定时器，并保留首次取消对应的退出码（130、143、129）。不能捕获 SIGKILL；该机制也不承诺回收主动脱离进程组的后台进程。进程级信号测试在 POSIX 上运行，Windows 行为尚未验证。

## 证据兼容与迁移边界

- 现有 Trace、TrialResult、EvalRun 和会话的 schemaVersion 保持不变。
- 构建指纹绑定实际加载的 Runtime/Core 目录、Grader 代码和锁文件摘要，不依赖旧 `src/` 目录，也不只使用版本号。
- 根构建、单独构建评测应用或引擎都会生成 `packages/eval-engine/dist/build-provenance.json`。构建前先使旧文件失效，编译成功后原子写入当前锁文件指纹；编译或锁文件读取失败时不保留旧凭证。运行时缺少或损坏该文件则发布证据生成失败关闭；普通评测不依赖它。
- 源码和构建产物的指纹可以不同；比较门禁仍检查证据的一致性，不混用两种运行模式的结果。
- 旧源码深路径如 `src/eval/ports/agent.port.ts` 已迁移，不保留整个旧目录的重复实现。仓库外直接导入旧源码的脚本应改用包导出。

## 本阶段验证

- 依赖边界测试先失败（发现 26 处 Runtime/采集反向引用），迁移后通过。
- 全量测试：463 项通过（含本次 15 项构建与进程回归），6 项 Docker/真实模型相关测试跳过；不是已验证这些外部环境。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm build:agent` 和密钥扫描通过。
- 独立部署检查在无源码的临时副本完成：Agent 不携带 Eval，构建版评测在仓库外运行并生成发布证据。
- 追加测试覆盖依赖声明、跨包相对路径、CLI 按需转交、重复入口保护，以及未暂存中文/空格文件的密钥扫描。
- 构建回归测试在不带 dist/缓存的工作区副本中执行实际构建配方，覆盖缓存残留、缺失目录/单文件、独立评测构建、指纹刷新和失败失效；进程测试覆盖正常/信号退出、启动失败、重复取消、超时强杀和监听释放。

## 后续交付边界

离线页面只能提交已登记评测集和明确的模型配置，不能把浏览器传入的任意路径或 Shell 命令直接交给 Worker。任务需有持久状态、取消、进度、崩溃后中断标记；不能因刷新或重启自动重复付费执行。API Key 留在服务端环境变量引用中。

线上接收必须区分 metadata-only 与用户明确授权的内容上传。缺少对话内容的 Trace 不应被伪装成人格评分证据；人工复审结果也不等于隐私审核或离线候选晋级签名。页面和接收服务未完成前，这些流程均不对外开放。
