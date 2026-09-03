import { handlePlatformRequest } from '@codeden/eval-platform/platform/http.js'
import { getPlatform } from '@/server/platform'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
function handle(request: Request) {
  return handlePlatformRequest(
    request,
    getPlatform,
    process.env.CODEDEN_EVAL_ORIGIN ?? 'http://127.0.0.1:3210',
  )
}
export { handle as GET, handle as POST }
