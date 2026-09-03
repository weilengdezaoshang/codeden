import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { SwePolyBenchRecordSchema, type SwePolyBenchRecord } from './swepolybench.schema.js'

export async function loadSwePolyBenchRecords(filePath: string): Promise<SwePolyBenchRecord[]> {
  const raw = (await readFile(filePath, 'utf8')).trim()
  if (!raw) {
    return []
  }
  if (raw.startsWith('[')) {
    return z.array(SwePolyBenchRecordSchema).parse(JSON.parse(raw))
  }
  return raw.split(/\r?\n/u).map((line, index) => {
    try {
      return SwePolyBenchRecordSchema.parse(JSON.parse(line))
    } catch (error) {
      throw new Error(`Invalid SWE-PolyBench JSONL record at line ${index + 1}`, { cause: error })
    }
  })
}
