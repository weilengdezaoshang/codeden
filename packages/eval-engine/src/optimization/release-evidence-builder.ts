import { contentDigest } from '@codeden/core/content-digest.js'
import { parseEvalRun, type EvalRun, type RunEvidence } from '../domain/eval-run.js'
import { isTrialResolved, parseTrialResult, type TrialResult } from '../domain/trial-result.js'
import type { EvalRepository } from '../ports/eval-repository.port.js'
import { parseReleaseEvidence, type ReleaseEvidence } from './release-gate.js'
import { evidenceCaseDigests } from './evidence-case-digests.js'

/** 从本地评测仓库重建统计，不接受调用方传入的通过数、Token 总量或手填摘要。 */
export async function loadReleaseEvidence(
  repository: EvalRepository,
  runIds: readonly string[],
  agentVersion: string,
) {
  const runs = await Promise.all(
    runIds.map(async (id) => {
      const run = await repository.getRun(id)
      if (!run || run.runId !== id) {
        throw new Error(`未找到评测运行：${id}`)
      }
      return { run, trials: await repository.listTrials(id) }
    }),
  )
  return buildReleaseEvidenceFromRuns({ agentVersion, runs })
}

export function buildReleaseEvidenceFromRuns(input: {
  agentVersion: string
  runs: readonly { run: EvalRun; trials: readonly TrialResult[] }[]
}): ReleaseEvidence {
  if (!input.runs.length) {
    throw new Error('缺少评测运行')
  }
  const runs = input.runs.map(({ run, trials }) => ({
    run: parseEvalRun(run),
    trials: trials.map(parseTrialResult),
  }))
  const first = runs[0]!.run.evidence
  if (!first) {
    throw new Error('评测运行缺少执行时记录的证据清单')
  }
  const allCaseIds = new Set<string>()
  const runIds = new Set<string>()
  const trialIds = new Set<string>()
  const suiteResults = new Map<
    string,
    { name: string; passed: number; cases: Array<{ id: string; digest: string }> }
  >()
  let infrastructureFailures = 0,
    totalTokens = 0,
    requests = 0,
    measured = 0
  const latencies: number[] = []
  const cases: RunEvidence['cases'] = []
  let collectionComplete = true
  for (const { run, trials } of runs) {
    const evidence = run.evidence
    if (run.status !== 'completed' || !evidence || runIds.has(run.runId)) {
      throw new Error('运行未完成、重复或缺少证据')
    }
    runIds.add(run.runId)
    if (
      evidence.agentDigest !== first.agentDigest ||
      evidence.environmentDigest !== first.environmentDigest
    ) {
      throw new Error('同一版本的运行必须使用相同 Agent 和环境')
    }
    if (
      trials.length !== run.caseIds.length ||
      evidence.cases.length !== run.caseIds.length ||
      new Set(run.caseIds).size !== run.caseIds.length
    ) {
      throw new Error('运行样本覆盖不完整')
    }
    const digests = evidenceCaseDigests(evidence.cases)
    if (
      digests.datasetDigest !== evidence.datasetDigest ||
      digests.graderDigest !== evidence.graderDigest
    ) {
      throw new Error('运行摘要与逐样本证据矛盾')
    }
    cases.push(...evidence.cases)
    for (const trial of trials) {
      const entry = evidence.cases.find((item) => item.id === trial.caseId)
      if (
        trial.runId !== run.runId ||
        !entry ||
        !run.caseIds.includes(trial.caseId) ||
        allCaseIds.has(trial.caseId) ||
        trialIds.has(trial.trialId)
      ) {
        throw new Error('试验归属错误或样本重复')
      }
      allCaseIds.add(trial.caseId)
      trialIds.add(trial.trialId)
      const validResolved = isTrialResolved(trial)
      if (trial.resolved !== validResolved) {
        throw new Error('试验通过状态与执行证据矛盾')
      }
      const suite = suiteResults.get(entry.suite) ?? { name: entry.suite, passed: 0, cases: [] }
      suite.cases.push({ id: entry.id, digest: entry.digest })
      if (validResolved) {
        suite.passed++
      }
      suiteResults.set(entry.suite, suite)
      infrastructureFailures += trial.infrastructure.status === 'ok' ? 0 : 1
      totalTokens += trial.metrics.inputTokens + trial.metrics.outputTokens
      requests += trial.metrics.modelRequests
      const usage = trial.metrics.tokenUsage
      if (usage) {
        collectionComplete &&= usage.collectionComplete !== false
        measured += usage.measuredRequests
      }
      latencies.push(trial.metrics.durationMs)
    }
  }
  latencies.sort((a, b) => a - b)
  return parseReleaseEvidence({
    schemaVersion: 1,
    provenance: 'eval-runner',
    sourceRunIds: [...runIds],
    agentVersion: input.agentVersion,
    agentDigest: first.agentDigest,
    environmentDigest: first.environmentDigest,
    ...evidenceCaseDigests(cases),
    suites: [...suiteResults.values()].map((suite) => ({
      name: suite.name,
      total: suite.cases.length,
      passed: suite.passed,
      caseSetDigest: contentDigest(suite.cases.sort((a, b) => (a.id < b.id ? -1 : 1))),
    })),
    infrastructureFailures,
    totalTokens,
    tokenUsageCoverage: requests && collectionComplete ? measured / requests : 0,
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
  })
}
