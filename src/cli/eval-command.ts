import { main } from '@codeden/eval-platform/cli/eval-command.js'
main().then(
  (code) => {
    process.exitCode = code
  },
  () => {
    process.exitCode = 2
  },
)
