import { z } from 'zod'

const jsonStringArray = z.string().transform((value, context): string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    return z.array(z.string()).parse(parsed)
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a JSON-encoded string array' })
    return z.NEVER
  }
})

const testList = z.union([z.array(z.string()), jsonStringArray]).default([])

export const SweBenchRecordSchema = z.object({
  instance_id: z.string().min(1),
  repo: z.string().min(1),
  base_commit: z.string().min(1),
  problem_statement: z.string().min(1),
  hints_text: z.string().default(''),
  created_at: z.string().optional(),
  patch: z.string().default(''),
  test_patch: z.string().default(''),
  version: z.string().default('unknown'),
  FAIL_TO_PASS: testList,
  PASS_TO_PASS: testList,
  environment_setup_commit: z.string().optional(),
})

export type SweBenchRecord = z.infer<typeof SweBenchRecordSchema>
