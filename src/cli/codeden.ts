#!/usr/bin/env node
import { main } from '@codeden/agent/codeden.js'

// 保留旧入口路径；实际路由由 Agent 应用统一处理。
main().then(
  (code) => {
    process.exitCode = code
  },
  () => {
    process.exitCode = 1
  },
)
