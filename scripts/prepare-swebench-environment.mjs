import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const datasetPath = path.resolve(
  args.get('--dataset') ?? '.codex/datasets/swebench-lite-test.jsonl',
)
const instanceId = args.get('--instance')
if (!instanceId) {
  throw new Error('缺少 --instance')
}
const buildRoot = path.resolve(args.get('--build-root') ?? '.codex/swebench-environments')
const record = (await readFile(datasetPath, 'utf8'))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find((item) => item.instance_id === instanceId)
if (!record) {
  throw new Error(`找不到评测题目：${instanceId}`)
}
if (!record.environment_setup_commit) {
  throw new Error(`题目 ${instanceId} 没有 environment_setup_commit，无法自动准备环境`)
}
const spec = environmentSpec(record)
const baseImage = process.env.CODEDEN_SWEBENCH_BASE_IMAGE ?? spec.baseImage
const pipIndexUrl = process.env.CODEDEN_PIP_INDEX_URL ?? 'https://pypi.org/simple'

const safeId = instanceId.replace(/[^A-Za-z0-9_.-]/gu, '_')
const context = path.join(buildRoot, safeId)
const repository = path.join(context, 'repository')
const image = `codeden/swebench/${safeId}:setup-${record.environment_setup_commit.slice(0, 12)}`
await mkdir(context, { recursive: true })
if (!(await exists(repository))) {
  await run('git', [
    'clone',
    '--no-checkout',
    '--',
    `https://github.com/${record.repo}.git`,
    repository,
  ])
}
await run('git', [
  '-C',
  repository,
  'fetch',
  '--depth',
  '1',
  'origin',
  record.environment_setup_commit,
])
await run('git', ['-C', repository, 'checkout', '--detach', record.environment_setup_commit])

const dockerfile = [
  `FROM ${baseImage}`,
  '',
  'ARG CODEDEN_PIP_INDEX_URL=https://pypi.org/simple',
  'ENV PIP_INDEX_URL=${CODEDEN_PIP_INDEX_URL}',
  '',
  'WORKDIR /workspace',
  '',
  'RUN apt-get update && apt-get install -y --no-install-recommends git gcc g++ make && rm -rf /var/lib/apt/lists/*',
  'RUN useradd --create-home --uid 1000 node',
  '',
  'COPY . /workspace',
  ...spec.steps.map((step) => `RUN ${step}`),
  "RUN printf '%s\\n' '#!/bin/sh' 'set -eu' 'if [ -f setup.py ] && [ ! -f .git/codeden-build-ready ]; then python setup.py build_ext --inplace; touch .git/codeden-build-ready; fi' 'exec \"$@\"' > /usr/local/bin/codeden-entrypoint && chmod +x /usr/local/bin/codeden-entrypoint",
  '',
  'ENTRYPOINT ["/usr/local/bin/codeden-entrypoint"]',
  'CMD ["python", "-m", "pytest"]',
  '',
].join('\n')
await writeFile(path.join(context, 'Dockerfile'), dockerfile, 'utf8')
await run('docker', [
  'build',
  '--build-arg',
  `CODEDEN_PIP_INDEX_URL=${pipIndexUrl}`,
  '--file',
  path.join(context, 'Dockerfile'),
  '--tag',
  image,
  repository,
])
const manifestPath = path.join(context, 'environment.json')
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`
await writeFile(
  temporaryManifest,
  `${JSON.stringify({ builderVersion: 4, instanceId, repo: record.repo, version: record.version, environmentSetupCommit: record.environment_setup_commit, baseImage, pipIndexUrl, image }, null, 2)}\n`,
  'utf8',
)
await rename(temporaryManifest, manifestPath)
console.log(JSON.stringify({ instanceId, image, context }, null, 2))

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function run(command, commandArgs) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    })
    if (result.stdout) {
      process.stdout.write(result.stdout)
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('\n')
    if (output) {
      process.stderr.write(`${output}\n`)
    }
    throw error
  }
}

function environmentSpec(input) {
  if (input.repo === 'astropy/astropy' && input.version === '4.3') {
    const packages = [
      'setuptools==68.0.0',
      'extension-helpers',
      'setuptools_scm>=6.2',
      'wheel',
      'cython==0.29.22',
      'attrs==23.1.0',
      'exceptiongroup==1.1.3',
      'execnet==2.0.2',
      'hypothesis==6.82.6',
      'iniconfig==2.0.0',
      'numpy==1.25.2',
      'packaging==23.1',
      'pluggy==1.3.0',
      'psutil==5.9.5',
      'pyerfa==2.0.0.3',
      'pytest-arraydiff==0.5.0',
      'pytest-astropy-header==0.2.2',
      'pytest-astropy==0.10.0',
      'pytest-cov==4.1.0',
      'pytest-doctestplus==1.0.0',
      'pytest-filter-subpackage==0.1.2',
      'pytest-mock==3.11.1',
      'pytest-openfiles==0.5.0',
      'pytest-remotedata==0.4.0',
      'pytest-xdist==3.3.1',
      'pytest==7.4.0',
      'PyYAML==6.0.1',
      'sortedcontainers==2.4.0',
      'tomli==2.0.1',
    ]
    return {
      // The floating slim tag now uses Debian trixie/GCC 14, which rejects
      // Astropy 4.3's generated C code. Keep this legacy task on GCC 10.
      baseImage: 'python:3.9-slim-bullseye',
      steps: [
        `python -m pip install --no-cache-dir --retries 10 --timeout 60 ${packages.join(' ')}`,
        // Backslashes are required by the nested shell and Python string literals.
        // eslint-disable-next-line no-useless-escape
        `python -c "from pathlib import Path; p=Path('pyproject.toml'); s=p.read_text(); p.write_text(s.replace('requires = [\\\"setuptools\\\",', 'requires = [\\\"setuptools==68.0.0\\\",'))"`,
        "python -m pip install --no-cache-dir --retries 10 --timeout 60 -e '.[test]' --verbose",
      ],
    }
  }
  return {
    baseImage: 'python:3.11-slim',
    steps: [
      'python -m pip install --upgrade pip',
      'if [ -f requirements.txt ]; then python -m pip install -r requirements.txt; fi',
      'if [ -f requirements-dev.txt ]; then python -m pip install -r requirements-dev.txt; fi',
      "if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then python -m pip install -e '.[test]' || python -m pip install -e .; fi",
      'python -m pip install pytest',
    ],
  }
}
