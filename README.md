# CodeDen

CodeDen 是一个可评测的编码 Agent 运行时。日常命令走独立完成验证：

```text
pnpm codeden "<任务>"
  -> 读取 .codeden/config.yaml
  -> 检查仓库事实（ProjectInspector）
  -> 生成 TaskSpec
  -> Agent 循环改文件
  -> 模型提出完成
  -> CompletionVerifier（改动路径 + 可选命令）
  -> 通过则 VERIFIED_COMPLETE，退出码 0
```

模型说「已完成」不等于成功。Eval 的 `resolved` 仍只由 Native Grader 计算。

## 环境

| 项 | 版本 |
|---|---|
| Node.js | 24 |
| 包管理器 | pnpm 11 |
| 语言 | TypeScript ESM |

```bash
node -v    # v24.x
pnpm -v
pnpm install
```

若 `pnpm install` 提示 esbuild 构建脚本被拦截：

```bash
pnpm approve-builds
```

允许 `esbuild` 后再执行一次 `pnpm install`。

## 第一次运行 Agent

推荐用法：将个人默认配置放在 `~/.codeden/config.yaml`，项目协作配置放在项目的 `.codeden/config.yaml`。两者都只写环境变量名，不写 Key；项目配置优先覆盖用户配置，然后再由命令行参数覆盖：

```yaml
# ~/.codeden/config.yaml 或项目/.codeden/config.yaml
schemaVersion: 1
agent:
  defaultProvider: deepseek
providers:
  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey:
      from: env
      name: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
    capabilities:
      tools: true
mcp:
  servers:
    # MCP 服务通过 stdio 启动；环境变量只引用名称，不把密钥写入配置
    filesystem:
      command: npx
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
      env:
        API_TOKEN:
          from: env
          name: MCP_API_TOKEN
```

其中 `name` 是环境变量名，CodeDen 运行时才从进程环境读取对应密钥：

```bash
export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
pnpm codeden "读取 package.json 并告诉我项目名"
```

`pnpm codeden config validate` 只检查配置和 Key 是否存在，不会打印 Key。  
`pnpm codeden config show` 只显示 `from: env` 引用。

Anthropic Messages API 使用独立 Provider 配置：

```yaml
providers:
  claude:
    type: anthropic
    apiKey: { from: env, name: ANTHROPIC_API_KEY }
    defaultModel: claude-sonnet-4-20250514
    capabilities: { tools: true }
```

交互式 `pnpm codeden` 已支持项目记忆、Skill、MCP stdio/SSE 和真实模型增量流式输出。使用 `/memory add <内容>`、`/memory list`、`/memory clear` 管理记忆，使用 `/skills` 和 `/skill <name>` 管理技能，使用 `/diff` 查看修改、`/apply` 安全写回、`/discard` 丢弃隔离工作区修改。重新执行 `pnpm codeden` 会自动加载上次的聊天记录，不需要额外的恢复参数。

普通会话共享当前项目文件和 Git Diff，但聊天、模型上下文、权限模式、Plan 模式、模型、Persona、Active Skill 和用量统计互相隔离。使用 `/sessions` 查看历史、`/resume <id>` 切换、`/new` 新建、`/clear` 清空当前历史、`/delete` 删除当前会话，使用 `/permission ask|auto` 调整当前会话的工具审批模式。切换或删除会话不会回滚项目文件。详细语义见 [会话管理设计](docs/SESSION_MANAGEMENT.md)。

记忆和技能内容都会以“不可信上下文”注入提示词，不能覆盖任务、安全策略或工具权限。Skill 的 `allowed-tools` 只会收窄工具集合，MCP 服务默认视为过程型工具，在 `/plan` 模式下不可用。

Session 默认保存到项目 `.codeden/sessions/default.json`。日常使用直接执行 `pnpm codeden` 即可继续上次对话；需要切换到其他会话时才指定 `--session`：

```bash
pnpm codeden --session work --workspace /path/to/project --model anthropic
```

`--resume <id>` 仅作为旧脚本的兼容别名保留，不是日常使用入口。

模型可调用 `subagent` 工具委派短小子任务。子 Agent 固定只读、最多 3 轮/6 次工具调用，并限制并发数量、禁止再次创建子 Agent；子任务会继承父任务的允许路径范围。

也可以继续用显式命令：`pnpm agent --prompt "..."`。默认 mock **不会**读你的 API Key。要用 DeepSeek / Grok / OpenAI，必须写 `--model` 和对应环境变量。

### 1. 配 Key，并指定模型

| 你要用的服务 | `--model` | 环境变量 | 去哪里拿 Key |
|---|---|---|---|
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) |
| Grok / xAI | `grok` | `XAI_API_KEY` | [xAI Console](https://console.x.ai/)（Grok 网页会员不等于 API Key） |
| OpenAI | `openai` | `OPENAI_API_KEY` | [OpenAI API Keys](https://platform.openai.com/api-keys) |
| 不调真实模型 | `mock` | 不需要 | — |

DeepSeek 示例（在**当前终端**执行）：

```bash
export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
echo $DEEPSEEK_API_KEY
```

关掉终端后这次 `export` 会失效，下次要再执行一次。不要把 Key 写进代码或提交 Git。

Grok 网页会员（grok.com）不能直接当 API 用。要用 Grok 跑 Agent，需要到 [console.x.ai](https://console.x.ai/) 创建 `XAI_API_KEY`，再 `--model grok`。

### 2. 准备一个工作目录

Agent 会改 `--workspace` 里的真实文件。先复制一份练习目录，避免动到本仓库：

```bash
cd /Users/weilengdezaoshang/Documents/项目/codeden
mkdir -p /tmp/codeden-ws
cp evals/fixtures/basic-node-project/package.json /tmp/codeden-ws/
```

### 3. 告诉 Agent 要做什么，然后执行

`--prompt` 后面的那句话，就是你给 Agent 的任务。

```bash
pnpm agent \
  --model deepseek \
  --workspace /tmp/codeden-ws \
  --prompt "你是什么模型"
```

要改文件时，在 **codeden 仓库目录**执行（配置在当前项目，文件改在 `--workspace`）：

```bash
export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
pnpm codeden --workspace /tmp/codeden-ws "将 package.json 的 version 改为 2.0.0，不要改其他文件"
```

`pnpm codeden` 只有独立验收通过才打印 `VERIFIED_COMPLETE` 并以退出码 0 结束。模型交卷但没改对文件时会继续修，直到预算耗尽，退出码为 1。

无 API Key 时可先用 Mock 验证完整 CLI 主流程（配置加载、Worktree、Agent、Verifier、写回和清理）：

```bash
pnpm codeden --workspace . --model mock "读取 package.json 并告诉我项目名"
```

成功标准：输出 `Isolation: worktree`、`VERIFIED_COMPLETE` 和退出码 `0`；Mock 模式不会读取或要求任何真实模型 Key。

`pnpm agent` 仍是较低层入口：同样执行完成验证，验证不通过会继续修复；与 `pnpm codeden` 的区别是不隔离 worktree、不自动写回。

再看文件是否改对：

```bash
cat /tmp/codeden-ws/package.json
```

只验证 CLI 能跑通、不调 API：

```bash
pnpm agent --prompt "你是什么模型" --model mock
```

## 目录结构

```text
apps/
├── agent/                # codeden 终端、交互与应用装配
└── eval-platform/        # 独立评测应用；目前包含 CLI，Web/API/Worker 待实现

packages/
├── core/                 # 公共契约、配置、安全基础能力
├── agent-runtime/        # Agent Loop、模型、工具、会话、工作区和完成校验
├── telemetry/            # Trace 本地采集、脱敏、授权入队；不执行评分
└── eval-engine/          # 评测编排、Grader、诊断、候选和发布门禁

src/cli/                  # 兼容旧命令和 dist/cli 路径的薄入口

evals/
├── cases/regression/     # Native YAML 评测案例
└── fixtures/             # 案例用的初始仓库快照

tests/
├── unit/
├── contract/
├── integration/          # 真实 API 冒烟，默认跳过
└── e2e/
```

评测集在 `evals/`，共享运行时代码在 `packages/agent-runtime/`。Fixture 原件不会被评测改写。
Agent 不依赖评测应用或引擎；评测应用通过运行时契约复用同一套执行循环。
拆分进度、独立构建和部署见 [工作区拆分说明](docs/WORKSPACE_SPLIT.md)。

## 两条命令的区别

| 命令 | 写到哪里 | 会不会打分 |
|---|---|---|
| `pnpm eval` | 临时目录，跑完删除 | 会 |
| `pnpm agent` | `--workspace` 指向的真实目录 | 不会 |

要同时验证「写入」和「是否做对」，用 `pnpm eval`。  
`pnpm agent` 只负责在指定目录里执行任务，不会对刚才的结果再跑 grader。

## 评测：写入 + 打分

```bash
pnpm eval --case evals/cases/regression/update-package-version.yaml
```

默认 `--model mock`。Mock 会按剧本读取 `package.json`，把 `version` 改成 `2.0.0`，再交卷。独立 grader 检查字段值和改动路径。

预期：

```text
Case: update-package-version
Agent: codeden/mock-model
Execution: submitted
Submission: valid
Verification: passed
Resolved: yes
Turns: 3
Tool calls: 2
Duration: 6ms
```

退出码：

- `0`：全部 Case `resolved`
- `1`：有 Case 未通过
- `2`：配置或基础设施无法运行

用真实模型（需要对应 Key）：

```bash
export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
pnpm eval --case evals/cases/regression/update-package-version.yaml --model deepseek
```

评测结束后，`evals/fixtures/basic-node-project/package.json` 的 `version` 仍应是 `1.0.0`。

当前内置案例：`evals/cases/regression/update-package-version.yaml`。任务是把 fixture 里 `package.json` 的版本改为 `2.0.0`，且不得改其他文件。

## Agent：改真实目录

默认 mock **不会写文件**，只返回固定回复。要真正改文件，加上 `--model deepseek`（或 `openai` / `grok`）和对应 Key。

```bash
mkdir -p /tmp/codeden-ws
cp evals/fixtures/basic-node-project/package.json /tmp/codeden-ws/

export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
pnpm agent \
  --prompt "将 package.json 的版本修改为 2.0.0，不要修改其他字段。" \
  --workspace /tmp/codeden-ws \
  --model deepseek \
  --max-turns 8 \
  --max-tool-calls 16
```

参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `--prompt` | 任务描述（必填） | 无 |
| `--model` | Provider 别名：`mock`、`deepseek`、`openai`、`anthropic` 或 `grok`，wire model 取该 Provider 的 `defaultModel` | `mock` |
| `--model-id` | 覆盖实际请求的 API 模型名（如 `deepseek-reasoner`） | 无 |
| `--workspace` | 工作目录 | 当前目录 |
| `--max-turns` | 最大模型轮次 | `8` |
| `--max-tool-calls` | 最大工具调用次数 | `16` |

成功时打印 `Status: submitted` 和 `changedPaths`。再用 `cat /tmp/codeden-ws/package.json` 确认内容。

只验证 CLI 能跑通、不改文件：

```bash
pnpm agent --prompt "读取 package.json 并告诉我项目名" --workspace . --model mock
```

## 开发命令

```bash
pnpm typecheck      # 类型检查
pnpm test           # 单测 / 契约 / E2E（不访问网络）
pnpm test:watch     # 监听模式
pnpm build          # 编译各包到自己的 dist/，并生成旧入口与构建指纹
pnpm lint           # ESLint
pnpm format         # Prettier
```

普通 `pnpm test` 不要求 API Key。手动跑真实 Provider 冒烟：

```bash
OPENAI_API_KEY=sk-... CODEDEN_OPENAI_SMOKE=1 pnpm test tests/integration/openai-smoke.test.ts
```

阶段 1 验收：`pnpm typecheck`、`pnpm test`、`pnpm build` 通过，并且上面的 `pnpm eval` 演示输出 `Resolved: yes`。

## 内置工具

Agent 可通过这些工具操作 Workspace：

| 工具 | 作用 |
|---|---|
| `read_file` | 读文本文件 |
| `write_file` | 写文本文件（默认不创建缺失父目录） |
| `edit_file` | 精确替换一段文本，必须只匹配一次 |
| `run_command` | 在 Workspace 根目录执行命令数组，不走 shell |
| `run_python` | 在 Workspace 内执行 Python 脚本，不走 shell |
| `apply_patch` | 按统一补丁格式批量新增、修改、删除或移动文件 |
| `start_command` | 启动后台命令并返回 taskId |
| `get_command_output` | 查询后台命令状态和增量输出 |
| `kill_command` | 终止后台命令及其进程组 |
| `get_diagnostics` | 运行 TypeScript、ESLint、Pyright 或 Cargo 诊断 |
| `git_status` | 返回结构化 Git 分支和工作区状态 |
| `git_diff` | 返回受限大小的 Git diff |
| `delete_file` | 删除 Workspace 内的普通文件 |
| `move_file` | 移动或重命名 Workspace 内文件和目录 |
| `todo_write` | 写入当前任务的可追踪待办计划 |
| `ask_user` | 向用户发起多选问题 |
| `web_search` | 搜索公开网页并返回不可信结果链接 |
| `web_fetch` | 抓取受限大小的公开 HTTPS 文本 |
| `repo_map` | 生成源文件和顶层符号地图 |
| `find_symbol` | 查找源代码中的符号定义 |
| `find_references` | 查找符号的文本引用 |
| `read_many_files` | 一次读取多个 Workspace 文件 |
| `search_docs` | 根据技术问题搜索配置来源中的官方文档候选，不发送代码或敏感查询 |
| `fetch_url` | 读取搜索结果中的 HTTPS 官方文档，返回内容标记为不可信输入 |

写入受 `WorkspacePolicy` 约束：不能逃出工作区，评测时只能写 Case 声明的 `allowedPaths`。

日常 `pnpm codeden` 默认允许 `fetch_url` 访问一组常用官方文档域名。可在配置中关闭或替换白名单：

```yaml
network:
  docs:
    enabled: true
    allowedDomains:
      - nodejs.org
      - www.typescriptlang.org
  commands:
    mode: docker
    image: node:24-bookworm-slim
    readOnly: false
    # Colima 等环境可二选一配置 daemon
    dockerContext: colima
    # dockerHost: unix:///var/run/docker.sock
```

`fetch_url` 只接受 HTTPS，拒绝自定义端口、URL 凭据、IP 地址、未授权域名、内网 DNS 结果、跨白名单重定向、非文本响应和超大响应。它不会把模型 API Key 发送给文档站点。文档内容始终作为不可信参考资料处理。

当任务涉及当前版本、兼容性、弃用状态或明确要求官方资料时，Agent 必须先成功调用 `search_docs`，再从搜索结果中选择 URL 调用 `fetch_url`。研究结果与抓取 URL 绑定，只有读取了搜索结果中的页面才算完成研究；最终回复需要列出使用的来源 URL。搜索请求会经过脱敏和代码载荷检查，并限制响应大小和超时。

`run_command` 的 `commands.mode` 支持 `host` 和 `docker`。`docker` 模式使用固定镜像、非 root 用户、`network=none`、丢弃全部 Linux capabilities、禁止提权、限制最多 256 个进程，并隔离 `/tmp` 执行命令；`host` 模式仅用于兼容已有本机工作流，不提供进程级网络隔离。`dockerContext` 与 `dockerHost` 只能二选一；`dockerHost` 必须使用 `unix://`、`tcp://` 或 `ssh://` 地址。依赖安装的 allowlist 网络模式尚未开放。

Docker 集成测试默认跳过。确认 Docker daemon 和测试镜像可用后，可显式运行：

```bash
CODEDEN_DOCKER_TESTS=1 pnpm test tests/e2e/docker-command-sandbox.test.ts
```

## 提交规范

提交信息格式见 [AGENTS.md](./AGENTS.md)：

```text
type(模块): 中文描述.
```

`pre-commit` 会对暂存文件跑 Prettier 和 ESLint；`commit-msg` 会校验提交信息。

## SWE-PolyBench 与 Terminal-Bench

评测平台目录已接入 `swe-polybench` 和 `terminal-bench`。平台不会在启动时自动下载第三方数据；先准备数据，再通过环境变量指向本地数据：

```bash
CODEDEN_SWE_POLYBENCH_DATASET=/path/to/swe-polybench.jsonl \
CODEDEN_TERMINAL_BENCH_DATASET=/path/to/terminal-bench \
CODEDEN_EVAL_SANDBOX_MODE=docker \
pnpm run:eval
```

SWE-PolyBench 使用 JSON/JSONL 实例记录，读取 `instance_id`、`repo`、`base_commit`、`problem_statement`、`test_patch`、`language` 和 `test_command`；Docker 模式默认使用实例镜像 `ghcr.io/timesler/swe-polybench.eval.x86_64.<instance_id>:v<version>`。可通过 `CODEDEN_SWE_POLYBENCH_VERSION` 和 `CODEDEN_SWE_POLYBENCH_IMAGE` 覆盖版本或统一镜像。

SWE-bench Verified 与 Lite 共用同一适配器，数据默认读取 `.codex/datasets/swebench-verified.jsonl`（可用 `CODEDEN_SWEBENCH_VERIFIED_DATASET` 覆盖），官方 Harness 数据集随之切换为 `princeton-nlp/SWE-bench_Verified`。

HumanEval 使用官方 `HumanEval.jsonl`（164 题，读取 `task_id`、`prompt`、`entry_point` 和 `test`），默认读取 `.codex/datasets/humaneval.jsonl`（可用 `CODEDEN_HUMANEVAL_DATASET` 覆盖）。创建评测时平台把选题的 stub 文件物化到 `.codex/datasets/humaneval-fixtures/`，Agent 在 Python 沙箱镜像（默认 `python:3.11-slim`，可用 `CODEDEN_HUMANEVAL_IMAGE` 覆盖）内补全函数，隐藏测试仅在隔离判卷工作区执行，Agent 全程不可见。

Terminal-Bench 使用任务目录：每个任务至少包含 `instruction.md`、`environment/Dockerfile` 和 `tests/test.sh`（也兼容根目录 `run-tests.sh`）。Agent 工作区只挂载环境镜像，不暴露 `solution/` 与 `tests/`；验证工作区再挂入 tests 并执行 verifier。可通过 `CODEDEN_TERMINAL_BENCH_VERSION`、`CODEDEN_TERMINAL_BENCH_IMAGE` 和 `CODEDEN_TERMINAL_BENCH_NETWORK` 配置版本、统一镜像和网络策略。

数据集目录和版本信息会写入不可变 Job/BenchmarkRun 快照，评测结果继续沿用现有 `TrialResult`、`verification.stage`、grader evidence 和 diff 链路，因此 SWE-bench Verified、SWE-PolyBench、Terminal-Bench、HumanEval 可与内置评测集并行运行。格式依据 [SWE-PolyBench README](https://github.com/amazon-science/SWE-PolyBench/blob/main/README.md) 和 [Terminal-Bench 2 README](https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/main/README.md)。

## 当前交付范围

已交付：真实 Agent Loop、持续交互会话、文件工具、Workspace 隔离、Native YAML Case、外部 Benchmark Adapter 与数据集缓存、SWE-bench Lite 接入、JSON / 改动路径 Grader、失败归因、Mock、OpenAI 兼容 Provider、Anthropic Provider、MCP stdio/SSE 工具、受限只读子 Agent、Skill / Memory、会话持久化、`codeden init` 与 `codeden doctor`、后台命令任务、模型请求重试与整轮时限（`agent.turnTimeoutMs`）。

当前仍未交付：完整多 Agent 编排（跨任务协作与结果合并）、LLM Judge、Champion/Challenger、线上交互评测、结构化 Session Folding 摘要压缩、Skills Runtime 使用观测与演化、长期记忆自动提取、Checkpoint/Replay、评测平台重复评测 P0（见 `docs/REPEAT_EXPERIMENTS_DEVELOPMENT.md`）。
