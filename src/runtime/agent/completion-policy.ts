import type { AgentRunContext } from '../../eval/ports/agent.port.js'
import type { AgentSubmission } from '../../eval/domain/agent-submission.js'

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
