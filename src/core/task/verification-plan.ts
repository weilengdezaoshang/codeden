import { z } from 'zod'
import { parseWithSchema } from '../errors/codeden-error.js'

export const VerificationStepKindSchema = z.enum([
  'diff',
  'test',
  'typecheck',
  'lint',
  'build',
  'command',
])

export const VerificationStepSchema = z
  .object({
    id: z.string().min(1),
    kind: VerificationStepKindSchema,
    command: z.string().trim().min(1).optional(),
    source: z.enum(['system', 'project', 'user', 'legacy']).default('project'),
    required: z.boolean().default(true),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60_000)
      .default(30_000),
  })
  .superRefine((step, context) => {
    if (step.kind !== 'diff' && !step.command) {
      context.addIssue({ code: 'custom', path: ['command'], message: 'Command is required' })
    }
    if (step.kind === 'diff' && step.command) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'Diff step cannot run a command',
      })
    }
  })

const RawVerificationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    steps: z.array(VerificationStepSchema).default([]),
  })
  .superRefine((plan, context) => {
    const ids = plan.steps.map((step) => step.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['steps'], message: 'Step ids must be unique' })
    }
    const diffSteps = plan.steps.filter((step) => step.kind === 'diff')
    if (diffSteps.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Only one diff step is allowed',
      })
    }
    if (diffSteps.some((step) => !step.required)) {
      context.addIssue({ code: 'custom', path: ['steps'], message: 'Diff step must be required' })
    }
    if (diffSteps.length === 0 && ids.includes('workspace-diff')) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'workspace-diff is reserved for the system diff step',
      })
    }
  })

export const VerificationPlanSchema = RawVerificationPlanSchema.transform((plan) =>
  plan.steps.some((step) => step.kind === 'diff')
    ? plan
    : {
        ...plan,
        steps: [
          {
            id: 'workspace-diff',
            kind: 'diff' as const,
            source: 'system' as const,
            required: true,
            timeoutMs: 30_000,
          },
          ...plan.steps,
        ],
      },
)

export type VerificationPlan = z.infer<typeof VerificationPlanSchema>
export type VerificationStep = z.infer<typeof VerificationStepSchema>
export type CommandVerificationStep = VerificationStep & { command: string }

export function parseVerificationPlan(input: unknown): VerificationPlan {
  return parseWithSchema(VerificationPlanSchema, input, 'Invalid verification plan')
}

export function verificationPlanFromCommands(
  commands: readonly string[],
  options: {
    source?: VerificationStep['source']
    kind?: Exclude<VerificationStep['kind'], 'diff'>
    idPrefix?: string
  } = {},
): VerificationPlan {
  const source = options.source ?? 'legacy'
  const kind = options.kind ?? 'command'
  const idPrefix = options.idPrefix ?? `${source}-${kind}`
  return parseVerificationPlan({
    schemaVersion: 1,
    steps: commands.map((command, index) => ({
      id: `${idPrefix}-${index + 1}`,
      kind,
      command,
      source,
      required: true,
      timeoutMs: 30_000,
    })),
  })
}

export function commandVerificationSteps(plan: VerificationPlan): CommandVerificationStep[] {
  return plan.steps.filter(
    (step): step is CommandVerificationStep => step.kind !== 'diff' && step.command !== undefined,
  )
}
