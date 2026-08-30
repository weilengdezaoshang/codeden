import type { EvalCandidate } from './eval-candidate.js'

export interface CandidateEvidenceCheck {
  id: string
  passed: boolean
  message: string
}

export interface CandidateEvidenceVerification {
  passed: boolean
  checks: CandidateEvidenceCheck[]
}

/**
 * Trust boundary for privacy scanning, fixture hashing, deterministic reproduction and human review.
 * Implementations must verify authoritative receipts instead of trusting fields on EvalCandidate.
 */
export interface CandidateEvidenceVerifier {
  verify(candidate: EvalCandidate, receipt: unknown): Promise<CandidateEvidenceVerification>
}
