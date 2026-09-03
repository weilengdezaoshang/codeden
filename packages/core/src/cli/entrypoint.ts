import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 比较实际文件，避免兼容入口 import 时二次启动，也支持包管理器 bin 链接。 */
export function isEntrypoint(url: string): boolean {
  try {
    return Boolean(
      process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)),
    )
  } catch {
    return false
  }
}
