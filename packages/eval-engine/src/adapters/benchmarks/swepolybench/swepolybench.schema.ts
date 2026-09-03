import { z } from 'zod'

const stringList = z.union([
  z.array(z.string()),
  z.string().transform((value, context): string[] => {
    try {
      const parsed: unknown = JSON.parse(value)
      return z.array(z.string()).parse(parsed)
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a JSON-encoded string array' })
      return z.NEVER
    }
  }),
])

const optionalStringList = stringList.optional()

/** SWE-PolyBench 的实例格式；保留未知列以兼容不同 split 的附加标注。 */
export const SwePolyBenchRecordSchema = z
  .object({
    instance_id: z.string().min(1),
    repo: z.string().min(1),
    base_commit: z.string().min(1),
    problem_statement: z.string().min(1),
    patch: z.string().default(''),
    test_patch: z.string().default(''),
    language: z.string().min(1),
    Dockerfile: z.string().default(''),
    dockerfile: z.string().optional(),
    test_command: z.string().default(''),
    f2p: optionalStringList,
    p2p: optionalStringList,
    F2P: optionalStringList,
    P2P: optionalStringList,
    FAIL_TO_PASS: optionalStringList,
    PASS_TO_PASS: optionalStringList,
    environment_setup_commit: z.string().optional(),
    version: z.string().default('unknown'),
    hints_text: z.string().default(''),
  })
  .passthrough()

export type SwePolyBenchRecord = z.infer<typeof SwePolyBenchRecordSchema>

export function recordTests(record: SwePolyBenchRecord) {
  return [
    ...(record.f2p ?? record.F2P ?? record.FAIL_TO_PASS ?? []),
    ...(record.p2p ?? record.P2P ?? record.PASS_TO_PASS ?? []),
  ].filter((test, index, tests) => tests.indexOf(test) === index)
}

export function recordDockerfile(record: SwePolyBenchRecord) {
  return record.Dockerfile || record.dockerfile || undefined
}
