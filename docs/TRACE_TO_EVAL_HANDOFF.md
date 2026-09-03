# Trace 转离线评测：讨论交接

更新：2026-08-31。本文记录讨论和候选方案，不代表已实现或已完成选型。本会话只新增此交接文件，没有修改业务代码、安装框架或运行接入验证。

## 目标与讨论焦点

用户需要把线上收集的 Agent Trace 转成可执行的评测用例，再复用现有离线评测评分。缺口是“从 Trace 提取任务与关键条件，制作初始项目、数据、环境和独立验收规则”，不是再建设 sandbox，也不只是安装已有项目的依赖。

目标链路：Trace → 材料完整性检查 → 任务/环境制作 → 实际自检 → 人工审核 → 发布 Case → 原有离线重复评测。

## 最新约束：隐私

用户明确：线上 Trace 因隐私不记录具体文件路径和文件名。以下只是建议，尚未决定：

- 默认不上传绝对路径、用户名、项目名和业务文件名；用任务内稳定编号（如 file_001）关联多次读写。
- 按需保留格式、文件角色、必要关系和“是否越过允许修改范围”等检查结果；元数据也需隐私审查。
- package.json 等名称具有执行语义，可按明确策略保留，或仅记录“Node 包清单”角色，在生成环境时恢复标准名称。
- 匿名文件编号不足以恢复环境。缺少初始内容、必要数据或成功标准时，不能声称能真实复现。

待比较的采集/制作路径：

1. 默认上传匿名事件、脱敏错误及约束结果，用于问题发现和合成用例。
2. 用户主动在本地预览、脱敏并授权上传最小复现材料。
3. 原始材料留在本地，由本地 Agent 制作最小复现项目，经用户审核后仅上传任务包；仍须检查生成内容是否泄露隐私。

## 用例制作的边界

- 有授权的初始代码/数据和依赖时，尽量恢复真实任务；commit 可能不包含未提交修改。
- 无法取得原始环境但题意明确时，可生成合成用例，必须注明“由 Trace 衍生”，不能称为原故障复现。
- 关键材料或成功标准不足时暂存待补充，不能靠猜测发布。
- 建议“固定模板 + 制作 Agent + 程序自检 + 人工审核”；未选定框架，也不要求马上做多 Agent 编排。
- 模板不能只按读/写工具分类，须保留影响失败的条件。旧 Agent 输出不是默认标准答案，旧修复也不能默认注入新任务。
- 环境可运行与题目可正确判卷是两项验收。修 Bug 题可检查原始错误、参考修复和回归测试，并重复自检；并非所有任务都适用“空操作必须失败”。

例：用户要求改配置端口，Agent 却删了其他字段。用例应包含多字段 JSON、仅改端口的任务，以及目标值/其他字段/格式/改动范围检查。如果失败依赖大文件、权限或多文件关系，必须保留这些条件。

## 仓库现状（本会话阅读时，开发前需重新核对）

- 已有 DockerSandboxRunner：禁网、非 root、权限与进程限制、超时/中止清理。每条命令新建容器后删除；挂载目录保留，其他容器状态和后台进程不跨命令保留。
- Docker 实现固定用户 node、工作目录 /workspace；外部镜像需要适配，不能假定即插即用。
- 已有独立临时 Workspace、fixture 复制/固定 commit 检出、TrialRunner、EvalRunner、平台 API/数据库/Worker 代码。README 部分描述落后于代码。
- 检查时 EvalRunner 每题执行一次，创建接口没有重复次数；PRD 已要求重复评测。其他会话可能继续修改。

相关代码：

- packages/agent-runtime/src/sandbox/docker-sandbox-runner.ts
- packages/agent-runtime/src/workspace/temporary-workspace.ts
- packages/eval-engine/src/adapters/workspaces/repository-workspace.factory.ts
- packages/eval-engine/src/application/trial-runner.ts
- packages/eval-engine/src/application/eval-runner.ts
- apps/eval-platform/src/platform/contracts.ts

按需读现有需求：

- docs/prd/eval-environment-authoring.md
- docs/prd/eval-repeat-experiments.md
- docs/prd/eval-platform-closed-loop.md

## 框架调研结论与来源

尚未验证到成熟通用框架可将任意不完整 Trace 一键转换为可靠环境与验收测试；这不是对社区不存在此类方案的绝对断言。所有工具均未在 CodeDen 实测。

- RepoLaunch：已有仓库/版本 → 安装、构建、镜像、测试命令与解析器；支持 Node/TS。不能从缺失材料的 Trace 恢复原项目。https://github.com/microsoft/RepoLaunch
- Harbor：任务说明、环境、参考解、测试的任务包格式及执行能力。无需因此替换现有引擎。https://www.harborframework.com/docs/tasks
- Terminal-Bench：自动构建、Oracle/Nop 检查和人工审核。https://github.com/harbor-framework/terminal-bench/blob/main/docs/TASK_REVIEW_AUTOMATION.md
- Dev Containers CLI：复用已有环境配置；部分配置可在宿主机执行，不能未经审查运行外部配置。https://github.com/devcontainers/cli
- Langfuse：Trace 转数据集条目和来源关联，不负责恢复文件/服务状态。https://langfuse.com/docs/evaluation/experiments/datasets
- AgentSynth：文档提供 Trace 导入和含初始状态/检查器的场景包；未证明自动恢复任意线上环境，不建议直接作为生产底座。https://github.com/agentsynth/agentsynth

此前推荐 OpenSandbox 偏离需求，已纠正：优先复用现有 sandbox，建设 Trace 转 Case 环节。

## 下一会话应推进

确定隐私约束下的最小采集字段、材料不足的分流规则，以及是否采用本地生成最小复现项目的方式；再确定任务包如何映射到现有 Case/fixture/grader。优先拿一条 Trace 举例，清楚说明输入、输出、人工确认点与自检标准。

用户希望解释简短具体，避免重复介绍 sandbox 或不断罗列框架。未授权自动上传用户材料、发起付费构建或实施完整方案。
