import { z } from 'zod'
import { publicError } from '@codeden/eval-platform/platform/contracts.js'
import { getPlatform } from '@/server/platform'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }

async function jobId(context: { params: Promise<{ id: string }> }) {
  return z.uuid().parse((await context.params).id)
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(await (await getPlatform()).store.detail(await jobId(context)), {
      headers,
    })
  } catch (error) {
    const safe = publicError(error)
    return Response.json(
      { error: { code: safe.code, message: safe.message } },
      { status: safe.status, headers },
    )
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params
  try {
    await (await getPlatform()).store.delete(await jobId({ params: Promise.resolve(params) }))
    return new Response(null, { status: 204, headers })
  } catch (error) {
    console.error(`[eval-web] DELETE /api/jobs/${params.id} 删除实验记录失败`, {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
    })
    const safe = publicError(error)
    return Response.json(
      { error: { code: safe.code, message: safe.message } },
      { status: safe.status, headers },
    )
  }
}
