import { z } from 'zod'

const safeSegment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)

export const DatasetManifestSchema = z.object({
  name: safeSegment,
  version: safeSegment,
  license: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  fetchedAt: z.string().datetime(),
  fileName: safeSegment,
})

export type DatasetManifest = z.infer<typeof DatasetManifestSchema>
