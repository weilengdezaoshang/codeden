import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Logic-only verification of the synthetic prototype; not browser/layout evidence.
const html = readFileSync(new URL('./eval-platform-closed-loop.html', import.meta.url), 'utf8')
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
function harness() {
  const listeners = {}
  const content = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }
  const message = { textContent: '', style: {}, focus() {} }
  const context = vm.createContext({
    console,
    Intl,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    location: { hash: '#history' },
    window: { scrollY: 120, scrollTo() {} },
    document: {
      activeElement: null,
      getElementById: (id) =>
        id === 'content'
          ? content
          : ['announcement', 'page-title', 'history-filter-error'].includes(id)
            ? message
            : null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: (event, fn) => {
        listeners[event] = fn
      },
    },
    createEnvironmentStudio: () => ({ saveInputs() {}, view: () => '' }),
    FormData: class {
      constructor(form) {
        return Object.entries(form.fields)
      }
    },
  })
  vm.runInContext(script, context)
  return {
    get text() {
      return content.innerHTML
    },
    read: (code) => vm.runInContext(code, context),
    click(action, run) {
      const button = { dataset: { action, run: String(run ?? '') } }
      listeners.click({ target: { closest: () => button } })
    },
    query(fields) {
      listeners.submit({
        preventDefault() {},
        target: {
          id: 'history-filters',
          fields: { dataset: 'all', state: 'all', from: '', to: '', id: '', ...fields },
        },
      })
    },
    message,
  }
}

test('历史默认跨集合倒序分页，返回详情保留页码与筛选', () => {
  const app = harness()
  assert.match(app.text, /共 7 次执行/)
  assert.equal((app.text.match(/data-action="history-open"/g) || []).length, 5)
  app.click('history-next')
  assert.match(app.text, /第 2 \/ 2 页/)
  app.click('history-open', 6)
  assert.match(app.text, /历史执行详情/)
  assert.match(app.text, /冻结配置/)
  app.click('history-back')
  assert.match(app.text, /第 2 \/ 2 页/)
  app.query({ state: 'cancelled' })
  assert.match(app.text, /共 1 次执行/)
  app.click('history-open', 3)
  assert.match(app.text, /已取消后续工作/)
  app.click('history-back')
  assert.equal(app.read('historyFilters.state'), 'cancelled')
})

test('编号、集合与日期查询及空结果和无效日期', () => {
  const app = harness()
  app.query({ id: '#01' })
  assert.match(app.text, /共 1 次执行/)
  app.query({ dataset: 'reviewed' })
  assert.match(app.text, /没有匹配的执行记录/)
  app.query({ from: '2026-08-31', to: '2026-08-31' })
  assert.match(app.text, /共 1 次执行/)
  app.query({ from: '2026-08-31', to: '2026-08-01' })
  assert.match(app.message.textContent, /结束日期不能早于开始日期/)
  app.query({ id: '<script>' })
  assert.match(app.message.textContent, /请输入运行编号/)
})

test('UTC 新运行按北京时间过滤，重跑不覆盖历史且取消保留结果', () => {
  const app = harness()
  app.read("feeConfirmed = true; evalView = 'new'; render()")
  app.click('run')
  assert.equal(app.read('runs.length'), 8)
  assert.equal(app.read('runs[0].results.length'), 4)
  app.read("runs[7].createdAt = '2026-08-30T17:00:00.000Z'")
  app.click('eval-history')
  app.query({ from: '2026-08-31', to: '2026-08-31' })
  assert.match(app.text, /共 2 次执行/)
  app.read(
    "runs[7].state = 'running'; runs[7].startedAt = new Date().toISOString(); completeNext(runs[7])",
  )
  app.click('cancel', 8)
  assert.equal(app.read('runs[7].results.length'), 1)
  app.click('history-open', 8)
  assert.match(app.text, /已取消/)
  assert.match(app.text, /1 \/ 4 条已返回/)
})

test('查询故障与重试不创建评测，历史快照不受集合更新影响', () => {
  const app = harness()
  app.click('history-error')
  assert.match(app.text, /模拟查询失败/)
  app.click('history-retry')
  assert.doesNotMatch(app.text, /<div class="message error"/)
  assert.equal(app.read('runs.length'), 7)
  app.read("datasets[0].name = '新版集合'; datasets[0].version = 2")
  app.click('history-open', 1)
  assert.match(app.text, /基础能力示例集 v1/)
  assert.doesNotMatch(app.text, /新版集合/)
})

test('进度更新保留尚未提交的筛选草稿，查询后才改变列表', () => {
  const app = harness()
  app.read(`
    const getElement = document.getElementById
    const draftForm = { fields: { dataset: 'style', state: 'completed', from: '2026-08-30', to: '2026-08-31', id: '#01' } }
    document.getElementById = id => id === 'history-filters' ? draftForm : getElement(id)
    runs[1].state = 'running'
    completeNext(runs[1])
  `)
  assert.equal(app.read('historyFilterDraft.id'), '#01')
  assert.equal(app.read('historyFilters.id'), '')
  assert.match(app.text, /共 7 次执行/)
  assert.match(app.text, /id="history-id" name="id" value="#01"/)
  app.click('history-reset')
  assert.equal(app.read('historyFilterDraft.id'), '')
})
