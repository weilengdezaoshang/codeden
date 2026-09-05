import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { HumanEvalRecordSchema, type HumanEvalRecord } from './humaneval.schema.js'

export async function loadHumanEvalRecords(filePath: string): Promise<HumanEvalRecord[]> {
  const raw = (await readFile(filePath, 'utf8')).trim()
  if (!raw) {
    return []
  }
  if (raw.startsWith('[')) {
    return z.array(HumanEvalRecordSchema).parse(JSON.parse(raw))
  }
  return raw.split(/\r?\n/u).map((line, index) => {
    try {
      return HumanEvalRecordSchema.parse(JSON.parse(line))
    } catch (error) {
      throw new Error(`Invalid HumanEval JSONL record at line ${index + 1}`, { cause: error })
    }
  })
}

/** HumanEval/0 → HumanEval_0；用作目录名与工作区内文件名。 */
export function humanevalSafeId(taskId: string) {
  return taskId.replaceAll('/', '_')
}
