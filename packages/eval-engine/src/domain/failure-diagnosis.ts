import { z } from 'zod'
import { RunEventSourceSchema, type RunEvent } from '@codeden/core/events/run-event.js'

export const FailureLayerSchema = z.enum([
  'dataset',
  'infrastructure',
  'workspace',
  'prompt',
  'model',
  'tool',
  'runtime',
  'agent',
  'verifier',
  'judge',
])

export type FailureLayer = z.infer<typeof FailureLayerSchema>

export const FailureStageSchema = z.enum([
  'setup',
  'instruction_loading',
  'prompt_composition',
  'model_generation',
  'tool_execution',
  'submission',
  'verification',
  'evaluation',
  'unknown',
])

export type FailureStage = z.infer<typeof FailureStageSchema>

export const FailureEvidenceRefSchema = z.object({
  runId: z.string().min(1),
  trialId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  source: RunEventSourceSchema,
  type: z.string().min(1),
})

export type FailureEvidenceRef = z.infer<typeof FailureEvidenceRefSchema>

export const FailureDiagnosisSchema = z.object({
  layer: FailureLayerSchema,
  stage: FailureStageSchema,
  rootCause: z.string().min(1),
  suggestion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(FailureEvidenceRefSchema),
})

export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>

/** Creates a stable, secret-free reference to an event used by a diagnosis. */
export function toEvidenceRef(event: RunEvent): FailureEvidenceRef {
  return {
    runId: event.runId,
    trialId: event.trialId,
    sequence: event.sequence,
    source: event.source,
    type: event.type,
  }
}
