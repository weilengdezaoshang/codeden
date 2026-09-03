import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const PATTERNS = [
  { name: 'openai-or-deepseek-key', regex: /sk-[A-Za-z0-9]{16,}/ },
  { name: 'xai-key', regex: /xai-[A-Za-z0-9]{16,}/ },
  { name: 'sentinel', regex: /codeden-secret-must-never-appear/ },
]

const SKIP = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.map', '.lock'])
const SKIP_NAMES = new Set(['pnpm-lock.yaml', 'scan-secrets.mjs'])

const files = collectFiles()
const hits = []

for (const file of files) {
  if (
    SKIP.has(extname(file)) ||
    file.endsWith('.md') ||
    SKIP_NAMES.has(file.split('/').pop() ?? '')
  ) {
    continue
  }
  let text
  try {
    if (statSync(file).size > 1_000_000) {
      continue
    }
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const rule of PATTERNS) {
    if (rule.regex.test(text)) {
      hits.push(`${file}: ${rule.name}`)
    }
  }
}

if (hits.length > 0) {
  console.error('Secret scan failed:')
  for (const hit of hits) {
    console.error(`  ${hit}`)
  }
  process.exit(1)
}

console.log(`Secret scan passed (${files.length} files)`)

function collectFiles() {
  const fromGit = new Set()
  try {
    const staged = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
      {
        encoding: 'utf8',
      },
    )
    const worktree = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
    for (const line of `${staged}\0${worktree}`.split('\0')) {
      if (line) {
        fromGit.add(line)
      }
    }
  } catch {
    return []
  }
  return [...fromGit]
}
