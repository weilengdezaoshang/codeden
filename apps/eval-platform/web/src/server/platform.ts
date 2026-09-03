import 'server-only'
import {
  createPlatform,
  platformOptions,
  type Platform,
} from '@codeden/eval-platform/platform/service.js'

const state = globalThis as typeof globalThis & { codedenEvalPlatform?: Promise<Platform> }
export function getPlatform() {
  state.codedenEvalPlatform ??= createPlatform(platformOptions()).catch((error: unknown) => {
    delete state.codedenEvalPlatform
    throw error
  })
  return state.codedenEvalPlatform
}
