import path from 'node:path'

export const CONFIG_RELATIVE_PATH = path.join('.codeden', 'config.yaml')

export function locateProjectConfig(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, CONFIG_RELATIVE_PATH)
}

export function candidateConfigPaths(
  workspaceRoot: string,
  extraSearchRoots: string[] = [],
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  const add = (candidate: string) => {
    if (!seen.has(candidate)) {
      seen.add(candidate)
      paths.push(candidate)
    }
  }

  add(locateProjectConfig(workspaceRoot))

  for (const root of extraSearchRoots) {
    let dir = path.resolve(root)
    const { root: fsRoot } = path.parse(dir)
    for (;;) {
      add(path.join(dir, CONFIG_RELATIVE_PATH))
      if (dir === fsRoot) {
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
  }
  return paths
}
