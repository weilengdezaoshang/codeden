import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
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
import type { CandidateEvidenceVerifier } from './candidate-evidence-verifier.js'

const DIRECTORY = path.join('.codeden', 'evals', 'candidates')

export class CandidateDatasetStore {
  private pendingOperation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly projectRoot: string,
    private readonly evidenceVerifier: CandidateEvidenceVerifier,
  ) {}

  async promote(input: EvalCandidate, receipt: unknown): Promise<CandidateGateDecision> {
    return this.serialize(() =>
      this.withWriteLock(async () => {
        const candidate = parseEvalCandidate(input)
        const records = await this.listRecords()
        const decision = evaluateCandidateGate(
          candidate,
          new Set(records.map((record) => record.fingerprint)),
        )
        const evidence = await this.evidenceVerifier.verify(candidate, receipt)
        decision.checks.push({
          id: 'evidence.verified',
          passed: evidence.passed && evidence.checks.length > 0,
          blocking: true,
          message: '候选必须具有可验证的审核凭证',
        })
        decision.checks.push(
          ...evidence.checks.map((item) => ({
            ...item,
            id: `evidence.${item.id}`,
            blocking: true,
          })),
        )
        if (
          !evidence.passed ||
          evidence.checks.length === 0 ||
          evidence.checks.some((check) => !check.passed)
        ) {
          decision.status = 'rejected'
        }
        const idUnique = !records.some(
          (record) => record.id === candidate.id || record.evalCase.id === candidate.evalCase.id,
        )
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
          await this.write(candidate, receipt)
        }
        return decision
      }),
    )
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
        const record = JSON.parse(
          await readFile(path.join(this.projectRoot, DIRECTORY, entry.name), 'utf8'),
        ) as Record<string, unknown>
        const { receipt, ...data } = record
        const candidate = parseEvalCandidate(data)
        const evidence = await this.evidenceVerifier.verify(candidate, receipt)
        if (
          candidate.id !== id ||
          !evidence.passed ||
          evidence.checks.length === 0 ||
          evidence.checks.some((check) => !check.passed) ||
          evaluateCandidateGate(candidate, new Set(records.map((item) => item.fingerprint)))
            .status !== 'accepted' ||
          records.some((item) => item.evalCase.id === candidate.evalCase.id)
        ) {
          throw invalidRecord(entry.name)
        }
        records.push(candidate)
      } catch (error) {
        throw invalidRecord(entry.name, error)
      }
    }
    return records
  }

  private async write(candidate: EvalCandidate, receipt: unknown): Promise<void> {
    await this.assertSafeCandidatePath(candidate.id)
    const directory = path.join(this.projectRoot, DIRECTORY)
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, `${candidate.id}.json`)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ ...candidate, receipt }, null, 2)}\n`, {
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

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const relativeLock = path.join('.codeden', 'evals', 'candidates.lock')
    await assertSafeRelativePath(this.projectRoot, relativeLock)
    const lock = path.join(this.projectRoot, relativeLock)
    await mkdir(path.dirname(lock), { recursive: true })
    await mkdir(lock, { mode: 0o700 })
    try {
      return await operation()
    } finally {
      await rmdir(lock)
    }
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
