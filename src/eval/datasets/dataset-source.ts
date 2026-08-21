import { z } from 'zod'

export const DatasetSourceSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url().optional(),
  localPath: z.string().min(1).optional(),
  license: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
})

export type DatasetSource = z.infer<typeof DatasetSourceSchema>
