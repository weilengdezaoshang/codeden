import { z } from 'zod'
import { parseWithSchema } from '../../core/errors/codeden-error.js'

export const AgentSubmissionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('files'),
    changedPaths: z.array(z.string()),
  }),
  z.object({
    type: z.literal('text'),
    content: z.string(),
  }),
  z.object({
    type: z.literal('git-patch'),
    artifactId: z.string(),
  }),
])

export type AgentSubmission = z.infer<typeof AgentSubmissionSchema>

export function parseAgentSubmission(input: unknown): AgentSubmission {
  return parseWithSchema(AgentSubmissionSchema, input, 'Invalid AgentSubmission')
}
