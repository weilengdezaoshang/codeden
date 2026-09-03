import { main } from '@codeden/agent/agent-command.js'
main().then(
  (code) => {
    process.exitCode = code
  },
  () => {
    process.exitCode = 1
  },
)
