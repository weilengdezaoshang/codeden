# CodeDen Model 适配层与配置系统开发文档

## 1. 文档目标

本文定义 CodeDen 下一阶段的开发任务：完善 Agent Model 适配层，并通过配置文件完成 Provider、模型、API 地址、密钥引用、超时和重试策略配置。

本阶段最终链路：

```text
CLI 启动
-> 定位配置文件
-> 读取 YAML
-> Zod 校验
-> 合并默认配置、用户配置、项目配置和 CLI 选择
-> 安全解析 API Key
-> ProviderRegistry 选择适配器
-> 创建 ModelProvider
-> AgentRunner 发起统一 ModelRequest
-> Adapter 转换供应商请求和响应
-> 统一错误、Usage、Tool Call 和 Stop Reason
-> Agent Loop 继续运行
```

核心目标：

- Agent Core 不感知 OpenAI、DeepSeek、Grok 等供应商 SDK 类型。
- Provider 不再通过硬编码 `switch` 读取固定环境变量。
- 用户可以通过 YAML 配置 Provider 和默认模型。
- 密钥可以由配置文件声明，但默认使用安全的环境变量引用，不把明文密钥提交到仓库。
- OpenAI-compatible 服务复用一个 Adapter，通过配置区分供应商。
- 配置、密钥和模型错误必须可诊断且不得泄露敏感信息。
- 普通测试不访问网络、不要求真实 API Key。

---

## 2. 当前实现与主要缺口

当前已有：

- `ModelProvider.complete()` 统一接口。
- `ModelRequest`、`ModelResponse`、`ModelToolCall` 和 `ModelUsage`。
- `MockModelProvider`。
- `OpenAIModelProvider`。
- OpenAI-compatible DeepSeek、Grok 配置。
- Tool Call 参数 JSON 解析。
- Stop Reason 与错误基础映射。
- Provider Contract Test 和 OpenAI Smoke Test。

当前缺口：

1. `create-model-provider.ts` 使用硬编码 `switch`。
2. Provider 配置直接读取 `process.env`。
3. 没有 YAML 配置 Schema、加载器、合并器和诊断命令。
4. API Key 与普通配置没有安全边界。
5. 没有 Provider 注册机制。
6. 没有统一超时和重试执行层。
7. Provider 错误缺少统一错误上下文，例如 provider、model、attempt。
8. 没有模型能力声明，无法判断是否支持工具调用。
9. 默认模型和 CLI 模型选择仍依赖别名硬编码。
10. 配置错误可能在真正请求时才暴露，缺少启动期验证。

本阶段是在现有代码上增量重构，不重写 Agent Loop 和 Tool Runtime。

---

## 3. 实现范围

### 3.1 必须实现

- `CodeDenConfig` Zod Schema。
- YAML 配置加载。
- 用户级配置和项目级配置。
- 显式 `--config`。
- 配置优先级与深度合并。
- Secret Reference Schema。
- 环境变量密钥解析。
- 受限制的本地明文密钥配置。
- 敏感字段脱敏。
- `ProviderRegistry`。
- 配置驱动的 `ModelProviderFactory`。
- OpenAI-compatible Adapter 配置化。
- Provider 能力声明。
- 统一请求超时。
- 可重试错误的指数退避。
- CLI 的 `--provider`、`--model`、`--config`。
- `config validate` 或等价配置诊断流程。
- 单元、契约、集成和冒烟测试。
- README 配置示例。

### 3.2 暂不实现

- Anthropic 原生 Adapter。
- 流式输出协议重构。
- 动态插件安装。
- OAuth。
- 系统 Keychain/Vault。
- Web 配置页面。
- Provider 自动故障转移。
- 多模型路由和负载均衡。
- 根据评测结果自动切换模型。
- 模型价格在线同步。

接口设计应允许以后增加这些能力，但不得在本阶段提前实现。

---

## 4. 安全原则

### 4.1 项目配置不得保存明文密钥

项目配置文件 `.codeden/config.yaml` 可以提交 Git，因此只允许引用环境变量：

```yaml
providers:
  openai:
    type: openai-compatible
    apiKey:
      from: env
      name: OPENAI_API_KEY
```

禁止：

```yaml
providers:
  openai:
    apiKey:
      from: literal
      value: sk-real-secret
```

如果项目配置出现 `from: literal`，加载器必须拒绝，而不是只警告。

### 4.2 本地私有配置可以选择保存明文密钥

为了满足“通过配置文件配置 Key”，允许以下私有配置来源使用 literal：

```text
用户配置：~/.config/codeden/config.yaml
项目私有配置：.codeden/config.local.yaml
显式配置：仅当文件位于用户目录或被明确标记为 trusted-local
```

示例：

```yaml
providers:
  openai:
    apiKey:
      from: literal
      value: sk-local-only
```

但必须满足：

- `.codeden/config.local.yaml` 加入 `.gitignore`。
- POSIX 系统上包含 literal key 的文件权限必须为 `0600`；权限过宽时拒绝启动。
- 日志、异常、事件、配置打印和测试快照不得输出 literal value。
- `config show` 只能显示 `<redacted>`。
- 不提供 `--api-key` CLI 参数，避免进入 Shell history 和进程列表。

推荐方式仍然是环境变量引用。Literal 是本地兼容能力，不是默认示例。

### 4.3 密钥只在最后一刻解析

配置加载阶段保存 `SecretReference`，Provider 实例化时才调用 `SecretResolver` 得到实际值。

禁止把实际 API Key 放入：

- `CodeDenConfig` 的可序列化结果。
- `RunEvent`。
- `ModelRequest` 日志。
- `TrialResult`。
- Eval Artifact。
- 错误 details。

---

## 5. 配置文件设计

### 5.1 配置位置

支持以下来源：

```text
内置默认配置
~/.config/codeden/config.yaml
<workspace>/.codeden/config.yaml
<workspace>/.codeden/config.local.yaml
--config <path>
CLI 非敏感覆盖项
```

跨平台用户配置根目录：

- 若存在 `XDG_CONFIG_HOME`，使用 `$XDG_CONFIG_HOME/codeden/config.yaml`。
- 否则使用系统用户配置目录解析函数。
- 不在业务代码中直接拼接 `~`。

### 5.2 配置优先级

从低到高：

```text
1. 内置默认值
2. 用户配置
3. 项目共享配置
4. 项目私有配置
5. --config 指定配置
6. CLI 非敏感参数
```

环境变量不作为整份配置覆盖层，只由 `SecretResolver` 解析 Secret Reference。这样可以避免大量隐式环境变量使配置不可追踪。

例外：允许 `CODEDEN_CONFIG` 指定配置文件路径，优先级等同 `--config` 但低于显式 `--config`。

### 5.3 示例配置

```yaml
schemaVersion: 1

agent:
  defaultProvider: openai
  defaultModel: gpt-4.1-mini
  maxTurns: 8
  maxToolCalls: 16

modelRuntime:
  timeoutMs: 60000
  retry:
    maxRetries: 3
    initialDelayMs: 500
    maxDelayMs: 8000
    jitter: true

providers:
  openai:
    type: openai-compatible
    baseURL: https://api.openai.com/v1
    apiKey:
      from: env
      name: OPENAI_API_KEY
    defaultModel: gpt-4.1-mini
    capabilities:
      tools: true

  deepseek:
    type: openai-compatible
    baseURL: https://api.deepseek.com
    apiKey:
      from: env
      name: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
    capabilities:
      tools: true

  grok:
    type: openai-compatible
    baseURL: https://api.x.ai/v1
    apiKey:
      from: env
      name: XAI_API_KEY
    defaultModel: grok-4.6
    capabilities:
      tools: true
```

### 5.4 Secret Reference

```ts
const SecretReferenceSchema = z.discriminatedUnion('from', [
  z.object({
    from: z.literal('env'),
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  }),
  z.object({
    from: z.literal('literal'),
    value: z.string().min(1),
  }),
])
```

### 5.5 Provider 配置

```ts
const ProviderCapabilitiesSchema = z.object({
  tools: z.boolean().default(true),
})

const OpenAICompatibleProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  apiKey: SecretReferenceSchema,
  defaultModel: z.string().min(1),
  organization: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  capabilities: ProviderCapabilitiesSchema.default({}),
})
```

自定义 headers 不允许覆盖：

- `authorization`。
- `proxy-authorization`。
- `cookie`。

此类敏感认证必须通过专用 Secret 配置实现。

### 5.6 根配置 Schema

```ts
const CodeDenConfigSchema = z.object({
  schemaVersion: z.literal(1),
  agent: z.object({
    defaultProvider: z.string().min(1),
    defaultModel: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().default(8),
    maxToolCalls: z.number().int().positive().default(16),
  }),
  modelRuntime: z.object({
    timeoutMs: z.number().int().positive().default(60000),
    retry: z.object({
      maxRetries: z.number().int().min(0).max(10).default(3),
      initialDelayMs: z.number().int().positive().default(500),
      maxDelayMs: z.number().int().positive().default(8000),
      jitter: z.boolean().default(true),
    }),
  }),
  providers: z.record(
    z.string().min(1),
    OpenAICompatibleProviderConfigSchema,
  ),
})
```

交叉字段校验：

- `agent.defaultProvider` 必须存在于 `providers`。
- `defaultModel` 最终必须能从 CLI、Agent 配置或 Provider 配置中确定。
- `maxDelayMs >= initialDelayMs`。
- Provider name 必须匹配安全标识符规则。
- Project config 不允许 literal secret。

---

## 6. 推荐目录

```text
src/
├── config/
│   ├── config-schema.ts
│   ├── config-types.ts
│   ├── config-loader.ts
│   ├── config-locator.ts
│   ├── config-merger.ts
│   ├── config-validator.ts
│   ├── config-errors.ts
│   ├── secret-reference.ts
│   ├── secret-resolver.ts
│   ├── secret-redactor.ts
│   └── file-permissions.ts
│
├── runtime/
│   ├── models/
│   │   ├── model-provider.ts
│   │   ├── model-types.ts
│   │   ├── model-capabilities.ts
│   │   ├── provider-registry.ts
│   │   ├── model-provider-factory.ts
│   │   ├── model-invoker.ts
│   │   ├── retry-policy.ts
│   │   ├── mock-model-provider.ts
│   │   └── openai-compatible/
│   │       ├── openai-compatible.adapter.ts
│   │       ├── openai-message-mapper.ts
│   │       ├── openai-response-mapper.ts
│   │       └── openai-error-mapper.ts
│   └── create-codeden-runtime.ts
│
└── cli/
    ├── agent-command.ts
    ├── config-command.ts
    └── dependency-container.ts

tests/
├── unit/config/
├── unit/models/
├── contract/model-provider.contract.test.ts
├── integration/config-provider.test.ts
└── integration/openai-smoke.test.ts

.codeden/
└── config.example.yaml
```

原有 `create-model-provider.ts` 在迁移完成后删除或变为兼容薄封装，不能继续维护硬编码 Provider switch。

---

## 7. 模块职责

### 7.1 ConfigLocator

输入：

- 当前 Workspace。
- `--config`。
- `CODEDEN_CONFIG`。
- 用户配置目录。

输出按优先级排序的 `ConfigSource[]`：

```ts
interface ConfigSource {
  kind: 'defaults' | 'user' | 'project' | 'project-local' | 'explicit'
  path?: string
  trustedForLiteralSecrets: boolean
  required: boolean
}
```

要求：

- 默认不存在的用户/项目配置不报错。
- 显式 `--config` 不存在必须报错。
- 解析后的路径必须规范化。
- 不扫描 Workspace 之外的任意父目录。

### 7.2 ConfigLoader

职责：

```text
读取 ConfigSource
-> YAML parse
-> 捕获语法错误并附带文件路径
-> 校验单来源配置
-> 检查 Secret 来源是否合法
-> 返回不含实际 secret value 的 ConfigFragment
```

YAML 必须限制：

- 文档数量为 1。
- 禁止自定义 Tag。
- 设置合理文件大小上限。
- 错误包含行列信息，但不得包含敏感字段值。

### 7.3 ConfigMerger

合并规则：

- 普通对象按字段深度合并。
- `providers.<name>` 按 Provider 维度合并。
- 数组整体替换，不拼接。
- `null` 不表示删除；阶段 1 不支持删除继承字段。
- CLI 只覆盖 provider、model、maxTurns、maxToolCalls、config path。

合并后必须再次运行完整 `CodeDenConfigSchema` 和交叉字段校验。

### 7.4 SecretResolver

```ts
interface SecretResolver {
  resolve(reference: SecretReference, context: SecretContext): Promise<ResolvedSecret>
}

interface ResolvedSecret {
  expose(): string
  redacted: '<redacted>'
}
```

要求：

- `env` 引用不存在或为空时启动失败。
- literal 仅允许 trusted source。
- 不实现 `toJSON()` 返回明文。
- `util.inspect`、日志序列化和错误输出显示 `<redacted>`。
- Secret 生命周期限制在 Provider 创建过程和 Provider 私有字段中。

### 7.5 ProviderRegistry

```ts
type ProviderFactory<TConfig = unknown> = (context: {
  name: string
  config: TConfig
  secretResolver: SecretResolver
}) => Promise<ModelProvider>

interface ProviderRegistry {
  register(type: string, factory: ProviderFactory): void
  create(name: string, config: ProviderConfig): Promise<ModelProvider>
}
```

要求：

- 重复注册 type 时失败。
- 未知 type 返回结构化配置错误。
- Registry 只按 `type` 选择 Adapter；Provider 名称由用户自由定义。
- OpenAI、DeepSeek、Grok 都使用 `openai-compatible` factory。

### 7.6 ModelProviderFactory

输入：

```ts
interface ModelSelection {
  provider: string
  model?: string
}
```

流程：

```text
选择 provider name
-> 从 CodeDenConfig 读取 ProviderConfig
-> 选择 model：CLI > agent.defaultModel > provider.defaultModel
-> 校验能力
-> Registry 创建 Adapter
-> ModelInvoker 包装 timeout/retry
-> 返回 ResolvedModel
```

输出：

```ts
interface ResolvedModel {
  provider: string
  model: string
  capabilities: ModelCapabilities
  client: ModelProvider
}
```

### 7.7 OpenAICompatibleAdapter

在现有 `OpenAIModelProvider` 基础上重构：

- 构造函数只接收解析后的 Provider 配置，不直接读 `process.env`。
- 供应商请求映射拆到 mapper 文件。
- 供应商响应映射拆到 mapper 文件。
- 错误映射拆到 mapper 文件。
- 保持 Agent 内部 `ModelRequest/ModelResponse` 不变。
- 请求中携带最终 model name。
- API Key 和 baseURL 来自配置系统。

不得在 Adapter 中：

- 读取 YAML。
- 决定配置优先级。
- 修改 Agent 状态。
- 执行 Agent 级重试循环。
- 记录完整 API Key 或认证 Header。

### 7.8 ModelInvoker

统一处理跨 Provider 的运行策略：

```ts
interface ModelInvokerOptions {
  timeoutMs: number
  retry: RetryPolicyConfig
  clock: Clock
  sleeper: Sleeper
  random: RandomSource
  eventSink: EventSink
}
```

流程：

```text
emit model.requested
-> 建立 timeout AbortSignal
-> provider.complete
-> 成功：emit model.completed
-> 失败：标准化错误
-> retryable 且未超次数：计算退避并 emit model.retrying
-> 最终失败：emit model.failed
```

可重试：

- 408。
- 429。
- 500、502、503、504。
- 明确的暂时性连接重置或超时。

不可重试：

- 401、403。
- 404 model not found。
- Tool Call JSON 非法。
- 配置错误。
- 用户主动取消。
- Agent 总预算耗尽。

退避：

```text
delay = min(initialDelayMs * 2^attempt, maxDelayMs)
```

启用 jitter 时，在可测试的注入式随机源上计算。测试不得真实 sleep。

---

## 8. Model 内部协议

### 8.1 保留统一接口

阶段 1 保留非流式接口：

```ts
interface ModelProvider {
  readonly name: string
  readonly capabilities: ModelCapabilities
  complete(request: ModelRequest): Promise<ModelResponse>
}
```

流式接口将在后续单独设计，避免本阶段同时改变 Agent Loop、事件模型和 CLI 渲染。

### 8.2 ModelCapabilities

```ts
const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
})
```

如果 Agent Request 包含 Tool Definition，而 Provider 声明 `tools=false`，必须在请求前失败，不能等待远端 API 报错。

### 8.3 ModelRequest

现有结构保持：

```ts
interface ModelRequest {
  messages: ModelMessage[]
  tools: ToolDefinition[]
  signal?: AbortSignal
}
```

model name 不进入每次请求，由选定的 Provider 实例持有。

### 8.4 ModelResponse

```ts
interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'unknown'
  usage: ModelUsage
}
```

适配要求：

- 无文本返回空字符串，不返回 `null`。
- 无工具调用返回空数组。
- Tool Call arguments 必须是解析后的 JSON 值。
- Tool Call JSON 无效属于不可重试的 `MODEL_RESPONSE_INVALID`。
- 没有 Choice/Message 属于 `MODEL_RESPONSE_INVALID`。
- Usage 缺失时可返回 0，但必须保持结构完整。

---

## 9. CLI 与启动流程

### 9.1 Agent 命令

参考 BearCode，日常调用必须以“零配置参数”为主。模型、Provider、Key、API 地址和默认限制从配置文件读取，Workspace 默认为当前目录。

最终用户命令应注册为 `codeden`。无参数启动交互模式：

```bash
codeden
```

一次性任务使用位置参数，不要求 `--prompt`：

```bash
codeden "读取 package.json 并告诉我项目名"
```

日常修改任务：

```bash
cd /path/to/project
codeden "修复登录接口的错误状态码"
```

只有临时覆盖默认配置时才使用参数：

```bash
codeden \
  --provider deepseek \
  --model deepseek-chat \
  "读取 package.json"
```

指定其他配置文件属于高级用法：

```bash
codeden \
  --config .codeden/config.local.yaml \
  --provider grok \
  "读取 package.json"
```

CLI 形式：

```text
codeden [options] [prompt...]
```

参数均为可选覆盖项：

```text
--config <path>
--provider <name>
--model <name>
--workspace <path>
--max-turns <number>
--max-tool-calls <number>
```

兼容期可以保留 `--prompt <text>`，但帮助文档、README 和示例必须优先展示位置参数。位置参数与 `--prompt` 同时出现时应报错，不能静默拼接。

默认行为：

```text
不传 prompt       -> 启动交互 REPL
传位置 prompt     -> 一次性执行
不传 workspace    -> 使用 process.cwd()
不传 provider     -> 使用 agent.defaultProvider
不传 model        -> 使用 agent.defaultModel 或 provider.defaultModel
不传限制参数      -> 使用配置文件默认值
```

移除或弃用当前含义模糊的 `--model openai|deepseek|grok` 别名模式。`--provider` 选择配置中的 Provider，`--model` 只选择具体模型名称。高级参数保留用于 CI、评测和临时调试，但不作为正常调用方式。

仓库开发期间可以继续使用 `pnpm agent "任务"`，但发布构建必须通过 `package.json.bin` 注册 `codeden`，最终用户不需要知道内部 pnpm script。

### 9.2 Config 命令

建议新增：

```bash
pnpm codeden config validate
pnpm codeden config show
```

若当前尚未统一 CLI 二进制，可以先提供：

```bash
pnpm tsx src/cli/config-command.ts validate
pnpm tsx src/cli/config-command.ts show
```

`validate` 输出：

```text
✓ user config loaded
✓ project config loaded
✓ provider openai configured
✓ OPENAI_API_KEY is available
✓ selected model gpt-4.1-mini supports tools
```

`show` 输出合并后的脱敏配置：

```yaml
providers:
  openai:
    type: openai-compatible
    apiKey: <redacted>
```

### 9.3 Dependency Container

CLI 只负责装配：

```text
ConfigLocator
-> ConfigLoader
-> ConfigMerger
-> ConfigValidator
-> SecretResolver
-> ProviderRegistry
-> ModelProviderFactory
-> ModelInvoker
-> createCodeDenAgent
```

不要把上述流程继续堆入 `agent-command.ts`。

---

## 10. 事件与日志

新增或规范以下事件：

```text
config.loaded
config.validated
model.provider_created
model.requested
model.retrying
model.completed
model.failed
```

允许记录：

- 配置来源路径。
- Provider name。
- Provider type。
- Model name。
- Request attempt。
- 状态码。
- Token Usage。
- 耗时。
- Retry delay。

禁止记录：

- API Key。
- Authorization Header。
- Literal Secret。
- 完整环境变量集合。
- Provider 客户端内部认证对象。

敏感值脱敏应在事件写入前完成，不能依赖 Reporter 最后处理。

---

## 11. 错误码

新增或复用以下结构化错误：

```text
CONFIG_NOT_FOUND
CONFIG_READ_FAILED
CONFIG_YAML_INVALID
CONFIG_SCHEMA_INVALID
CONFIG_PROVIDER_NOT_FOUND
CONFIG_MODEL_NOT_RESOLVED
CONFIG_LITERAL_SECRET_FORBIDDEN
CONFIG_SECRET_FILE_PERMISSIONS
SECRET_ENV_NOT_FOUND
PROVIDER_TYPE_NOT_REGISTERED
MODEL_CAPABILITY_UNSUPPORTED
MODEL_REQUEST_FAILED
MODEL_RESPONSE_INVALID
MODEL_AUTHENTICATION_FAILED
MODEL_RATE_LIMITED
MODEL_TIMEOUT
```

错误信息要求：

- 配置错误包含来源文件和字段路径。
- Provider 错误包含 provider 和 model。
- 网络错误可包含状态码。
- 认证错误不得包含 Key。
- 原始供应商响应只有经过脱敏后才能进入 details。

---

## 12. 实现顺序

### Step 1：冻结配置 Schema 和安全规则

实现：

- `SecretReferenceSchema`。
- Provider Config Schema。
- `CodeDenConfigSchema`。
- 配置来源可信度规则。
- Secret 脱敏。

验收：

- 合法配置通过。
- 项目共享配置中的 literal key 被拒绝。
- 脱敏序列化不包含 Key。

### Step 2：ConfigLocator、Loader、Merger

实现：

- 用户/项目/私有/显式配置定位。
- YAML 加载。
- 配置优先级。
- 合并后校验。

验收：

- 不存在的可选配置被忽略。
- 不存在的显式配置报错。
- CLI 覆盖优先级正确。
- 错误包含文件与字段信息。

### Step 3：SecretResolver 与文件权限

实现：

- Env Secret。
- Trusted local Literal Secret。
- POSIX 权限检查。
- Redacted Secret。

验收：

- 缺少 env key 报错。
- `0644` literal secret 文件被拒绝。
- `0600` trusted local 文件允许使用。
- 日志和序列化不出现明文。

### Step 4：ProviderRegistry 与 Factory

实现：

- Registry。
- OpenAI-compatible factory 注册。
- Provider/model 解析。
- Capability 校验。

验收：

- 任意用户定义 Provider name 可使用。
- 未知 Provider type 有清晰错误。
- OpenAI、DeepSeek、Grok 不需要硬编码 switch。

### Step 5：重构 OpenAICompatibleAdapter

实现：

- 去除内部 `process.env` 读取。
- 拆分 request/response/error mapper。
- 添加 capabilities。
- 保持 ModelProvider Contract。

验收：

- 现有 Tool Call 行为保持。
- 错误映射测试通过。
- SDK 类型不泄漏。

### Step 6：ModelInvoker timeout/retry

实现：

- Timeout。
- Abort Signal 组合。
- Retry Policy。
- 指数退避和 jitter。
- 模型事件。

验收：

- 429/503 可重试。
- 401/403 不重试。
- 用户取消不重试。
- 测试使用 FakeClock/FakeSleeper，不真实等待。

### Step 7：CLI 与 Runtime 装配

实现：

- `--config`。
- `--provider`。
- `--model`。
- Dependency Container。
- Config validate/show。

验收：

- 默认 Provider 可从配置启动。
- CLI 覆盖只影响本次运行。
- 输出配置完全脱敏。

### Step 8：文档和迁移

实现：

- `.codeden/config.example.yaml`。
- `.gitignore` 加入 `.codeden/config.local.yaml`。
- README 配置说明。
- 旧环境变量/alias 迁移说明。
- 删除或收缩旧 `create-model-provider.ts`。

---

## 13. 测试方案

### 13.1 Config Schema

- 最小合法配置。
- 多 Provider 配置。
- defaultProvider 不存在。
- defaultModel 无法确定。
- baseURL 非法。
- retry 值非法。
- Provider name 非法。
- Project literal secret 被拒绝。

### 13.2 Config Priority

- defaults < user。
- user < project。
- project < project-local。
- project-local < explicit config。
- explicit config < CLI non-secret override。
- 数组整体替换。
- Provider 部分字段深度合并。

### 13.3 Secret Security

- Env key 成功解析。
- Env key 缺失。
- Env key 空字符串。
- Trusted local literal。
- Untrusted project literal。
- Literal 文件权限过宽。
- Error、JSON、inspect、event 中不出现密钥。

测试必须使用哨兵密钥：

```text
codeden-secret-must-never-appear
```

测试结束后搜索所有日志和序列化结果，确保哨兵值不存在。

### 13.4 ProviderRegistry

- 注册和创建。
- 重复 type 注册。
- 未知 type。
- 自定义 Provider name。
- 同一 Adapter 创建三个配置化供应商。

### 13.5 OpenAI-Compatible Contract

- 普通文本响应。
- 单 Tool Call。
- 多 Tool Call。
- Tool arguments JSON 无效。
- 空 choices。
- Usage 缺失。
- `stop/tool_calls/length` 映射。
- Abort。
- 401、429、503 错误映射。

### 13.6 Retry

- 第一次 429、第二次成功。
- 连续失败达到上限。
- 401 不重试。
- response invalid 不重试。
- 退避不超过 maxDelay。
- jitter 可确定测试。
- 每次尝试产生完整事件。

### 13.7 Integration

```text
YAML config
-> ConfigLoader
-> SecretResolver(fake env)
-> ProviderRegistry
-> OpenAICompatibleAdapter(fake client)
-> ModelInvoker
-> AgentRunner
-> Tool Call
```

必须验证配置选择的 provider/model 被真实用于请求。

### 13.8 Smoke Test

真实网络测试默认跳过，仅在以下条件同时满足时运行：

- 显式设置 smoke 标志。
- 对应 Secret 可用。
- 用户主动选择 Provider。

Smoke 任务必须只读、低成本，并设置严格 timeout/maxTurns/maxToolCalls。

---

## 14. 建议工作包

### 工作包 A：配置 Schema 与 Loader

负责：

- `src/config/config-*`。
- YAML 加载、定位和合并。
- Schema 测试。

### 工作包 B：Secret Security

负责：

- Secret Reference。
- Resolver。
- Redactor。
- File Permissions。
- 安全测试。

### 工作包 C：Provider Registry 与 Factory

负责：

- Registry。
- Model Selection。
- Factory。
- Capability。

### 工作包 D：OpenAI-Compatible Adapter

负责：

- 重构现有 Adapter。
- Request/Response/Error Mapper。
- Contract Tests。

### 工作包 E：ModelInvoker

负责：

- Timeout。
- Retry。
- Model Events。
- Fake Sleeper/Random 测试。

### 工作包 F：CLI 与集成

负责：

- Dependency Container。
- Agent CLI 参数。
- Config CLI。
- Integration/Smoke Test。
- README 和示例配置。

共享契约由工作包 A、B、C 先冻结，之后 D、E、F 才并行。

---

## 15. 最终验收标准

必须全部满足，才算本阶段完成。

### 15.1 配置流程

- 可以从用户、项目、项目私有和显式路径加载 YAML。
- 配置优先级有自动化测试。
- 所有配置经过 Zod 校验。
- 配置错误包含文件与字段路径。
- `config validate` 能在发起模型请求前发现缺失 Provider、Model 和 Secret。
- `config show` 只输出脱敏配置。

### 15.2 密钥安全

- 项目共享配置禁止 literal key。
- 用户或项目私有配置允许 literal key，但要求安全文件权限。
- 环境变量 Secret Reference 正常工作。
- `.codeden/config.local.yaml` 已加入 `.gitignore`。
- API Key 不出现在日志、事件、异常、测试快照和 TrialResult 中。
- CLI 不提供明文 `--api-key` 参数。
- Secret 安全测试使用哨兵值并确认零泄漏。

### 15.3 Model 适配层

- Agent Core 只依赖内部 `ModelProvider` 和模型类型。
- OpenAI SDK 类型未泄漏到 Agent Core。
- OpenAI、DeepSeek、Grok 使用同一个 OpenAI-compatible Adapter。
- Provider 名称由配置定义，不依赖硬编码 alias switch。
- Model 选择优先级为 CLI > Agent Config > Provider Default。
- 不支持 Tools 的 Provider 在请求前被拒绝。
- 文本、Tool Call、Usage 和 Stop Reason 均被标准化。
- Tool arguments 非法 JSON 返回不可重试结构化错误。

### 15.4 超时与重试

- 每个模型请求有独立 timeout。
- 408、429 和临时 5xx 按配置重试。
- 认证、配置、响应格式和用户取消错误不重试。
- 指数退避受最大延迟限制。
- 重试事件包含 attempt 和 delay，不包含敏感信息。
- Agent 总取消信号能够终止当前模型请求。

### 15.5 CLI 与集成

- 配置完成后，以下最简流程可正常运行：

```bash
codeden "读取 package.json"
```

- `codeden` 无参数启动交互模式。
- 一次性 Prompt 支持位置参数，不强制 `--prompt`。
- 默认 Workspace 为当前目录。
- 默认 Provider、Model、限制和 Key 来源均由配置确定。
- 可通过 `--config` 使用独立本地配置。
- 可通过 `--provider` 临时覆盖默认 Provider。
- 可通过 `--model` 覆盖默认模型。
- 不传 Provider 时使用配置中的 `agent.defaultProvider`。
- 位置 Prompt 与 `--prompt` 同时提供时返回明确错误。
- 没有配置或 Key 时给出可操作的错误，不输出堆栈噪音和密钥。
- Mock Provider 和现有 Eval 流程保持可用。

### 15.6 工程质量

以下命令全部通过：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

另外必须满足：

- 普通测试不访问网络。
- 普通测试不要求真实 API Key。
- Provider Contract Test 对 Mock 和 OpenAI-compatible Adapter 均通过。
- 集成测试覆盖 Config -> Secret -> Provider -> Agent 全链路。
- README 和示例配置与实际 Schema 一致。
- 不存在未使用的旧硬编码 Provider switch。

### 15.7 最终演示

项目共享配置：

```yaml
schemaVersion: 1
agent:
  defaultProvider: openai
providers:
  openai:
    type: openai-compatible
    baseURL: https://api.openai.com/v1
    apiKey:
      from: env
      name: OPENAI_API_KEY
    defaultModel: gpt-4.1-mini
    capabilities:
      tools: true
```

执行：

```bash
export OPENAI_API_KEY="<local-secret>"
codeden "读取 package.json 并告诉我项目名"
```

预期：

```text
配置文件加载并校验
-> SecretResolver 从环境变量读取 Key
-> ProviderRegistry 创建 OpenAI-compatible Adapter
-> ModelInvoker 施加 timeout/retry
-> AgentRunner 调用模型
-> 模型调用 read_file
-> ToolExecutor 读取 package.json
-> 模型生成最终答案
-> CLI 输出 submitted
-> 全流程日志和事件中不包含 API Key
```

该演示与全部自动化验收通过后，才能进入后续的原生 Anthropic Adapter、流式输出或多模型路由开发。

---

## 16. 建议提交拆分

提交必须遵守仓库 Conventional Commits 规范，建议拆分：

```text
feat(core): 新增 CodeDen 配置与密钥引用契约.
feat(runtime): 新增配置驱动的模型 Provider 注册机制.
refactor(runtime): 重构 OpenAI 兼容模型适配器.
feat(runtime): 新增模型请求超时与重试流程.
feat(cli): 新增模型 Provider 与配置文件参数.
test(runtime): 补充模型适配与密钥脱敏测试.
docs(project): 补充模型配置和密钥使用说明.
```

不要把配置、Adapter 重构、CLI 和全部测试压在一个巨大提交中。
