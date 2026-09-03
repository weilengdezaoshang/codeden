'use client'

import DiffViewer from 'react-diff-viewer-continued'

export type FileDiff = {
  path: string
  before: string
  after: string
  binary?: boolean
}

function languageFor(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'json') {
return 'json'
}
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') {
return 'javascript'
}
  if (extension === 'ts' || extension === 'tsx') {
return 'typescript'
}
  if (extension === 'css') {
return 'css'
}
  if (extension === 'html') {
return 'markup'
}
  if (extension === 'md') {
return 'markdown'
}
  if (extension === 'yml' || extension === 'yaml') {
return 'yaml'
}
  return undefined
}

export function FileDiffViewer({ diff }: { diff: FileDiff }) {
  if (diff.binary) {
    return <div className="diff-binary">二进制文件或文件过大，已记录路径但不展示内容。</div>
  }
  return (
    <div className="diff-viewer">
      <DiffViewer
        oldValue={diff.before}
        newValue={diff.after}
        splitView
        leftTitle={`修改前 · ${diff.path}`}
        rightTitle={`修改后 · ${diff.path}`}
        highlightLanguage={languageFor(diff.path)}
        extraLinesSurroundingDiff={3}
        disableWorker
      />
    </div>
  )
}

export function FileDiffList({ diffs }: { diffs: FileDiff[] | undefined }) {
  if (!diffs?.length) {
    return <div className="empty-diff">本次 Trial 没有可展示的文件变化。</div>
  }
  return (
    <div className="diff-list">
      {diffs.map((diff) => (
        <details className="diff-file" key={diff.path} open>
          <summary>
            <code>{diff.path}</code>
            <span>{diff.binary ? '不可预览' : '双栏 Diff'}</span>
          </summary>
          <FileDiffViewer diff={diff} />
        </details>
      ))}
    </div>
  )
}
