import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CandidateDatasetStore } from '../eval/candidates/candidate-dataset-store.js'
import { parseEvalCandidate } from '../eval/candidates/eval-candidate.js'
import { SignedCandidateEvidenceVerifier } from '../eval/candidates/signed-candidate-evidence-verifier.js'
import { JsonlEvalRepository } from '../eval/adapters/repositories/jsonl-eval.repository.js'
import { loadReleaseEvidence } from '../optimization/release-evidence-builder.js'
import { evaluateReleaseGate } from '../optimization/release-gate.js'
import { readFlag, readRepeatedFlag } from './args.js'

export async function runEvalGateCommand(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'candidate-promote') {
      const root = process.cwd()
      const publicKey = await readFile(required(argv, '--trusted-key'), 'utf8')
      const candidate = parseEvalCandidate(await readJson(required(argv, '--candidate')))
      const receipt = await readJson(required(argv, '--receipt'))
      const store = new CandidateDatasetStore(
        root,
        new SignedCandidateEvidenceVerifier(root, publicKey),
      )
      const decision = await store.promote(candidate, receipt)
      console.log(JSON.stringify(decision, null, 2))
      return decision.status === 'accepted' ? 0 : 1
    }
    if (argv[0] !== 'release-check') {
      throw new Error('未知评测门禁命令')
    }
    const repository = new JsonlEvalRepository(
      path.resolve(readFlag(argv, '--results-dir') ?? '.codeden/results'),
    )
    const champion = await loadReleaseEvidence(
      repository,
      readRepeatedFlag(argv, '--champion-run'),
      'champion',
    )
    const challenger = await loadReleaseEvidence(
      repository,
      readRepeatedFlag(argv, '--challenger-run'),
      'challenger',
    )
    const decision = evaluateReleaseGate(champion, challenger)
    console.log(JSON.stringify({ champion, challenger, decision }, null, 2))
    return decision.promote ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : '评测门禁执行失败')
    return 2
  }
}

function required(argv: string[], key: string) {
  const value = readFlag(argv, key)
  if (!value) {
    throw new Error(`缺少参数 ${key}`)
  }
  return value
}
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown
}
