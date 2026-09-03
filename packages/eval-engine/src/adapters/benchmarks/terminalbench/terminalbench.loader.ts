import { access, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export interface TerminalBenchTask {
  id: string
  title: string
  path: string
  instruction: string
  verifierScript: string
  environmentDir: string
  testsDir: string
  environmentImage?: string
}

export async function loadTerminalBenchTasks(root: string): Promise<TerminalBenchTask[]> {
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) {
    throw new Error('Terminal-Bench dataset must be a directory')
  }
  if (await exists(path.join(root, 'instruction.md'))) {
    return [await loadTask(root)]
  }
  const entries = await readdir(root, { withFileTypes: true })
  const tasks = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }
    if (await exists(path.join(root, entry.name, 'instruction.md'))) {
      tasks.push(await loadTask(path.join(root, entry.name)))
    }
  }
  if (tasks.length === 0) {
    throw new Error('Terminal-Bench dataset does not contain task directories')
  }
  return tasks
}

async function loadTask(taskPath: string): Promise<TerminalBenchTask> {
  const instruction = (await readFile(path.join(taskPath, 'instruction.md'), 'utf8')).trim()
  if (!instruction) {
    throw new Error(`Terminal-Bench task has empty instruction: ${taskPath}`)
  }
  const environmentDir = path.join(taskPath, 'environment')
  await access(path.join(environmentDir, 'Dockerfile'))
  const environmentImage = await readDockerImage(path.join(taskPath, 'task.toml'))
  const testsDir = path.join(taskPath, 'tests')
  const verifierScript = (await exists(path.join(testsDir, 'test.sh')))
    ? path.join(testsDir, 'test.sh')
    : (await exists(path.join(taskPath, 'run-tests.sh')))
      ? path.join(taskPath, 'run-tests.sh')
      : undefined
  if (!verifierScript) {
    throw new Error(`Terminal-Bench task has no verifier script: ${taskPath}`)
  }
  return {
    id: path.basename(taskPath),
    title: firstLine(instruction),
    path: taskPath,
    instruction,
    verifierScript: path.relative(taskPath, verifierScript),
    environmentDir,
    testsDir,
    ...(environmentImage ? { environmentImage } : {}),
  }
}

async function readDockerImage(taskToml: string) {
  try {
    const value = await readFile(taskToml, 'utf8')
    const match = value.match(/^\s*docker_image\s*=\s*"([^"]+)"/mu)
    return match?.[1]
  } catch {
    return undefined
  }
}

async function exists(filePath: string) {
  return access(filePath).then(
    () => true,
    () => false,
  )
}

function firstLine(value: string) {
  const line =
    value
      .split(/\r?\n/u)
      .find((item) => item.trim())
      ?.trim() ?? '未命名任务'
  return line.length > 100 ? `${line.slice(0, 97)}…` : line
}
