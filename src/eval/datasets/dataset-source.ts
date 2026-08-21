import { z } from 'zod'

const safeSegment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)

export const DatasetSourceSchema = z.object({
  name: safeSegment,
  version: safeSegment,
  url: z.string().url().optional(),
  localPath: z.string().min(1).optional(),
  license: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
})

export type DatasetSource = z.infer<typeof DatasetSourceSchema>
