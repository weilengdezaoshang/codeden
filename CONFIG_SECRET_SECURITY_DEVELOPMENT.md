# CodeDen 配置与 Secret 防泄露开发文档

## 1. 文档目标

本文供实现 Agent 阅读和开发，范围只包含：

1. 从配置文件选择默认 Provider、Model 和 Agent 限制。
2. 通过安全引用解析 API Key。
3. 确保大模型、文件工具、Shell 子进程、日志和评测系统无法读取或泄露 Key。

本阶段完成后的最简调用：

```bash
codeden "读取 package.json 并告诉我项目名"
```

内部流程：

```text
CLI
-> 定位 .codeden/config.yaml
-> 读取 YAML
-> Zod 校验
-> 选择默认 Provider 和 Model
-> SecretResolver 解析环境变量引用
-> Secret 仅交给 ModelProvider Transport
-> AgentRunner 执行
-> Tool Runtime 使用无 Secret 环境
-> Tool Result 进入模型前执行脱敏
-> 日志、事件和结果只保存脱敏内容
```

安全原则：

> 模型调用程序需要 Key，不代表大模型、Agent Runtime 或工具需要看到 Key。

---

## 2. 当前代码的安全基线

当前 CodeDen 已有：

- OpenAI-compatible Provider。
- `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`XAI_API_KEY` 环境变量读取。
- `run_command` 环境变量白名单。
- WorkspacePolicy。
- 结构化 Tool Result。
- Agent 和 Eval 事件。
- 普通测试不要求真实 Key。

当前仍存在的缺口：

- Provider 创建通过硬编码 `switch` 完成。
- Provider 自己可以回退读取 `process.env`。
- 没有 YAML 配置系统。
- 没有 Secret Reference 和 Secret Resolver。
- 没有不可打印的 Secret 类型。
- `read_file` 没有统一敏感路径拒绝规则。
- Tool Result、stdout、stderr 和错误没有统一 Secret Redactor。
- EventSink、TrialResult 和 Reporter 没有 Secret 泄露守卫。
- 没有哨兵 Secret 全链路测试。
- 没有本地 Secret 扫描门禁。

---

## 3. 阶段范围

### 3.1 必须实现

配置：

- `.codeden/config.yaml`。
- `CodeDenConfigSchema`。
- YAML Loader。
- 项目配置定位。
- 默认 Provider、Model、maxTurns、maxToolCalls。
- 位置 Prompt。
- 当前目录作为默认 Workspace。

Secret：

- `SecretReference`。
- `SecretResolver`。
- `ResolvedSecret`。
- `SecretRegistry`。
- `SecretRedactor`。
- `SecretLeakGuard`。
- Provider 构造注入 Secret。
- 禁止 Provider 内部直接读取 `process.env`。

工具安全：

- Shell 子进程环境变量白名单。
- 敏感文件路径拒绝。
- Tool Result 脱敏。
- stdout/stderr 脱敏。
- 错误 details 脱敏。

持久化和输出：

- Event 写入前脱敏。
- TrialResult 保存前泄露检查。
- Console 输出前脱敏。
- JSON 序列化安全。

工程安全：

- `.env*`、`.codeden/config.local.yaml` 等加入 `.gitignore`。
- Secret 扫描脚本。
- 安全单元测试、集成测试和端到端测试。

### 3.2 本阶段不实现

- 配置文件明文 Key。
- `grok login`。
- OAuth。
- Keychain、Vault。
- MCP Secret 注入。
- Docker Secret Mount。
- 用户全局配置合并。
- 多项目 Profile。
- Provider 自动故障转移。
- Secret 自动轮换。

第一版只支持环境变量 Secret Reference。这样安全边界最小、明确、可验证。

---

## 4. 威胁模型

必须假设：

- 模型可能调用 `read_file` 读取 `.env`。
- 模型可能执行 `env`、`printenv` 或读取 `/proc`。
- Prompt Injection 可能诱导模型寻找凭证。
- 工具或 SDK 错误可能把 Authorization Header 放入异常。
- stdout/stderr 可能意外包含 Secret。
- Event、Session、TrialResult 或测试 Snapshot 可能持久化 Secret。
- 开发者可能误把 `.env` 提交 Git。
- 将来接入的 MCP Server 可能不可信。

不依赖以下措施作为安全边界：

- System Prompt 中写“不要读取 Key”。
- 模型承诺不泄露。
- `.gitignore`。
- 只在最终 Console 输出时脱敏。
- 私有 Git 仓库。

---

## 5. 总体架构

```text
                         ┌──────────────────────┐
                         │ .codeden/config.yaml│
                         │ 只含 Secret 引用     │
                         └──────────┬───────────┘
                                    ↓
┌──────────────┐          ┌──────────────────────┐
│ process.env  │ -------->│ SecretResolver       │
│ 实际 Key     │          │ 返回 ResolvedSecret │
└──────────────┘          └──────────┬───────────┘
                                    ↓ exposeForTransport()
                         ┌──────────────────────┐
                         │ ModelProvider        │
                         │ 私有持有 Secret       │
                         └──────────┬───────────┘
                                    ↓ HTTPS Authorization
                         ┌──────────────────────┐
                         │ Provider API         │
                         └──────────────────────┘

AgentRunner / Tools / Workspace / Eval
        │
        ├── 不持有 ResolvedSecret
        ├── 子进程环境变量白名单
        ├── 敏感路径拒绝
        └── 所有输出经过 SecretRedactor
```

---

## 6. 推荐目录

```text
src/
├── config/
│   ├── config-schema.ts
│   ├── config-loader.ts
│   ├── config-locator.ts
│   ├── config-validator.ts
│   └── config-errors.ts
│
├── security/
│   ├── secret-reference.ts
│   ├── resolved-secret.ts
│   ├── secret-resolver.ts
│   ├── secret-registry.ts
│   ├── secret-redactor.ts
│   ├── secret-leak-guard.ts
│   ├── sensitive-path-policy.ts
│   └── safe-serialization.ts
│
├── runtime/
│   ├── models/
│   │   ├── provider-registry.ts
│   │   ├── model-provider-factory.ts
│   │   └── openai-model-provider.ts
│   ├── process-env.ts
│   ├── tools/
│   │   ├── tool-executor.ts
│   │   └── builtins/
│   │       ├── read-file.ts
│   │       └── run-command.ts
│   └── workspace/
│       └── workspace-policy.ts
│
├── eval/
│   ├── application/event-recorder.ts
│   ├── application/trial-runner.ts
│   ├── adapters/repositories/in-memory-eval.repository.ts
│   └── reporters/console.reporter.ts
│
└── cli/
    ├── codeden.ts
    ├── agent-command.ts
    └── dependency-container.ts

scripts/
└── scan-secrets.mjs

tests/
├── unit/config/
├── unit/security/
├── unit/runtime/
└── e2e/secret-isolation.test.ts
```

---

## 7. 配置设计

### 7.1 配置文件

项目配置：

```text
<workspace>/.codeden/config.yaml
```

示例：

```yaml
schemaVersion: 1

agent:
  defaultProvider: deepseek
  defaultModel: deepseek-chat
  maxTurns: 8
  maxToolCalls: 16

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
```

配置文件只能保存环境变量名称，不能保存真实 Key。

禁止：

```yaml
apiKey: sk-real-key
```

也禁止：

```yaml
apiKey:
  from: literal
  value: sk-real-key
```

### 7.2 Secret Reference Schema

```ts
export const SecretReferenceSchema = z.object({
  from: z.literal('env'),
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
})
```

### 7.3 Provider Schema

```ts
export const ProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  apiKey: SecretReferenceSchema,
  defaultModel: z.string().min(1),
  capabilities: z.object({
    tools: z.boolean().default(true),
  }),
})
```

### 7.4 根配置 Schema

```ts
export const CodeDenConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z.object({
      defaultProvider: z.string().min(1),
      defaultModel: z.string().min(1).optional(),
      maxTurns: z.number().int().positive().default(8),
      maxToolCalls: z.number().int().positive().default(16),
    }),
    providers: z.record(z.string().min(1), ProviderConfigSchema),
  })
  .superRefine((config, context) => {
    if (!(config.agent.defaultProvider in config.providers)) {
      context.addIssue({
        code: 'custom',
        path: ['agent', 'defaultProvider'],
        message: '默认 Provider 不存在',
      })
    }
  })
```

### 7.5 ConfigLoader

流程：

```text
接收 workspace root
-> 定位 .codeden/config.yaml
-> 检查文件大小
-> 读取 UTF-8
-> YAML parse
-> Zod parse
-> 交叉字段校验
-> 返回 CodeDenConfig
```

要求：

- 文件不存在时给出明确配置指导。
- YAML 错误包含文件、行和列。
- Schema 错误包含字段路径。
- 错误信息不得包含 Secret 值。
- 不读取任意父目录中的未知配置。

---

## 8. Secret 模块

### 8.1 ResolvedSecret

实际 Secret 不使用普通字符串在模块间传递。

```ts
export class ResolvedSecret {
  #value: string

  constructor(value: string) {
    if (!value.trim()) {
      throw new Error('Secret cannot be empty')
    }
    this.#value = value
  }

  exposeForTransport(): string {
    return this.#value
  }

  matches(value: string): boolean {
    return value.includes(this.#value)
  }

  toString(): string {
    return '<redacted>'
  }

  toJSON(): string {
    return '<redacted>'
  }
}
```

限制：

- `exposeForTransport()` 只能在 Provider Adapter 内调用。
- `ResolvedSecret` 不进入 AgentContext、ToolContext、RunEvent 或 TrialResult。
- 不提供公开 `value` 字段。
- `inspect` 也必须返回 `<redacted>`。

### 8.2 SecretResolver

```ts
export interface SecretResolver {
  resolve(reference: SecretReference): ResolvedSecret
}
```

环境变量解析：

```text
reference.name
-> process.env[name]
-> trim 检查
-> 注册到 SecretRegistry
-> 返回 ResolvedSecret
```

错误示例：

```text
环境变量 DEEPSEEK_API_KEY 未配置
```

禁止输出：

```text
DEEPSEEK_API_KEY=sk-xxxx 无效
```

### 8.3 SecretRegistry

Registry 只服务于脱敏，不向业务模块暴露原值。

```ts
export interface SecretRegistry {
  register(secret: ResolvedSecret): void
  redact(text: string): string
  containsSecret(text: string): boolean
}
```

Registry 生命周期：

- 一个 CodeDen 进程一个 Registry。
- 测试可以独立注入。
- 不能序列化。
- 不写磁盘。

### 8.4 SecretRedactor

脱敏顺序：

```text
已解析 Secret 精确匹配
-> Authorization/Bearer 上下文规则
-> 常见 Provider Key 模式
-> 输出脱敏文本
```

最低规则：

```text
Authorization: Bearer <redacted>
api_key=<redacted>
apiKey=<redacted>
xai-... -> <redacted>
sk-...  -> <redacted>
```

精确 Secret 匹配必须优先，因为不同 Provider 的 Key 格式可能变化。

### 8.5 SecretLeakGuard

Guard 用于持久化前的一票否决检查：

```ts
export interface SecretLeakGuard {
  assertSafe(value: unknown, destination: string): void
}
```

使用位置：

- RunEvent 写入前。
- TrialResult 保存前。
- Artifact 保存前。
- Console 输出前。
- 测试 Snapshot 写入前。

发现已知 Secret 时：

- 阻止写入。
- 抛出 `SECRET_LEAK_DETECTED`。
- 错误只描述 destination，不包含 Secret。

---

## 9. Provider 隔离

### 9.1 禁止 Provider 自己读环境变量

当前构造方式需要改造。

禁止：

```ts
new OpenAI({
  apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
})
```

改为：

```ts
new OpenAIModelProvider({
  model,
  baseURL,
  apiKey: resolvedSecret,
})
```

Provider 构造时缺少 Secret 必须立即失败。

### 9.2 ModelProviderFactory

流程：

```text
读取 ProviderConfig
-> SecretResolver.resolve(apiKey reference)
-> 确定 Model
-> 构造 Provider
-> Provider 私有持有 ResolvedSecret
```

AgentRunner 只获得：

```ts
ModelProvider
```

不得获得：

```ts
ResolvedSecret
ProviderConfig.apiKey 实际值
Authorization Header
```

### 9.3 HTTP 日志

- 禁止开启会打印完整 Header 的 SDK debug 日志。
- 错误映射不得保存 Request 对象。
- Provider 原始异常进入 `details` 前必须提取安全字段。
- 只允许记录 provider、model、status、requestId 和 retryable。

---

## 10. 文件工具防护

### 10.1 敏感路径规则

新增 `SensitivePathPolicy`，默认拒绝读取、搜索和列举内容：

```text
.env
.env.*
*.pem
*.key
credentials.json
secrets.json
.codeden/config.local.yaml
.ssh/**
.aws/credentials
.config/gcloud/**
.grok/auth.json
```

`.codeden/config.yaml` 可以读取结构，但所有 Secret 字段必须在返回模型前脱敏。更简单且更安全的第一版可以直接禁止模型读取整个 `.codeden/**`。

### 10.2 read_file 流程

```text
接收 path
-> WorkspacePolicy 检查工作区边界
-> SensitivePathPolicy 检查敏感路径
-> 读取文件
-> SecretRedactor 脱敏
-> SecretLeakGuard 检查
-> 返回 Tool Result
```

敏感路径被拒绝时返回：

```json
{
  "code": "WORKSPACE_SECRET_PATH_DENIED",
  "category": "permission",
  "message": "读取敏感配置文件被安全策略拒绝"
}
```

错误中不得回显目标文件内容。

### 10.3 write_file/edit_file

- 不允许写入 `.env`、凭证文件和认证缓存。
- 不允许通过 Agent 创建 `.codeden/config.local.yaml` 保存 Key。
- 写入内容先经过 SecretLeakGuard；包含已知 Secret 时拒绝。
- 错误 Preview 不显示包含 Secret 的输入内容。

---

## 11. Shell 子进程防护

### 11.1 环境变量白名单

保留当前 CodeDen 的白名单设计：

```ts
export const COMMAND_ENV_WHITELIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HOME',
  'TMPDIR',
] as const
```

禁止：

```ts
spawn(command, args, { env: process.env })
```

任何新增环境变量必须经过安全评审。不得把以下变量加入白名单：

```text
OPENAI_API_KEY
DEEPSEEK_API_KEY
XAI_API_KEY
ANTHROPIC_API_KEY
APIKEY
GITHUB_TOKEN
AWS_SECRET_ACCESS_KEY
```

### 11.2 HOME 风险

即使子进程没有 Key 环境变量，`HOME` 可能让命令读取：

```text
~/.ssh
~/.aws
~/.grok
```

第一版最安全方案：

- 为 Agent 命令提供临时 HOME。
- 只创建必要的缓存目录。
- 不挂载用户真实认证目录。

如果阶段限制无法立即替换 HOME，必须至少：

- 禁止模型执行读取常见凭证目录的命令。
- 在下一阶段 Sandbox 中完成真正隔离。
- 在文档中明确这是剩余风险。

### 11.3 stdout/stderr

```text
子进程输出
-> 限制最大大小
-> SecretRedactor
-> SecretLeakGuard
-> Tool Result
-> Model Message
```

原始未脱敏输出不得写入 Artifact。

---

## 12. Event、Eval 与日志防护

### 12.1 EventSink Wrapper

新增安全包装器：

```ts
class SecureEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly redactor: SecretRedactor,
    private readonly guard: SecretLeakGuard,
  ) {}

  async emit(source: string, type: string, data: unknown) {
    const safeData = this.redactor.redactValue(data)
    this.guard.assertSafe(safeData, `event:${type}`)
    await this.inner.emit(source, type, safeData)
  }
}
```

Agent、Tool、Model、Eval 全部使用同一个 SecureEventSink。

### 12.2 TrialResult

保存前：

```text
TrialResult
-> deep redact
-> leak guard
-> Zod validate
-> Repository.saveTrial
```

### 12.3 ConsoleReporter

- 所有动态文本先经过 Redactor。
- 不直接打印未知 Error 对象。
- 不打印 Provider SDK Request/Response。
- `config show` 中 `apiKey` 显示引用或 `<redacted>`。

### 12.4 Session 与 Artifact

本阶段即使尚未实现持久 Session，也要冻结规则：

- Session 永不保存 ResolvedSecret。
- 未脱敏 Tool Result 永不落盘。
- Artifact 保存前必须过 Guard。
- 敏感错误只保存错误码和安全摘要。

---

## 13. CLI 流程

### 13.1 正常调用

```bash
export DEEPSEEK_API_KEY="<local-secret>"
codeden "读取 package.json"
```

CLI 不提供：

```text
--api-key
--secret
--authorization
```

避免 Key 进入：

- Shell History。
- `ps` 进程列表。
- CI 命令日志。

### 13.2 配置验证

```bash
codeden config validate
```

输出：

```text
✓ .codeden/config.yaml 已加载
✓ Provider deepseek 已配置
✓ DEEPSEEK_API_KEY 可用
✓ Secret 未进入可打印配置
```

不能输出环境变量值。

### 13.3 配置展示

```bash
codeden config show
```

输出：

```yaml
apiKey:
  from: env
  name: DEEPSEEK_API_KEY
```

只显示引用，不解析和显示值。

---

## 14. Git 与仓库防护

### 14.1 `.gitignore`

至少加入：

```gitignore
.env
.env.*
!.env.example
.codeden/config.local.yaml
*.pem
*.key
```

`.env.example` 只能包含变量名：

```dotenv
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
XAI_API_KEY=
```

### 14.2 Secret 扫描

新增：

```bash
pnpm security:secrets
```

扫描范围：

- 暂存文件。
- 工作区文本文件。
- CI 中扫描整个提交。

可使用 Gitleaks，也可以第一版使用受控脚本加常见模式；正式发布前推荐接入成熟 Secret Scanner。

### 14.3 泄露处置

一旦真实 Key 进入 Git：

```text
立即撤销 Key
-> 创建新 Key
-> 检查使用记录和账单
-> 清理当前文件
-> 按需要清理 Git 历史
-> 运行全仓库 Secret 扫描
```

只删除当前文件不足以恢复安全性。

---

## 15. 错误码

新增：

```text
CONFIG_NOT_FOUND
CONFIG_READ_FAILED
CONFIG_YAML_INVALID
CONFIG_SCHEMA_INVALID
CONFIG_PROVIDER_NOT_FOUND
SECRET_ENV_NOT_FOUND
SECRET_LITERAL_FORBIDDEN
SECRET_LEAK_DETECTED
WORKSPACE_SECRET_PATH_DENIED
TOOL_OUTPUT_SECRET_DETECTED
MODEL_AUTHENTICATION_FAILED
```

错误要求：

- 包含可操作的配置建议。
- 不包含 Secret。
- 不保存 Authorization Header。
- 不把整个 Environment 或 SDK Error 对象放入 details。

---

## 16. 实现顺序

### Step 1：Secret 基础类型

实现：

- SecretReference。
- ResolvedSecret。
- SecretRegistry。
- SecretRedactor。
- SecretLeakGuard。

先完成安全类型，才能开始 Config 和 Provider 改造。

### Step 2：配置 Schema 与 Loader

实现：

- CodeDenConfigSchema。
- ConfigLocator。
- ConfigLoader。
- 配置错误。

### Step 3：Provider 注入

实现：

- SecretResolver。
- ModelProviderFactory。
- 移除 Provider 内 `process.env` fallback。
- Provider 私有持有 ResolvedSecret。

### Step 4：敏感路径策略

实现：

- SensitivePathPolicy。
- read/write/edit 拒绝规则。
- 文件内容 Redactor 和 LeakGuard。

### Step 5：Shell 隔离

实现：

- Env allowlist 测试。
- 临时 HOME 或剩余风险处理。
- stdout/stderr 脱敏。

### Step 6：事件和评测防护

实现：

- SecureEventSink。
- TrialResult Guard。
- Console Reporter Redactor。

### Step 7：CLI 与简洁调用

实现：

- 位置 Prompt。
- 默认 Workspace。
- 默认 Provider/Model。
- config validate/show。
- 禁止 Key CLI 参数。

### Step 8：Secret 扫描与安全 E2E

实现：

- `.gitignore`。
- `security:secrets`。
- 哨兵 Secret 全链路测试。

---

## 17. 测试方案

### 17.1 哨兵 Secret

所有安全测试使用：

```text
codeden-secret-must-never-appear
```

该值注册为真实运行 Secret，然后执行完整流程。

### 17.2 Secret 类型

- `String(secret)` 返回 `<redacted>`。
- `JSON.stringify(secret)` 不包含哨兵。
- `inspect(secret)` 不包含哨兵。
- Error 序列化不包含哨兵。

### 17.3 配置

- 正确解析 env reference。
- 缺失环境变量。
- 空环境变量。
- 配置出现 literal secret 被拒绝。
- YAML/Schema 错误不回显敏感内容。

### 17.4 文件工具

- 拒绝 `.env`。
- 拒绝 `.env.local`。
- 拒绝 `.ssh/id_ed25519`。
- 拒绝 `.codeden/config.local.yaml`。
- 普通文件正常读取。
- 普通文件中意外出现哨兵时输出被脱敏。
- 写入包含哨兵的内容被拒绝。

### 17.5 Shell

- `run_command` 看不到 Provider Key。
- `env` 输出中不存在哨兵。
- stdout 包含哨兵时 Tool Result 被脱敏。
- stderr 包含哨兵时 Tool Result 被脱敏。
- 子进程没有继承整个 `process.env`。

### 17.6 Event 和 Eval

- Model error 含哨兵时 Event 被脱敏。
- Tool Result 含哨兵时 Event 被脱敏。
- TrialResult 中不出现哨兵。
- Console 输出中不出现哨兵。
- Repository 拒绝未脱敏 Secret。

### 17.7 端到端攻击场景

#### E2E-1：模型读取 `.env`

MockModelProvider 调用：

```json
{
  "name": "read_file",
  "arguments": { "path": ".env" }
}
```

期望：

- 返回 `WORKSPACE_SECRET_PATH_DENIED`。
- Key 不进入模型消息。
- Key 不进入 Event。

#### E2E-2：模型执行 `env`

期望：

- 命令可以运行或按策略拒绝。
- 输出不存在 Provider Key。
- Event 不含哨兵。

#### E2E-3：工具异常泄露

构造包含哨兵的错误。

期望：

- 模型只收到 `<redacted>`。
- Error details、Event 和 TrialResult 均安全。

#### E2E-4：模型尝试写出 Key

Mock Model 让 `write_file` 写入哨兵。

期望：

- 写入被 SecretLeakGuard 拒绝。
- 文件不存在或保持原内容。

#### E2E-5：正常模型调用

Provider 获得真实 Secret 并成功构造请求。

期望：

- Fake HTTP Client 确认认证被使用。
- Agent、工具、事件和结果均看不到 Secret。

---

## 18. 工作包拆分

### 工作包 A：Secret Core

负责：

- `src/security/secret-*`。
- Safe Serialization。
- 哨兵测试。

必须最先完成并冻结接口。

### 工作包 B：Config

负责：

- `src/config/**`。
- YAML Schema、Loader 和错误。
- 配置测试。

依赖工作包 A。

### 工作包 C：Provider Security

负责：

- SecretResolver。
- ModelProviderFactory。
- 移除 Provider 环境变量读取。
- Fake HTTP 集成测试。

依赖工作包 A、B。

### 工作包 D：Tool Security

负责：

- SensitivePathPolicy。
- 文件工具安全。
- Shell env 白名单和输出脱敏。

依赖工作包 A。

### 工作包 E：Event/Eval Security

负责：

- SecureEventSink。
- TrialResult Guard。
- Reporter 脱敏。

依赖工作包 A。

### 工作包 F：CLI 与 E2E

负责：

- 简洁调用。
- Config validate/show。
- Secret 扫描。
- 安全端到端测试。

依赖 A 至 E。

---

## 19. 最终验收标准

以下任何安全项失败，本阶段整体失败。

### 19.1 配置

- `.codeden/config.yaml` 可以选择默认 Provider 和 Model。
- 配置只保存环境变量引用。
- 明文 Key 配置被拒绝。
- 缺少 Key 时提供清晰错误。
- 配置和错误均不显示 Key。

### 19.2 Provider

- Provider Adapter 不直接读取 `process.env`。
- Secret 通过 SecretResolver 注入。
- 只有 Provider Transport 能调用 `exposeForTransport()`。
- AgentRunner、ToolExecutor 和 Eval 无法获得 ResolvedSecret。
- Provider 错误不包含请求 Header 或 Secret。

### 19.3 工具

- Shell 子进程不继承模型 API Key。
- 文件工具拒绝敏感路径。
- 工具输出进入模型前完成脱敏。
- Agent 不能把已知 Secret 写入 Workspace。
- stdout、stderr 和错误均经过 Redactor。

### 19.4 事件和结果

- Event 不包含 Secret。
- TrialResult 不包含 Secret。
- Console 不包含 Secret。
- Repository 拒绝保存未脱敏 Secret。
- Snapshot 和 Artifact 不包含 Secret。

### 19.5 Git

- `.env*` 和本地 Secret 配置已忽略。
- Secret 扫描命令可以运行。
- CI 执行 Secret 扫描。
- 仓库中不存在真实 Key。

### 19.6 调用体验

配置：

```yaml
schemaVersion: 1
agent:
  defaultProvider: deepseek
  defaultModel: deepseek-chat
  maxTurns: 8
  maxToolCalls: 16
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
```

运行：

```bash
export DEEPSEEK_API_KEY="<local-secret>"
codeden "读取 package.json"
```

必须自动完成：

```text
加载配置
-> 解析 Secret
-> 创建 Provider
-> 使用当前目录
-> 执行 Agent
-> Key 不进入任何模型消息、工具环境、日志或结果
```

### 19.7 工程质量

全部通过：

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm security:secrets
```

安全 E2E 必须证明：

```text
模型尝试读取 .env        -> 被拒绝
模型执行 env             -> 看不到 Key
工具输出意外包含 Key      -> 被脱敏
模型尝试写出 Key          -> 被拒绝
Event/Trial/Console       -> 零 Secret
Provider HTTP Transport  -> 仍可正常认证
```

---

## 20. 建议提交拆分

遵循仓库提交规范：

```text
feat(core): 新增 Secret 引用与脱敏安全契约.
feat(core): 新增 CodeDen 项目配置加载流程.
refactor(runtime): 改为安全注入模型 Provider 密钥.
feat(workspace): 新增敏感文件路径访问限制.
fix(runtime): 阻止工具子进程继承模型密钥.
feat(eval): 新增评测事件与结果泄露守卫.
test(runtime): 补充 Secret 隔离端到端测试.
build(project): 新增仓库 Secret 扫描门禁.
docs(project): 补充配置与密钥安全说明.
```

不得将真实 Key、`.env` 或包含 Secret 的测试输出提交到仓库。
