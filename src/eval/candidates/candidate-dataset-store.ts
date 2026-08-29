import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CodeDenError } from '../../core/errors/codeden-error.js'
import { ErrorCodes } from '../../core/errors/error-codes.js'
import { assertSafeRelativePath } from '../../runtime/workspace/workspace-boundary.js'
import type { EvalCase } from '../domain/eval-case.js'
import {
  evaluateCandidateGate,
  parseEvalCandidate,
  type CandidateGateDecision,
  type EvalCandidate,
} from './eval-candidate.js'

const DIRECTORY = path.join('.codeden', 'evals', 'candidates')

export class CandidateDatasetStore {
  private pendingOperation: Promise<unknown> = Promise.resolve()

  constructor(private readonly projectRoot: string) {}

  async promote(input: EvalCandidate): Promise<CandidateGateDecision> {
    return this.serialize(async () => {
      const candidate = parseEvalCandidate(input)
      const records = await this.listRecords()
      const decision = evaluateCandidateGate(
        candidate,
        new Set(records.map((record) => record.fingerprint)),
      )
      const idUnique = !records.some((record) => record.id === candidate.id)
      decision.checks.push({
        id: 'dataset.id_unique',
        passed: idUnique,
        blocking: true,
        message: '候选编号不得覆盖现有评测样本',
      })
      if (!idUnique) {
        decision.status = 'rejected'
      }
      if (decision.status === 'accepted') {
        await this.write(candidate)
      }
      return decision
    })
  }

  async listCases(): Promise<EvalCase[]> {
    return this.serialize(async () =>
      (await this.listRecords()).map((candidate) => structuredClone(candidate.evalCase)),
    )
  }

  private async listRecords(): Promise<EvalCandidate[]> {
    let entries
    try {
      await assertSafeRelativePath(this.projectRoot, DIRECTORY)
      entries = await readdir(path.join(this.projectRoot, DIRECTORY), { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }

    const records: EvalCandidate[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      const id = entry.name.slice(0, -'.json'.length)
      try {
        await this.assertSafeCandidatePath(id)
        records.push(
          parseEvalCandidate(
            JSON.parse(
              await readFile(path.join(this.projectRoot, DIRECTORY, entry.name), 'utf8'),
            ) as unknown,
          ),
        )
      } catch (error) {
        throw invalidRecord(entry.name, error)
      }
    }
    return records
  }

  private async write(candidate: EvalCandidate): Promise<void> {
    await this.assertSafeCandidatePath(candidate.id)
    const directory = path.join(this.projectRoot, DIRECTORY)
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, `${candidate.id}.json`)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      await link(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async assertSafeCandidatePath(id: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
      throw invalidRecord(`${id}.json`)
    }
    await assertSafeRelativePath(this.projectRoot, path.join(DIRECTORY, `${id}.json`))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pendingOperation.then(operation)
    this.pendingOperation = run.catch(() => undefined)
    return run
  }
}

function invalidRecord(file: string, cause?: unknown): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.INTERNAL_INVARIANT_VIOLATION,
    category: 'internal',
    message: `Invalid candidate dataset record: ${file}`,
    retryable: false,
    details: cause instanceof Error ? { cause: cause.message } : undefined,
  })
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
