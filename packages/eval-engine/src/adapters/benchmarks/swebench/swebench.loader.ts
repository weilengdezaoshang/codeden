import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { SweBenchRecordSchema, type SweBenchRecord } from './swebench.schema.js'

export async function loadSweBenchRecords(filePath: string): Promise<SweBenchRecord[]> {
  const raw = await readFile(filePath, 'utf8')
  const trimmed = raw.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    return z.array(SweBenchRecordSchema).parse(JSON.parse(trimmed))
  }

  return trimmed.split(/\r?\n/u).map((line, index) => {
    try {
      return SweBenchRecordSchema.parse(JSON.parse(line))
    } catch (error) {
      throw new Error(`Invalid SWE-bench JSONL record at line ${index + 1}`, { cause: error })
    }
  })
}
