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

推荐用法：在项目里放 `.codeden/config.yaml`（只写环境变量名，不写 Key），然后：

```bash
export DEEPSEEK_API_KEY='sk-你的DeepSeek密钥'
pnpm codeden "读取 package.json 并告诉我项目名"
```

`pnpm codeden config validate` 只检查配置和 Key 是否存在，不会打印 Key。  
`pnpm codeden config show` 只显示 `from: env` 引用。

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

`pnpm agent` 仍是较低层入口，模型停止即 `submitted`，不跑 CompletionVerifier。

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
src/
├── core/                 # 错误、事件、TaskSpec、状态机（不依赖 Adapter）
├── runtime/              # Agent Loop、模型、工具、WorkspacePolicy
│   ├── agent/
│   ├── models/           # MockModelProvider、OpenAIModelProvider
│   ├── tools/builtins/   # read_file / write_file / edit_file / run_command
│   └── workspace/
├── eval/                 # 评测编排，只通过 Port 调用 Agent
│   ├── domain/           # EvalCase、TrialResult、Submission
│   ├── ports/            # Agent / Benchmark / Workspace / Repository
│   ├── application/      # TrialRunner、EvalRunner
│   ├── adapters/
│   ├── graders/          # json-field、changed-paths
│   └── reporters/
└── cli/                  # agent / eval 入口

evals/
├── cases/regression/     # Native YAML 评测案例
└── fixtures/             # 案例用的初始仓库快照

tests/
├── unit/
├── contract/
├── integration/          # 真实 API 冒烟，默认跳过
└── e2e/
```

评测集在 `evals/`，运行时代码在 `src/`。Fixture 原件不会被评测改写。

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
| `--model` | `mock`、`deepseek`、`openai` 或 `grok` | `mock` |
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
pnpm build          # 编译到 dist/
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

## 阶段 1 范围

已交付：真实 Agent Loop、文件工具、Workspace 隔离、Native YAML Case、JSON / 改动路径 Grader、Mock 与最小 OpenAI Provider。

明确不做：MCP、多 Agent、LLM Judge、失败分析、Champion/Challenger、Web UI、持久化数据库。
