import type { AgentRunContext } from './agent-contracts.js'
import type { AgentSubmission } from '@codeden/core/agent-submission.js'

export async function collectSubmission(
  context: AgentRunContext,
  finalResponse: string,
): Promise<AgentSubmission> {
  if (context.submissionType === 'text') {
    return { type: 'text', content: finalResponse }
  }

  const changedPaths = await context.workspace.changedPaths()
  return { type: 'files', changedPaths }
}
