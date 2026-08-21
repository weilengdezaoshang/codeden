import { z } from 'zod'

export const DatasetManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  fetchedAt: z.string().datetime(),
  fileName: z.string().min(1),
})

export type DatasetManifest = z.infer<typeof DatasetManifestSchema>
