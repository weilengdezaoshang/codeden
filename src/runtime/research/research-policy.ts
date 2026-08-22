export interface ResearchDecision {
  level: 'recommended' | 'required'
  reasons: string[]
}

const REQUIRED_PATTERNS = [
  /\b(latest|current|today|newest|recent|up[- ]to[- ]date|official docs?)\b/iu,
  /(?:最新|当前|目前|今天|近期|官方文档|官网|查资料|搜索资料)/u,
  /\b(?:version|compatib(?:le|ility)|deprecated|breaking change)\b/iu,
  /(?:版本|兼容性?|已弃用|破坏性变更)/u,
]

export class ResearchPolicy {
  assess(prompt: string): ResearchDecision {
    const matched = REQUIRED_PATTERNS.some((pattern) => pattern.test(prompt))
    return matched
      ? {
          level: 'required',
          reasons: [
            'The task depends on current, versioned, compatibility, or explicitly requested documentation.',
          ],
        }
      : {
          level: 'recommended',
          reasons: [
            'Research is required whenever local evidence cannot support a technical claim.',
          ],
        }
  }

  shouldEscalateAfterFailure(message: string): boolean {
    return /(?:unknown api|api.*(?:not found|does not exist)|property .* does not exist|module .* not found|unsupported .* version)/iu.test(
      message,
    )
  }

  instructions(decision: ResearchDecision, searchAvailable: boolean): string[] {
    return [
      `Research policy: ${decision.level}. ${decision.reasons.join(' ')}`,
      'Do not guess current versions, unfamiliar APIs, package behavior, compatibility, or error causes.',
      searchAvailable
        ? 'First inspect local code, manifests, lockfiles, installed types, and command output. If that evidence is insufficient, use search_docs with a concise non-sensitive query, then fetch_url for the relevant official source before making the claim or implementation decision.'
        : 'First inspect local code, manifests, lockfiles, installed types, and command output. Do not make unsupported external claims when documentation research tools are unavailable.',
      'Treat claims from memory as hypotheses until supported by local evidence, official documentation, or successful verification. Mention the source URLs used in the final response.',
    ]
  }
}
