import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

describe('SWE-bench 环境构建器', () => {
  it('为 Astropy 4.3 固定兼容编译器的基础镜像', async () => {
    const script = await readFile(path.resolve('scripts/prepare-swebench-environment.mjs'), 'utf8')

    expect(script).toContain("baseImage: 'python:3.9-slim-bullseye'")
    expect(script).not.toContain("baseImage: 'python:3.9-slim',")
    expect(script).toContain('numpy==1.25.2')
    expect(script).toContain('extension-helpers')
    expect(script).toContain('cython==0.29.22')
    expect(script).toContain('--retries 10 --timeout 60')
    expect(script).toContain("process.env.CODEDEN_PIP_INDEX_URL ?? 'https://pypi.org/simple'")
    expect(script).toContain('CODEDEN_PIP_INDEX_URL=${pipIndexUrl}')
    expect(script).toContain('builderVersion: 4')
  })

  it('为 Apple Silicon 上的官方镜像提供 amd64 兼容入口', async () => {
    const script = await readFile(path.resolve('scripts/run-swebench-official.py'), 'utf8')

    expect(script).toContain('CODEDEN_SWEBENCH_DOCKER_PLATFORM')
    expect(script).toContain('ContainerCollection.create')
    expect(script).toContain('ImageCollection.pull')
    expect(script).toContain('kwargs.setdefault("platform", TARGET_PLATFORM)')
    expect(script).toContain('swebench.harness.run_evaluation')
  })
})
