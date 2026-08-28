import { DockerSandboxRunner } from './docker-sandbox-runner.js'
import { HostSandboxRunner } from './host-sandbox-runner.js'
import type { SandboxRunner } from './sandbox-runner.js'

export interface SandboxRunnerOptions {
  mode?: 'host' | 'docker'
  image?: string
  readOnly?: boolean
  dockerContext?: string
  dockerHost?: string
  cpus?: number
  memoryLimit?: string
  tmpfsSize?: string
  pidsLimit?: number
  runner?: SandboxRunner
}

export function createSandboxRunner(options?: SandboxRunnerOptions): SandboxRunner | undefined {
  if (!options) {
    return undefined
  }
  return (
    options.runner ??
    (options.mode === 'docker' ? new DockerSandboxRunner(options) : new HostSandboxRunner())
  )
}
