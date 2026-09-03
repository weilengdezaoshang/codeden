import { z } from 'zod'

export const ProjectFactsSchema = z.object({
  root: z.string().min(1),
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'unknown']),
  hasPackageJson: z.boolean(),
  scripts: z.object({
    test: z.string().optional(),
    typecheck: z.string().optional(),
    build: z.string().optional(),
    lint: z.string().optional(),
  }),
  git: z.object({
    available: z.boolean(),
    dirty: z.boolean(),
  }),
})

export type ProjectFacts = z.infer<typeof ProjectFactsSchema>
