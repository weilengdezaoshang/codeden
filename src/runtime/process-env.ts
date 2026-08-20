export const COMMAND_ENV_WHITELIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HOME',
  'TMPDIR',
] as const

export function pickCommandEnv(
  overrides: { HOME?: string; TMPDIR?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of COMMAND_ENV_WHITELIST) {
    if (key === 'HOME' && overrides.HOME !== undefined) {
      env.HOME = overrides.HOME
      continue
    }
    if (key === 'TMPDIR' && overrides.TMPDIR !== undefined) {
      env.TMPDIR = overrides.TMPDIR
      continue
    }
    if (key === 'HOME') {
      continue
    }
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}
