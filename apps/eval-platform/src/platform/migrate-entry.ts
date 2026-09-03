import { isEntrypoint } from '@codeden/core/cli/entrypoint.js'
import { connectDatabase, migrateDatabase } from './database.js'
import { platformOptions } from './service.js'

export async function migrate() {
  const { pool, db } = connectDatabase(platformOptions().databaseUrl)
  try {
    await migrateDatabase(db)
    console.log('[eval-platform] 数据库迁移完成')
  } finally {
    await pool.end()
  }
}
if (isEntrypoint(import.meta.url)) {
  migrate().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`[eval-platform] 数据库迁移失败\n${detail}`)
    process.exitCode = 1
  })
}
