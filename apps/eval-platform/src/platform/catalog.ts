import { ConfigLoader } from '@codeden/core/config/config-loader.js'
import { contentDigest } from '@codeden/core/content-digest.js'
import { createSecurityServices } from '@codeden/core/security/security-services.js'
import { ProviderRegistry } from '@codeden/agent-runtime/models/provider-registry.js'
import { ModelProviderFactory } from '@codeden/agent-runtime/models/model-provider-factory.js'
import { createModelProvider } from '@codeden/agent-runtime/models/create-model-provider.js'
import { finalText } from '@codeden/agent-runtime/models/mock-model-provider.js'
import { createEvalMockProvider } from '@codeden/eval-engine/adapters/agents/eval-mock-provider.js'
import { createRunEvidence } from '@codeden/eval-engine/optimization/run-evidence.js'
import type { EvalCase } from '@codeden/eval-engine/domain/eval-case.js'
import type { CreateJobInput, CatalogDataset, CatalogView } from './contracts.js'
import { PlatformError } from './contracts.js'
import type { BenchmarkRunSnapshot, JobSnapshot } from './schema.js'
import {
  createDefaultRegistrations,
  indexRegistrations,
  isExtendedBenchmark,
  type ReviewedDatasetSource,
} from './dataset-registry.js'
export type { ReviewedDatasetSource } from './dataset-registry.js'
import { repeatCases } from './catalog-cases.js'

/**
 * 评测目录：数据集描述符全部来自 dataset-registry 注册表（M6）。
 * catalog 只负责装配：目录视图拼装、冻结快照组装与模型解析。
 */

export class EvalCatalog {
  private readonly registryContext: { reviewedSource?: ReviewedDatasetSource } = {}
  private readonly registrations = indexRegistrations(
    createDefaultRegistrations(this.registryContext),
  )
  private viewPromise: Promise<CatalogView> | undefined

  constructor(
    readonly root: string,
    readonly enableRealModels = false,
  ) {}

  /** 注入人工审核数据集来源（由装配层接 TraceStore，避免 catalog 反向依赖存储）。 */
  setReviewedDatasetSource(source: ReviewedDatasetSource) {
    this.registryContext.reviewedSource = source
    this.viewPromise = undefined
    return this
  }

  async view(): Promise<CatalogView> {
    this.viewPromise ??= this.loadView()
    return this.viewPromise
  }

  private async loadView(): Promise<CatalogView> {
    const models: CatalogView['models'] = [{ id: 'mock', name: 'Mock', synthetic: true }]
    if (this.enableRealModels) {
      try {
        const { config } = await this.model('configured')
        models.push({
          id: 'configured',
          name: `${config!.agent.defaultProvider} / ${config!.providers[config!.agent.defaultProvider]!.defaultModel}`,
          synthetic: false,
        })
      } catch {
        // Catalog remains usable when only the mock provider is configured.
      }
    }
    const datasets: CatalogDataset[] = []
    for (const registration of this.registrations.values()) {
      const view = await registration.view()
      datasets.push({
        id: registration.id,
        family: registration.family,
        name: view.name,
        description: view.description,
        count: view.count,
        cases: view.cases,
        ...((view.license ?? registration.license)
          ? { license: view.license ?? registration.license }
          : {}),
        ...((view.version ?? registration.version)
          ? { version: view.version ?? registration.version }
          : {}),
      })
    }
    return { datasets, models }
  }

  async snapshot(input: CreateJobInput): Promise<JobSnapshot> {
    const datasetIds = input.datasetIds ?? [input.datasetId]
    if (datasetIds.length > 1 && input.caseIds) {
      throw new PlatformError(
        400,
        'CASES_MULTI_DATASET_UNSUPPORTED',
        '并行选择多个评测集时暂不支持指定题目。',
      )
    }
    const snapshots = await Promise.all(
      datasetIds.map((datasetId) =>
        this.snapshotSingle({
          ...input,
          datasetId,
          datasetIds: undefined,
          caseIds: datasetIds.length > 1 ? undefined : input.caseIds,
        }),
      ),
    )
    const primary = snapshots[0]!
    return {
      ...primary,
      datasetName: snapshots.map((snapshot) => snapshot.datasetName).join(' + '),
      cases: snapshots.flatMap((snapshot) => snapshot.cases),
      ...(snapshots.length > 1 ? { benchmarkRuns: snapshots.map(toBenchmarkRunSnapshot) } : {}),
    }
  }

  private async snapshotSingle(input: CreateJobInput): Promise<JobSnapshot> {
    if (input.modelId === 'configured' && !input.allowPaid) {
      throw new PlatformError(400, 'PAID_CONSENT_REQUIRED', '请先确认本次评测会消耗真实模型额度。')
    }
    const catalog = await this.view()
    const dataset = catalog.datasets.find((item) => item.id === input.datasetId)
    if (!dataset) {
      throw new PlatformError(400, 'DATASET_NOT_FOUND', '评测集不存在。')
    }
    if (dataset.count === 0) {
      throw new PlatformError(400, 'DATASET_NOT_IMPORTED', `${dataset.name} 尚未导入。`)
    }
    const model = await this.model(input.modelId)
    const registration = this.registrations.get(input.datasetId)
    if (!registration) {
      throw new PlatformError(400, 'DATASET_NOT_FOUND', '评测集不存在。')
    }
    const loaded = await registration.snapshot({
      selectedIds: input.caseIds,
      root: this.root,
      model: model.provider,
      reviewedSource: this.registryContext.reviewedSource,
    })
    let cases: EvalCase[] = loaded.cases
    if (cases.length === 0) {
      throw new PlatformError(400, 'CASES_REQUIRED', '至少选择一道题目。')
    }
    cases = repeatCases(cases, input.repetitions)
    const extended = isExtendedBenchmark(loaded.benchmarkName ?? '')
    const maxTimeoutMs = extended ? 300_000 : 60_000
    const maxTurns = extended ? 30 : 16
    const maxToolCalls = extended ? 80 : 32
    if (
      cases.some(
        (item) =>
          item.limits.timeoutMs > maxTimeoutMs ||
          item.limits.maxTurns > maxTurns ||
          item.limits.maxToolCalls > maxToolCalls,
      )
    ) {
      throw new PlatformError(400, 'DATASET_LIMIT', '评测集的执行上限超过当前平台限制。')
    }
    return {
      datasetName: dataset.name,
      datasetId: input.datasetId,
      modelName: catalog.models.find((item) => item.id === input.modelId)?.name ?? input.modelId,
      cases,
      benchmarkName: loaded.benchmarkName as JobSnapshot['benchmarkName'],
      harnessType: registration.harnessType,
      ...(loaded.version ? { benchmarkVersion: loaded.version } : {}),
      ...(loaded.license ? { benchmarkLicense: loaded.license } : {}),
      ...(loaded.sha256 ? { benchmarkSha256: loaded.sha256 } : {}),
      ...(loaded.benchmarkName === 'native'
        ? { evidence: loaded.evidence ?? (await createRunEvidence(cases, model.provider)) }
        : {}),
      modelConfigDigest: model.configDigest,
    }
  }

  async model(id: CreateJobInput['modelId'], textOnly = false) {
    const security = createSecurityServices()
    if (id === 'mock') {
      return {
        security,
        provider: textOnly
          ? createModelProvider('mock', { mockSteps: [finalText('已完成任务，请运行测试验证。')] })
          : createEvalMockProvider(),
        config: undefined,
        configDigest: contentDigest({ model: 'mock', version: 1 }),
      }
    }
    if (!this.enableRealModels) {
      throw new PlatformError(400, 'MODEL_DISABLED', '服务端尚未启用真实模型。')
    }
    const config = await new ConfigLoader().load(this.root)
    const provider = new ProviderRegistry(
      new ModelProviderFactory(security.resolver),
    ).createFromConfig(config)
    return {
      security,
      provider,
      config,
      configDigest: contentDigest({
        agent: config.agent,
        provider: config.providers[config.agent.defaultProvider],
      }),
    }
  }
}

function toBenchmarkRunSnapshot(snapshot: JobSnapshot): BenchmarkRunSnapshot {
  return {
    datasetId: snapshot.datasetId,
    datasetName: snapshot.datasetName,
    benchmarkName: snapshot.benchmarkName,
    harnessType: snapshot.harnessType,
    ...(snapshot.benchmarkVersion ? { benchmarkVersion: snapshot.benchmarkVersion } : {}),
    ...(snapshot.benchmarkLicense ? { benchmarkLicense: snapshot.benchmarkLicense } : {}),
    ...(snapshot.benchmarkSha256 ? { benchmarkSha256: snapshot.benchmarkSha256 } : {}),
    cases: snapshot.cases,
    ...(snapshot.evidence ? { evidence: snapshot.evidence } : {}),
  }
}
