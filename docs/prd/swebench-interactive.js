/* Interactive requirements prototype. No backend or model calls. */
'use strict'
const $ = (q, root = document) => root.querySelector(q)
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const cases = [
  { id: 'demo-sympy-01', title: '空输入的表达式化简', repo: 'sympy/sympy', size: '约 2.1 GB' },
  {
    id: 'demo-django-02',
    title: '查询组合中的空条件处理',
    repo: 'django/django',
    size: '约 2.8 GB',
  },
  {
    id: 'demo-pytest-03',
    title: '参数化用例的异常报告',
    repo: 'pytest-dev/pytest',
    size: '约 1.6 GB',
  },
  {
    id: 'demo-sphinx-04',
    title: '跨文档引用的路径解析',
    repo: 'sphinx-doc/sphinx',
    size: '约 2.3 GB',
  },
  {
    id: 'demo-requests-05',
    title: '重定向后的请求头保留',
    repo: 'psf/requests',
    size: '约 1.4 GB',
  },
]
const KEY = 'codeden-swebench-prd-v1'
const fresh = () => ({
  schema: 1,
  imported: true,
  selected: cases.slice(0, 3).map((c) => c.id),
  env: Object.fromEntries(
    cases.map((c, i) => [c.id, i === 0 ? 'ready' : i === 2 ? 'error' : 'new']),
  ),
  jobs: [],
  checks: [],
  draft: {
    name: 'SWE-bench 重复评测',
    config: 'baseline',
    mode: 'repeat',
    repeats: 5,
    concurrency: 2,
    minutes: 10,
    tokens: 30000,
    tools: 80,
  },
  baseline: null,
})
let state
try {
  state = JSON.parse(localStorage.getItem(KEY))
  if (state?.schema !== 1) state = fresh()
} catch {
  state = fresh()
}
let viewTab = 'cases',
  statusFilter = 'all',
  search = '',
  envFilter = 'all',
  expanded = null,
  drawerContext = null,
  timer = null,
  noticeTimer = null
// A refresh never silently resumes an execution.
for (const job of state.jobs) {
  if (job.status === 'running') {
    job.status = 'interrupted'
    for (const t of job.trials)
      if (!t.verdict) t.life = t.life === 'queued' ? 'cancelled' : 'interrupted'
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    toast('浏览器无法保存演示状态，刷新后可能丢失。')
  }
}
function toast(msg) {
  $('#toast').textContent = msg
  $('#toast').style.display = 'block'
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => ($('#toast').style.display = 'none'), 3600)
}
function badge(text, type = '') {
  return `<span class="badge ${type}">${text}</span>`
}
function button(text, action, extra = '', cls = '') {
  return `<button type="button" class="${cls}" data-action="${action}" ${extra}>${text}</button>`
}
function rules(id, title, items) {
  return `<details class="requirement"><summary>${id} · ${title}</summary><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></details>`
}
function heading(title, desc, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`
}
function envBadge(id) {
  const s = state.env[id]
  return badge(
    { ready: '校验通过', error: '校验失败', new: '未准备' }[s],
    s === 'error' ? 'fail' : s === 'new' ? 'waiting' : '',
  )
}
function counts(job, subset = job.trials) {
  const n = subset.length,
    p = subset.filter((t) => t.verdict === 'pass').length,
    f = subset.filter((t) => t.verdict === 'fail').length,
    u = subset.filter((t) => t.verdict === 'unknown').length
  return { n, p, f, u, m: n - p - f - u }
}
function pct(a, b) {
  return b ? `${((100 * a) / b).toFixed(1)}%` : '暂无有效判定'
}
function wilson(p, n) {
  if (!n) return '暂无有效判定'
  const z = 1.96,
    d = 1 + (z * z) / n,
    center = (p / n + (z * z) / (2 * n)) / d,
    half = (z * Math.sqrt(((p / n) * (1 - p / n)) / n + (z * z) / (4 * n * n))) / d
  return `${(100 * (center - half)).toFixed(1)}%–${(100 * (center + half)).toFixed(1)}%`
}
function jobStatus(job) {
  return badge(
    { running: '执行中', completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[
      job.status
    ],
    job.status === 'running' ? 'running' : job.status === 'completed' ? '' : 'unknown',
  )
}
function route() {
  return location.hash.slice(1).split('/')
}
function currentJob() {
  return state.jobs.find((j) => j.id === route()[1])
}
function navigate(hash) {
  location.hash = hash
}
function render() {
  let [page] = route()
  if (!page) page = 'dataset'
  document
    .querySelectorAll('nav [data-page]')
    .forEach((a) =>
      a.setAttribute(
        'aria-current',
        a.dataset.page === (['job', 'create', 'compare'].includes(page) ? 'experiments' : page)
          ? 'page'
          : 'false',
      ),
    )
  const screens = {
    dataset: renderDataset,
    create: renderCreate,
    experiments: renderExperiments,
    job: renderJob,
    compare: renderCompare,
    requirements: renderRequirements,
  }
  $('#main').innerHTML = (screens[page] || renderDataset)()
  if (page === 'create') updatePlan()
}
function renderDataset() {
  return (
    heading(
      '评测集',
      '用官方题目验证链路。先准备环境，再开始独立、重复的作答。',
      button('导入评测集', 'import', '', 'primary'),
    ) +
    (!state.imported
      ? `<div class="panel empty"><h2>尚未导入第三方评测集</h2><p>导入题目元数据不会立即下载镜像。</p>${button('导入 SWE-bench Lite', 'import', '', 'primary')}</div>`
      : `<section class="panel"><div class="toolbar"><div><h2>SWE-bench Lite ${badge('5 条演示用例')}</h2><span class="muted small">快照 demo-v1 · 合成题目与体积，仅演示交互，不对应官方实例</span></div><a href="https://www.swebench.com/SWE-bench/reference/harness/" target="_blank" rel="noreferrer">官方环境说明 ↗</a></div><div class="filters"><label>搜索<input id="search" placeholder="题目或仓库" value="${esc(search)}"></label><label>环境状态<select id="env-filter"><option value="all">全部状态</option>${[
          ['ready', '校验通过'],
          ['new', '未准备'],
          ['error', '校验失败'],
        ]
          .map(
            ([k, v]) => `<option value="${k}" ${envFilter === k ? 'selected' : ''}>${v}</option>`,
          )
          .join(
            '',
          )}</select></label></div></section><div class="panel flush"><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th><input type="checkbox" id="select-all" aria-label="选择所有筛选结果" ${visibleCases().length && visibleCases().every((c) => state.selected.includes(c.id)) ? 'checked' : ''}></th><th>题目 / 固定快照</th><th>仓库</th><th>环境</th><th>操作</th></tr></thead><tbody>${
          visibleCases()
            .map(
              (c) =>
                `<tr><td><input type="checkbox" data-select="${c.id}" aria-label="选择${c.title}" ${state.selected.includes(c.id) ? 'checked' : ''}></td><td><strong>${c.title}</strong><small>${c.id} · demo-v1</small></td><td>${c.repo}<small>演示镜像 ${c.size}</small></td><td>${envBadge(c.id)}</td><td>${button('查看环境', 'environment', `data-id="${c.id}"`)}</td></tr>`,
            )
            .join('') ||
          '<tr><td colspan="5" class="empty">没有匹配的题目。请调整搜索或筛选条件。</td></tr>'
        }</tbody></table></div><div class="selection-bar"><span>已选 <strong>${state.selected.length}</strong> / ${cases.length} 题 <span class="muted small">（含筛选外选择）</span></span><div class="actions">${button('准备并校验环境', 'prepare', state.selected.length ? '' : 'disabled')}${button('创建实验', 'create', state.selected.length ? '' : 'disabled', 'primary')}</div></div></div>`) +
    rules('D01', '导入、校验与隐私边界', [
      '数据导入固定来源、版本、许可证与 SHA256；不立即拉取全部镜像。实际接入时必须验证来源与许可，本原型不提供真实数据。',
      '准备阶段可以访问受控依赖源；作答阶段默认禁网。仅共享不可变镜像与依赖缓存。',
      '环境校验包含官方参考补丁通过与空补丁未解决；失败题不得被静默移出计划。',
      '本机架构不受支持、磁盘不足、版本不可取得时明确阻止准备，禁止偷偷替换环境。',
    ])
  )
}
function visibleCases() {
  return cases.filter(
    (c) =>
      (c.title + c.repo).toLowerCase().includes(search.toLowerCase()) &&
      (envFilter === 'all' || state.env[c.id] === envFilter),
  )
}
function renderCreate() {
  const d = state.draft,
    baseline = state.jobs.find((j) => j.id === state.baseline)
  return (
    heading(
      baseline ? '创建对比实验' : '创建重复评测实验',
      '提交前确认计划；排队后冻结题目、环境、评分器和执行预算。',
      button('返回评测集', 'back-dataset'),
    ) +
    `<form id="create-form"><div class="split"><section class="panel"><h2>实验配置</h2>${baseline ? `<div class="notice good">基线 ${esc(baseline.name)}：仅可切换被测配置，其余条件锁定。</div>` : ''}<div class="form-grid"><label class="field full"><span>实验名称</span><input name="name" required maxlength="80" value="${esc(d.name)}"></label><label class="field full"><span>被测配置</span><select name="config"><option value="baseline" ${d.config === 'baseline' ? 'selected' : ''}>CodeDen 基线 · 配置 demo-a</option><option value="candidate" ${d.config === 'candidate' ? 'selected' : ''}>CodeDen 候选 · 配置 demo-b</option></select><small>演示目录；真实配置由服务端登记，密钥仅引用。</small></label><label class="field"><span>运行模式</span><select name="mode" ${baseline ? 'disabled' : ''}><option value="repeat" ${d.mode === 'repeat' ? 'selected' : ''}>重复评测</option><option value="smoke" ${d.mode === 'smoke' ? 'selected' : ''}>单次冒烟</option></select></label><label class="field"><span>每题独立执行次数</span><input name="repeats" type="number" min="2" max="20" step="1" value="${d.repeats}" ${baseline ? 'disabled' : ''}><small>重复 2–20 次；冒烟固定为 1 次。</small></label><label class="field"><span>并发数</span><input name="concurrency" type="number" min="1" max="4" step="1" value="${d.concurrency}" ${baseline ? 'disabled' : ''}></label><label class="field"><span>每次时间上限（分钟）</span><input name="minutes" type="number" min="1" max="60" step="1" value="${d.minutes}" ${baseline ? 'disabled' : ''}></label><label class="field"><span>每次 Token 上限</span><input name="tokens" type="number" min="1000" max="100000" step="1000" value="${d.tokens}" ${baseline ? 'disabled' : ''}></label><label class="field"><span>每次工具调用上限</span><input name="tools" type="number" min="1" max="500" step="1" value="${d.tools}" ${baseline ? 'disabled' : ''}></label></div></section><aside class="panel sticky-summary"><h2>执行计划</h2><div id="plan-summary"></div><label class="checkline"><input name="consent" type="checkbox" required><span>确认固定计划与预算。<small class="muted">本次仅模拟；生产页面须单独确认真实调用费用。</small></span></label><button class="primary" type="submit" id="start">确认并开始模拟</button><div id="form-error" class="error-text" role="alert"></div></aside></div></form>` +
    rules('E01', '冻结、次数和计费', [
      '创建时一次性生成 C × R 个 Trial；同题前几次成功或失败都不改变次数。',
      '所有题目未就绪时禁止启动，回到评测集完成环境校验。服务端须再次校验，不能信任前端状态。',
      '首版不做看成绩追加次数或只补失败子集。重跑形成新实验，保留原始实验。',
      'requestId 相同且参数相同返回原 Job；参数变化返回冲突。预算含故障尝试，费用未知不能显示为 0。',
    ])
  )
}
function readDraft() {
  const f = $('#create-form')
  if (!f) return
  for (const name of [
    'name',
    'config',
    'mode',
    'repeats',
    'concurrency',
    'minutes',
    'tokens',
    'tools',
  ]) {
    const input = f.elements[name]
    if (!input.disabled)
      state.draft[name] = ['name', 'config', 'mode'].includes(name)
        ? input.value
        : Number(input.value)
  }
  save()
}
function updatePlan() {
  const f = $('#create-form')
  if (!f) return
  const d = state.draft,
    r = d.mode === 'smoke' ? 1 : d.repeats,
    n = state.selected.length * r
  f.elements.repeats.disabled = d.mode === 'smoke' || !!state.baseline
  const ready = state.selected.filter((id) => state.env[id] === 'ready').length
  $('#plan-summary').innerHTML =
    `<div class="plan-number">${state.selected.length} 题 × ${Number.isFinite(r) ? r : '—'} 次<br><strong>${Number.isFinite(n) ? n : '—'} 个独立 Trial</strong></div><dl class="keyvalues"><dt>环境就绪</dt><dd>${ready}/${state.selected.length}</dd><dt>数据 / 判卷</dt><dd>demo-v1 / grader-demo-v1</dd><dt>Token 计划上限</dt><dd>${Number.isFinite(n * d.tokens) ? (n * d.tokens).toLocaleString() : '—'}<br><small class="muted">仅 Agent；重试及判卷另计，非费用上限。</small></dd><dt>预计费用</dt><dd>未知（无实际定价依据）</dd></dl>${d.mode === 'smoke' ? '<div class="notice">单次冒烟不用于判断稳定性。</div>' : ''}${ready !== state.selected.length ? '<div class="notice error">存在未就绪环境。请返回评测集校验；不能自动跳过。</div>' : ''}`
  $('#start').disabled = !state.selected.length || ready !== state.selected.length
}
async function startJob() {
  readDraft()
  const d = state.draft,
    r = d.mode === 'smoke' ? 1 : d.repeats
  const invalid =
    !state.selected.length ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 20 ||
    (d.mode === 'repeat' && r < 2) ||
    !d.name.trim() ||
    !Number.isInteger(d.concurrency) ||
    d.concurrency < 1 ||
    d.concurrency > 4 ||
    !Number.isInteger(d.minutes) ||
    d.minutes < 1 ||
    d.minutes > 60 ||
    !Number.isInteger(d.tokens) ||
    d.tokens < 1000 ||
    d.tokens > 100000 ||
    !Number.isInteger(d.tools) ||
    d.tools < 1 ||
    d.tools > 500 ||
    state.selected.some((id) => state.env[id] !== 'ready')
  if (invalid) {
    $('#form-error').textContent = '计划无效：检查题目、就绪环境、整数次数和预算范围。'
    return
  }
  if (!$('#create-form').elements.consent.checked) return
  try {
    const response = await fetch('/api/swebench/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: state.selected.length * r }),
    })
    const remote = await response.json()
    if (!response.ok) throw new Error(remote.error || '真实 SWE-bench 任务创建失败。')
    toast(`真实评测已启动：${remote.id}。CodeDen Agent 正在执行。`)
    window.open(`/api/swebench/jobs/${remote.id}`, '_blank', 'noopener')
    return
  } catch (error) {
    $('#form-error').textContent = error instanceof Error ? error.message : '无法连接真实评测服务。'
    return
  }
  const id = 'demo-' + Date.now()
  const job = {
    id,
    name: d.name.trim(),
    config: d.config,
    mode: d.mode,
    r,
    caseIds: [...state.selected],
    settings: { ...d, repeats: r },
    baseline: state.baseline,
    status: 'running',
    created: new Date().toISOString(),
    dataset: 'demo-v1',
    environment: 'env-demo-v1',
    grader: 'grader-demo-v1',
    trials: [],
  }
  for (let k = 1; k <= r; k++)
    for (const [i, caseId] of job.caseIds.entries())
      job.trials.push({
        id: `${id}-${i}-${k}`,
        caseId,
        k,
        life: 'queued',
        verdict: null,
        attempts: 1,
        scores: [],
        tokens: null,
        seconds: null,
      })
  state.jobs.unshift(job)
  state.baseline = null
  save()
  viewTab = 'cases'
  statusFilter = 'all'
  navigate(`job/${id}`)
  toast('已冻结计划。点击“推进模拟”观察一次完整阶段转换。')
}
function renderExperiments() {
  return (
    heading(
      '实验记录',
      '每场实验固定一个被测配置；对比实验保留基线关联，不覆盖历史。',
      button('创建实验', 'create', '', 'primary'),
    ) +
    (!state.jobs.length
      ? `<div class="panel empty"><h2>还没有评测实验</h2><p class="muted">从少量题目开始，先确认环境，再固定每题重复次数。</p>${button('选择题目与环境', 'back-dataset', '', 'primary')}</div>`
      : `<div class="panel flush"><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th>实验</th><th>被测配置</th><th>固定计划</th><th>已处理</th><th>状态</th><th></th></tr></thead><tbody>${state.jobs
          .map((j) => {
            const c = counts(j)
            return `<tr><td><strong>${esc(j.name)}</strong><small>${new Date(j.created).toLocaleString('zh-CN')}${j.baseline ? ' · 关联基线' : ''}</small></td><td>${j.config === 'baseline' ? '基线 demo-a' : '候选 demo-b'}</td><td>${j.caseIds.length} × ${j.r} = ${c.n}</td><td>${c.p + c.f + c.u}/${c.n}</td><td>${jobStatus(j)}</td><td>${button('查看实验', 'open-job', `data-id="${j.id}"`)}</td></tr>`
          })
          .join('')}</tbody></table></div></div>`) +
    rules('H01', '历史和恢复', [
      '演示刷新时保留已完成结果，未完成运行标为中断，不自动恢复调用。生产环境采用心跳与租约确认执行状态。',
      'Worker 失联且调用是否发生未知时标 interrupted，禁止重新领取后自动重复付费。',
      '新实验固定题目与次数；旧单次记录不能伪装成重复评测。',
    ])
  )
}
function statsMarkup(j) {
  const c = counts(j)
  return `<div class="stats"><div class="stat"><div class="value">${c.p + c.f + c.u}<span class="muted"> / ${c.n}</span></div><p>已处理 · 未完成 ${c.m}</p></div><div class="stat"><div class="value">${pct(c.p, c.n)}</div><p>计划通过占比 · ${c.p}/${c.n}</p></div><div class="stat"><div class="value">${pct(c.p, c.p + c.f)}</div><p>有效判定成功率 · ${c.p}/${c.p + c.f}</p></div><div class="stat"><div class="value">${pct(c.p + c.f, c.n)}</div><p>有效覆盖率 · 未判定 ${c.u}</p></div></div>`
}
function renderJob() {
  const j = currentJob()
  if (!j)
    return heading('找不到实验', '该演示记录可能已被重置。', button('返回实验记录', 'history'))
  const c = counts(j)
  return (
    heading(
      esc(j.name),
      `${j.caseIds.length} 道题，每题 ${j.r} 次 · ${j.config === 'baseline' ? '基线 demo-a' : '候选 demo-b'} · ${j.id}`,
      `${jobStatus(j)}${j.status === 'running' ? button('推进模拟', 'tick') + button(timer ? '暂停自动演示' : '自动演示', 'auto') + button('取消实验', 'cancel', '', 'danger') : button('创建对比实验', 'new-comparison', '', 'primary')}`,
    ) +
    `<div class="progress" aria-label="已处理 ${c.p + c.f + c.u}/${c.n}"><div style="width:${(100 * (c.p + c.f + c.u)) / c.n}%"></div></div><p class="small muted">模拟控制每次推进一个调度节拍；自动演示每秒推进，离开页面暂停。生产环境由 Worker 驱动，不提供此控制。</p>` +
    statsMarkup(j) +
    (c.u || c.m
      ? '<div class="notice">结果不完整，不用于确定性版本结论。未判定与未完成不视为能力失败，也不能隐去。</div>'
      : '<div class="notice good">本次计划已得到完整有效判定。结果仅描述当前题集和这次观测。</div>') +
    (j.mode === 'smoke'
      ? '<div class="notice">单次冒烟：不展示稳定性区间，不能用来判断稳定性。</div>'
      : '') +
    `<div class="tabs" role="group" aria-label="实验详情">${[
      ['cases', '用例结果'],
      ['statistics', '统计分析'],
      ['config', '冻结配置'],
    ]
      .map(
        ([k, v]) =>
          `<button aria-pressed="${viewTab === k}" data-action="job-tab" data-tab="${k}">${v}</button>`,
      )
      .join('')}${j.baseline ? button('与基线对比', 'compare', `data-id="${j.id}"`) : ''}</div>` +
    (viewTab === 'cases'
      ? caseResults(j)
      : viewTab === 'statistics'
        ? statistics(j)
        : configView(j)) +
    rules('T01', '独立执行与状态', [
      '每个 Trial 从干净文件、会话、记忆开始；不能复用上次答案或可写工作区。',
      'lifecycle 与 verdict 分离：completed 可包含 pass / fail / unknown；取消、中断和排队属于未完成。',
      '已调用 Agent 的故障默认不自动重跑；准备阶段尚未调用 Agent 的可重试故障最多一次，保留 ExecutionAttempt。',
      '取消停止新任务、停止活跃执行并清理。已提交判分不变，未完成项不计为 fail。',
    ])
  )
}
function caseResults(j) {
  return `<div class="toolbar"><div class="legend"><span><i class="pass"></i>通过</span><span><i class="fail"></i>未通过</span><span><i class="unknown"></i>未判定</span><span>数字为第几次 · 点开看证据</span></div><label>筛选 <select id="result-filter">${[
    ['all', '全部题目'],
    ['fail', '存在未通过'],
    ['unknown', '存在未判定'],
    ['incomplete', '存在未完成'],
  ]
    .map(([k, v]) => `<option value="${k}" ${k === statusFilter ? 'selected' : ''}>${v}</option>`)
    .join(
      '',
    )}</select></label></div><div class="panel flush"><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th>题目</th><th>独立执行</th><th>通过 / 计划</th><th>观测状态</th></tr></thead><tbody>${
    j.caseIds
      .filter((id) => {
        const c = counts(
          j,
          j.trials.filter((t) => t.caseId === id),
        )
        return (
          statusFilter === 'all' ||
          (statusFilter === 'fail' && c.f) ||
          (statusFilter === 'unknown' && c.u) ||
          (statusFilter === 'incomplete' && c.m)
        )
      })
      .map((id) => {
        const ts = j.trials.filter((t) => t.caseId === id),
          c = counts(j, ts),
          item = cases.find((x) => x.id === id)
        const desc =
          c.u || c.m
            ? '结果不完整'
            : j.r === 1
              ? '单次结果'
              : c.p === c.n
                ? '本次全通过'
                : c.f === c.n
                  ? '本次全未通过'
                  : '结果波动'
        return `<tr><td>${button(item.title, 'expand', `data-id="${id}"`, 'link')}<small>${id}</small></td><td><div class="trials">${ts.map((t) => button(t.k, 'trial', `data-id="${t.id}" title="第 ${t.k} 次：${trialText(t)}" aria-label="${esc(item.title)} 第 ${t.k} 次 ${trialText(t)}"`, `trial ${t.verdict || (['running', 'grading', 'preparing'].includes(t.life) ? 'running' : '')}`)).join('')}</div></td><td><strong>${c.p}/${c.n}</strong><small>有效 ${c.p + c.f} · 未判定 ${c.u}</small></td><td>${badge(desc, c.u || c.m ? 'unknown' : c.p === c.n ? '' : 'waiting')}</td></tr>${expanded === id ? `<tr><td colspan="4"><div class="metric-row"><div><p>有效成功率</p><strong>${pct(c.p, c.p + c.f)}</strong></div><div><p>95% Wilson 区间</p><strong>${j.r === 1 ? '冒烟不计算' : wilson(c.p, c.p + c.f)}</strong></div></div><p class="small muted">仅针对当前题目的有效独立试次。依赖同条件独立假设，不消除环境相关性、缺失偏差或模型漂移。</p></td></tr>` : ''}`
      })
      .join('') || '<tr><td colspan="4" class="empty">当前没有符合条件的用例。</td></tr>'
  }</tbody></table></div></div>`
}
function statistics(j) {
  const c = counts(j),
    known = j.trials.filter((t) => t.tokens !== null),
    total = known.reduce((s, t) => s + t.tokens, 0),
    sec = known.reduce((s, t) => s + t.seconds, 0),
    sorted = known.map((t) => t.seconds).sort((a, b) => a - b),
    median = sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) /
        2
      : null
  return `<div class="split"><section class="panel"><h2>计划内结果分布</h2>${[
    ['通过', c.p, ''],
    ['未通过', c.f, 'fail'],
    ['未判定', c.u, 'unknown'],
    ['未完成', c.m, 'unknown'],
  ]
    .map(
      ([name, n, cls]) =>
        `<div class="bar-row"><span>${name}</span><div class="bar-track"><div class="bar-fill ${cls}" style="width:${(100 * n) / c.n}%"></div></div><span>${n}/${c.n}</span></div>`,
    )
    .join(
      '',
    )}<p class="small muted">N = P + F + U + M。整体占比不外推线上质量，不对异质题目套用统一 Wilson 区间。</p></section><section class="panel"><h2>资源消耗 · 模拟数据</h2><dl class="keyvalues"><dt>Agent Token</dt><dd>${known.length ? total.toLocaleString() : '未知'} · 采集 ${known.length}/${c.n}</dd><dt>Trial 累计时间</dt><dd>${known.length ? sec + ' 秒' : '未知'} · 不等于实验墙钟时间</dd><dt>单次中位耗时</dt><dd>${median ?? '—'}${median === null ? '' : ' 秒'} · n=${known.length}</dd><dt>判卷用量</dt><dd>未知，未纳入 Agent Token</dd><dt>实际费用</dt><dd>未知，缺失不能当作 0</dd></dl></section></div><section class="panel"><h2>失败发生在哪一层</h2><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th>阶段</th><th>数量</th><th>下一步</th></tr></thead><tbody><tr><td>Agent 产物 / 官方测试未通过</td><td>${c.f}</td><td>${button('查看失败用例', 'filter-fail')}</td></tr><tr><td>判卷报告传输 / 无有效结论</td><td>${c.u}</td><td>${button('查看未判定用例', 'filter-unknown')}</td></tr></tbody></table></div><p class="small muted">阶段与直接证据由系统记录；根因由人或模型分析，必须标为假设。不能把“测试失败”自动归因于模型能力。</p></section>`
}
function configView(j) {
  return `<section class="panel"><h2>创建时冻结的快照</h2><dl class="keyvalues"><dt>题目版本</dt><dd>${j.dataset} · ${j.caseIds.join(', ')}</dd><dt>环境 / 架构</dt><dd>${j.environment} · linux/amd64（演示）</dd><dt>评分器</dt><dd>${j.grader}</dd><dt>被测变量</dt><dd>${j.config === 'baseline' ? 'CodeDen demo-a' : 'CodeDen demo-b'} · 模型为模拟 provider</dd><dt>运行计划</dt><dd>${j.caseIds.length} × ${j.r} · 并发 ${j.settings.concurrency}</dd><dt>每次预算</dt><dd>${j.settings.minutes} 分钟 / ${j.settings.tokens} Token / ${j.settings.tools} 工具调用</dd><dt>重试策略</dt><dd>准备故障最多一次；开始调用 Agent 后不自动重跑；判卷传输异常最多一次重试。</dd><dt>可复现边界</dt><dd>真实接入须固定代码、Prompt、工具、Skill、MCP 摘要。远程模型不可固定版本时须声明限制。</dd></dl></section>`
}
function trialText(t) {
  return t.verdict
    ? { pass: '通过', fail: '未通过', unknown: '未判定' }[t.verdict]
    : {
        queued: '排队',
        preparing: '准备环境',
        running: 'Agent 执行',
        grading: '独立判卷',
        cancelled: '取消',
        interrupted: '中断',
      }[t.life]
}
function tick() {
  const j = currentJob()
  if (!j || j.status !== 'running') return
  for (const t of j.trials.filter((t) => ['preparing', 'running', 'grading'].includes(t.life))) {
    if (t.life === 'preparing') t.life = 'running'
    else if (t.life === 'running') t.life = 'grading'
    else finishTrial(j, t)
  }
  const slots =
    j.settings.concurrency -
    j.trials.filter((t) => ['preparing', 'running', 'grading'].includes(t.life)).length
  for (const t of j.trials.filter((t) => t.life === 'queued').slice(0, slots)) t.life = 'preparing'
  if (j.trials.every((t) => t.life === 'completed')) {
    j.status = 'completed'
    clearInterval(timer)
    timer = null
    toast('模拟实验完成，已保存全部独立 Trial。')
  }
  save()
  render()
}
function finishTrial(j, t) {
  const i = j.caseIds.indexOf(t.caseId)
  let outcome = (i + t.k) % 4 === 0 ? 'fail' : 'pass'
  if (j.config === 'candidate' && t.k % 2 === 0) outcome = 'pass' // Preserve one explicit infrastructure fault in the baseline demo.
  if (j.config === 'baseline' && i === 1 && t.k === 2) outcome = 'unknown'
  t.life = 'completed'
  t.verdict = outcome
  t.tokens = 1100 + i * 230 + t.k * 107
  t.seconds = 32 + i * 7 + t.k * 9
  t.scores =
    outcome === 'unknown'
      ? [
          { id: 1, result: 'report_transport_error' },
          { id: 2, result: 'report_transport_error' },
        ]
      : [{ id: 1, result: outcome }]
}
function showDrawer(title, subtitle, content) {
  $('#drawer').innerHTML =
    `<div class="drawer-head"><div><h2 id="drawer-title">${title}</h2><div class="muted small">${subtitle}</div></div>${button('关闭', 'close-drawer', 'aria-label="关闭详情"')}</div>${content}`
  if (!$('#drawer').open) $('#drawer').showModal()
}
function environment(id) {
  const c = cases.find((x) => x.id === id)
  if (!c) return
  drawerContext = { type: 'environment', id }
  const s = state.env[id]
  showDrawer(
    '环境详情',
    `${c.id} · 演示环境`,
    `<h3>${c.title}</h3>${envBadge(id)}<div class="steps">${[
      ['01', '校验数据来源和版本', 'demo-v1 / checksum-demo'],
      [
        '02',
        '准备官方环境镜像',
        s === 'error' ? '失败：依赖下载连接中断' : s === 'ready' ? '镜像缓存命中' : '等待准备',
      ],
      ['03', '官方参考补丁验证', s === 'ready' ? '通过' : '尚未执行'],
      ['04', '空补丁对照', s === 'ready' ? '有效判为未解决' : '尚未执行'],
    ]
      .map(
        ([n, title, detail]) =>
          `<div class="step"><b>${n}</b><div><strong>${title}</strong><div class="muted small">${detail}</div></div></div>`,
      )
      .join(
        '',
      )}</div><pre>${s === 'ready' ? '[模拟] image resolved: env-demo-v1\n[模拟] reference_patch: resolved=true\n[模拟] empty_patch: resolved=false\n[模拟] clean workspace: verified' : s === 'error' ? '[模拟] prepare_image: connection timeout\n[模拟] failureStage=environment_prepare\n[模拟] agent_invoked=false\n可重新准备；不是 Agent 解题失败。' : '尚未下载镜像或执行命令。'}</pre>${button(s === 'ready' ? '重新运行对照（模拟）' : '准备并校验（模拟）', 'prepare-one', `data-id="${id}"`, 'primary')}<p class="small muted">缓存键包含题目版本、镜像 digest、harness 版本、架构及资源配置。此面板未连接真实 Docker。</p>`,
  )
}
function prepare(ids) {
  showDrawer(
    '环境准备与自检',
    '仅模拟 · 不下载镜像',
    `<div class="notice">将对 ${ids.length} 道题准备初始环境，并验证参考补丁与空补丁对照。</div><ul>${ids.map((id) => `<li>${cases.find((c) => c.id === id).title} · ${envBadge(id)}</li>`).join('')}</ul><div class="actions">${button('模拟全部校验通过', 'prepare-success', `data-ids="${ids.join(',')}"`, 'primary')}${button('模拟第一题准备失败', 'prepare-error', `data-ids="${ids.join(',')}"`)}</div>${rules('ENV01', '环境失败与恢复', ['准备失败标记原因，不进入作答阶段；环境就绪须由服务端证据确认。', '首次准备与重试分别留日志，不能用“重试成功”抹掉原故障及成本。'])}`,
  )
}
function showTrial(id, tab = 'tests') {
  const j = currentJob(),
    t = j?.trials.find((x) => x.id === id)
  if (!t) return
  drawerContext = { type: 'trial', id, tab }
  const bad = t.verdict === 'fail',
    unknown = t.verdict === 'unknown',
    done = !!t.verdict
  showDrawer(
    `第 ${t.k} 次独立执行`,
    `${t.caseId} · ${t.id}`,
    `${badge(trialText(t), t.verdict || 'running')}<dl class="keyvalues"><dt>lifecycle</dt><dd>${t.life}</dd><dt>verdict</dt><dd>${t.verdict ?? 'null（尚无判分）'}</dd><dt>停止原因</dt><dd>${done ? (unknown ? '判卷异常重试耗尽' : 'Agent 正常结束') : ['cancelled', 'interrupted'].includes(t.life) ? '停止或失联；未形成有效判分' : '尚未结束'}</dd><dt>环境对照</dt><dd>参考补丁通过（固定快照）</dd><dt>执行 / 判卷尝试</dt><dd>${t.attempts} / ${t.scores.length}</dd></dl><div class="flow">数据加载 → 环境准备 → Agent 作答 → 补丁提交 → 官方判卷</div>${unknown ? '<div class="notice error">事实：两次判卷报告传输失败。无有效结果，不能推断代码是否正确。</div>' : bad ? '<div class="notice error">事实：补丁成功应用，目标测试 1 项未通过。</div>' : done ? '<div class="notice good">事实：目标测试与回归测试通过。</div>' : '<div class="notice">尚无完整产物或有效判分，不提前显示测试结论。</div>'}<div class="tabs" role="group" aria-label="执行证据">${[
      ['tests', '判卷证据'],
      ['diff', '代码 Diff'],
      ['trace', 'Agent Trace'],
      ['logs', '环境日志'],
    ]
      .map(
        ([k, v]) =>
          `<button aria-pressed="${tab === k}" data-action="evidence-tab" data-tab="${k}" data-id="${id}">${v}</button>`,
      )
      .join(
        '',
      )}</div>${trialEvidence(j, t, tab)}${done ? `<div class="actions">${button('只重跑判卷（诊断）', 'rescore', `data-id="${id}"`)}${button('运行参考补丁对照', 'reference', `data-id="${id}"`)}</div><p class="small muted">诊断重评分追加 ScoreAttempt，不重跑 Agent、不增加 N、不覆盖已冻结成绩。新的独立作答必须另建实验。</p>` : ''}`,
  )
}
function trialEvidence(j, t, tab) {
  if (!t.verdict) return '<p class="muted">此阶段暂无完整证据。返回实验推进模拟后查看。</p>'
  if (tab === 'tests')
    return `<pre>${t.scores.map((s) => `ScoreAttempt ${s.id}: ${s.result}${s.diagnostic ? ' [diagnostic_only]' : ''}`).join('\n')}\n${t.verdict === 'unknown' ? 'report.json: unavailable' : `patch_apply: success\nFAIL_TO_PASS: ${t.verdict === 'pass' ? '1/1' : '0/1'}\nPASS_TO_PASS: 12/12\nresolved: ${t.verdict === 'pass'}`}</pre>${t.verdict === 'fail' ? '<div class="evidence-block"><strong>诊断假设 · 待人工确认</strong><p>可能遗漏空输入条件。依据：常规输入回归通过，目标空输入断言失败。</p><p class="small muted">并非已确认的模型层根因，需结合工具执行和提交完整性。</p></div>' : ''}${t.referenceChecked ? '<p class="notice good">新增诊断对照：参考补丁通过；原 Trial 判分未改变。</p>' : ''}`
  if (tab === 'diff')
    return `<p class="small muted">合成补丁示例，不是官方仓库代码。</p><pre class="diff">--- a/example.py\n+++ b/example.py\n@@\n<span class="remove">-    return values[0]</span>\n<span class="add">+    return values[0] ${t.verdict === 'pass' ? 'if values else None' : '# empty input still unhandled'}</span></pre>`
  if (tab === 'trace')
    return [
      ['00:00', '任务开始', '加载问题说明；未加载隐藏测试或参考补丁。'],
      ['00:03', 'read_file', '读取作答工作区 example.py。'],
      ['00:08', 'write_file', '修改文件；工作区变更已保存。'],
      ['00:16', 'run_command', '运行可见测试；退出码 0。'],
      ['00:32', '提交产物', '导出相对初始 commit 的补丁。'],
    ]
      .map(
        ([time, tool, msg]) =>
          `<div class="evidence-block"><strong>${time} · ${tool}</strong><p class="muted small">${msg}</p></div>`,
      )
      .join('')
  return '<pre>[模拟] environment=env-demo-v1\n[模拟] workspace=unique-per-trial\n[模拟] agent network=none\n[模拟] clean grading environment created\n[模拟] submitted patch applied\n[模拟] reference/test_patch isolated from agent\n[模拟] cleanup completed</pre>'
}
function newComparison() {
  const j = currentJob()
  if (!j) return
  state.baseline = j.id
  state.selected = [...j.caseIds]
  state.draft = {
    ...j.settings,
    name: j.name + ' · 对比',
    config: j.config === 'baseline' ? 'candidate' : 'baseline',
  }
  save()
  navigate('create')
}
function comparable(a, b) {
  const reasons = []
  if (!a || !b) return ['缺少基线实验']
  if (a.mode !== 'repeat' || b.mode !== 'repeat') reasons.push('包含单次冒烟，不能比较稳定性')
  for (const [key, label] of [
    ['dataset', '数据版本'],
    ['environment', '环境版本'],
    ['grader', '评分器版本'],
    ['r', '重复次数'],
  ])
    if (a[key] !== b[key]) reasons.push(`${label}不一致`)
  if (JSON.stringify(a.caseIds) !== JSON.stringify(b.caseIds)) reasons.push('题目集合不一致')
  for (const key of ['concurrency', 'minutes', 'tokens', 'tools'])
    if (a.settings[key] !== b.settings[key]) reasons.push(`执行条件 ${key} 不一致`)
  if (
    [a, b].some((j) => {
      const c = counts(j)
      return c.u || c.m
    })
  )
    reasons.push('存在未判定或未完成，证据不完整')
  return reasons
}
function usageText(job) {
  const known = job.trials.filter((t) => t.tokens !== null)
  return known.length ? known.reduce((sum, t) => sum + t.tokens, 0).toLocaleString() : '未知'
}
function renderCompare() {
  const b = currentJob(),
    a = state.jobs.find((j) => j.id === b?.baseline)
  if (!a || !b)
    return heading('暂无关联基线', '请从实验详情创建对比实验。', button('返回实验记录', 'history'))
  const reasons = comparable(a, b),
    ca = counts(a),
    cb = counts(b)
  return (
    heading(
      '实验对比',
      esc(`${a.name} → ${b.name}`),
      button('返回候选实验', 'open-job', `data-id="${b.id}"`),
    ) +
    `<div class="notice ${reasons.length ? '' : 'good'}">${reasons.length ? '不满足可比条件：' + reasons.join('；') + '。仅并列展示原始数据，不计算提升结论。' : '同条件、完整有效判定。本次观测差异 ' + (100 * (cb.p / cb.n - ca.p / ca.n)).toFixed(1) + ' 个百分点；不代表显著改善。'}</div><div class="panel flush"><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th>用例</th><th>基线 ${a.config}</th><th>候选 ${b.config}</th><th>判断</th></tr></thead><tbody>${a.caseIds
      .map((id) => {
        const x = counts(
            a,
            a.trials.filter((t) => t.caseId === id),
          ),
          y = counts(
            b,
            b.trials.filter((t) => t.caseId === id),
          )
        return `<tr><td>${cases.find((c) => c.id === id).title}</td><td>${x.p}/${x.n}<small>U=${x.u} · M=${x.m}</small></td><td>${y.p}/${y.n}<small>U=${y.u} · M=${y.m}</small></td><td>${reasons.length ? '证据不完整' : y.p > x.p ? '本次提高' : y.p < x.p ? '本次下降' : '本次持平'}</td></tr>`
      })
      .join(
        '',
      )}</tbody></table></div></div><section class="panel"><h2>消耗并列查看</h2><p>基线 Agent Token：${usageText(a)}（采集 ${a.trials.filter((t) => t.tokens !== null).length}/${ca.n}）</p><p>候选 Agent Token：${usageText(b)}（采集 ${b.trials.filter((t) => t.tokens !== null).length}/${cb.n}）</p><p class="muted small">判卷费用未知；不将缺失用量解释为节省。首版不自动晋级、发布或作显著性结论。</p></section>`
  )
}
const criteria = [
  [
    'A01',
    '选择 3 题，每题 5 次，创建恰好 15 个唯一 Trial。',
    '评测集 → 环境校验 → 创建实验；次数变化实时更新计划。',
  ],
  [
    'A02',
    '环境校验失败阻止启动，不跳过失败题。',
    '准备环境 → 模拟第一题失败 → 创建实验，查看禁用提示。',
  ],
  [
    'A03',
    '0、21、小数次数或无费用确认时不能提交。',
    '创建实验中输入非法值，浏览器及处理器都校验。生产服务端必须重复校验。',
  ],
  [
    'A04',
    '每次作答都记录独立状态与证据，不按成功提前停止。',
    '推进模拟或自动演示 → 点开编号查看独立 Trial。',
  ],
  ['A05', '取消后 N 不变，已有结果保留，未完成项计入 M。', '运行中取消实验 → 统计分析。'],
  ['A06', '刷新不自动恢复付费执行；未完成实验标中断。', '运行中刷新页面 → 实验记录。'],
  [
    'A07',
    '只重跑判卷保留旧分数，不增加 Trial 或修改主统计。',
    '完成的 Trial → 只重跑判卷 → 查看 ScoreAttempt。',
  ],
  [
    'A08',
    'unknown 不算 fail；无有效判定时显示“暂无有效判定”。',
    '刚创建实验，及基线第二题第二次演示异常。',
  ],
  [
    'A09',
    '完整结果可比；含 U/M 或冒烟时仅并列查看。',
    '完成实验 → 创建对比实验 → 统计 → 与基线对比。',
  ],
  [
    'A10',
    '隐藏测试和参考补丁不进入 Agent 上下文。',
    '架构要求；原型仅表达约束，需后端隔离与端到端测试验证。',
  ],
  [
    'A11',
    '真实集成通过官方参考补丁和空补丁两项对照。',
    '环境页显示结果；本原型不代表官方 Harness 已接通。',
  ],
  [
    'A12',
    '幂等创建、租约、预算、服务端校验及清理可验证。',
    '后端验收项；不能以当前浏览器模拟代替实现证明。',
  ],
]
function renderRequirements() {
  return (
    heading(
      '需求与架构',
      'P0 · 第三方评测集接入、独立重复执行、统计与故障诊断。',
      button('体验主流程', 'back-dataset', '', 'primary'),
    ) +
    `<section class="panel"><h2>范围与交付边界</h2><p>首版选择 SWE-bench Lite 小型固定子集。复用现有 EvalRunner、TrialRunner、Workspace 与 sandbox 基础；补第三方环境生命周期、官方判卷桥接和重复实验契约。</p><p class="muted">不做 Trace 自动出题、不做全量榜单、不重建通用 sandbox、不自动优化或发布 Agent。</p><div class="notice">本页是待实现的可交互 PRD。示例题目、固定摘要、镜像大小、成绩、日志均为合成演示，不能作为真实评测证据。</div></section><section class="panel"><h2>平台如何接入官方环境</h2><div class="flow">选择固定题目 → 官方环境预检 → C × R 个独立作答 → 导出补丁 → 干净环境官方判卷 → 保存结果与证据</div><div class="architecture"><div><strong>平台 / API</strong><p>配置目录、计划确认、幂等创建、历史查询与授权。</p></div><div><strong>Worker / TrialRunner</strong><p>领取租约、独立会话、预算控制、持久化和清理。</p></div><div><strong>环境适配层</strong><p>官方镜像/构建规则、按 Trial 容器生命周期、文件访问一致性。</p></div><div><strong>CodeDen Runtime</strong><p>模型、Prompt、工具执行。所有工具看到同一份作答工作区。</p></div><div><strong>官方判卷桥接</strong><p>新环境应用提交和测试补丁，解析官方结果；参考解保持隔离。</p></div><div><strong>统计 / 诊断</strong><p>按 Trial 聚合，关联原始证据，明确区分事实和根因假设。</p></div></div><p class="small muted">当前 Docker 固定 node 用户及 /workspace、每命令新容器，需要外部环境适配；当前创建仓库时应用测试补丁，需要移到独立判卷阶段。不是只换镜像地址。</p></section><div class="rule-grid"><section class="panel"><h2>对象与状态</h2><dl class="keyvalues"><dt>Experiment / Job</dt><dd>沿用现有 job/run 身份；固定一个配置与 C × R 计划。</dd><dt>Trial</dt><dd>唯一键 jobId + caseId + repetitionIndex。</dd><dt>ExecutionAttempt</dt><dd>一次基础设施尝试；重试不增加样本数。</dd><dt>ScoreAttempt</dt><dd>同一不可变产物的一次判卷；诊断重评分不覆盖正式判分。</dd><dt>lifecycle</dt><dd>queued / preparing / running / grading / completed / cancelled / interrupted</dd><dt>verdict</dt><dd>pass / fail / unknown / null；null 表示未完成。</dd></dl></section><section class="panel"><h2>统计定义</h2><dl class="keyvalues"><dt>计数恒等式</dt><dd>N = P + F + U + M</dd><dt>计划通过占比</dt><dd>P / N，不把 U 和 M 宣称为能力失败。</dd><dt>有效成功率</dt><dd>P / (P + F)，同时展示覆盖率 (P + F) / N。</dd><dt>题目区间</dt><dd>每题 95% Wilson；n=P+F。R=1 不用于稳定性。</dd><dt>用量</dt><dd>含子 Agent 和故障成本；判卷独立汇总。缺失不能填 0。</dd><dt>耗时</dt><dd>实验墙钟与 Trial 累计时间分开；原型仅模拟后者。</dd></dl></section></div><section class="panel"><h2>失败定位协议</h2><p class="mobile-table-hint">表格可左右滑动，查看全部列。</p><div class="table-scroll"><table><thead><tr><th>层面</th><th>直接证据</th><th>诊断操作</th></tr></thead><tbody>${[
      ['数据适配', '原始字段、版本、转换结果', '核对 base commit 和测试映射'],
      ['环境准备', '镜像 digest、架构、资源、构建日志', '参考补丁与空补丁对照'],
      ['工作区 / 工具', '工作区 ID、读写事件、diff', '核对读写与命令是否共享状态'],
      ['模型 / Runtime', 'API 状态、事件顺序、停止原因', '区分接口故障、解析故障、预算耗尽'],
      ['提交 / 判卷', '导出补丁、应用日志、官方报告', '固定补丁重新判卷'],
      ['解题质量', '有效失败测试、Trace、最终 diff', '人工审阅；模型仅提出有证据的假设'],
    ]
      .map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join('')}</tr>`)
      .join(
        '',
      )}</tbody></table></div></section><section class="panel"><h2>拟议 API 增量 · 非现有能力声明</h2><pre>POST /api/datasets/import               # 来源、版本、许可证、校验值
POST /api/environment-checks             # 固定用例、环境版本，幂等准备
GET  /api/environment-checks/:id         # 阶段、对照报告、日志
POST /api/jobs                          # requestId / mode / repetitionsPerCase
                                       # agentConfigId / budgetPolicyId / baselineJobId
GET  /api/jobs/:id/cases                 # 按题聚合
GET  /api/jobs/:id/trials?caseId=…        # 独立试次
POST /api/jobs/:id/cancel                # 停止调度、传递取消并清理
POST /api/trials/:id/diagnostic-scores    # 仅诊断，不覆盖成绩
GET  /api/jobs/:id/comparison            # 可比性及具体不满足原因</pre><p class="muted small">版本化契约避免旧客户端省略次数后意外多倍付费。服务端负责身份归属、参数范围、预算、租约、幂等和结果引用校验。</p></section><section class="panel"><h2>交互验收清单 <span class="muted small">手动勾选代表评审记录，不代表自动测试通过</span></h2>${criteria.map(([id, title, detail]) => `<div class="criterion"><label><input type="checkbox" data-check="${id}" ${state.checks.includes(id) ? 'checked' : ''}><span><strong>${id}</strong> · ${title}</span></label><small>${detail}</small></div>`).join('')}</section><section class="panel"><h2>阅读与下一步实施</h2><p><a href="swebench-interactive.md">交付说明与实现映射</a> · <a href="eval-repeat-experiments.md">已有重复评测详细规格</a> · <a href="https://www.swebench.com/SWE-bench/reference/harness/" target="_blank" rel="noreferrer">SWE-bench 官方文档</a></p><p>实施顺序：单题官方环境对照 → CodeDen 作答/提交/独立判卷 → Trial 与尝试契约 → 重复调度和统计 → 平台接口与交互。</p></section>`
  )
}
function importDialog() {
  showDrawer(
    '导入第三方评测集',
    'P0：固定的小型 SWE-bench Lite 子集',
    `<label class="field"><span>数据来源</span><select><option>SWE-bench Lite · 演示目录</option></select></label><dl class="keyvalues"><dt>快照</dt><dd>demo-v1</dd><dt>导入范围</dt><dd>5 条合成题目元数据</dd><dt>镜像下载</dt><dd>不会在导入时执行</dd><dt>真实集成要求</dt><dd>固定上游 revision，校验 SHA256 与许可证。</dd></dl><div class="notice">本原型不下载官方数据，现有演示题目按 ID 去重，重复导入不清空历史。</div>${button('导入演示元数据', 'confirm-import', '', 'primary')}`,
  )
}
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]')
  if (!el) return
  const action = el.dataset.action,
    id = el.dataset.id
  switch (action) {
    case 'import':
      importDialog()
      break
    case 'confirm-import':
      state.imported = true
      save()
      $('#drawer').close()
      render()
      toast('已导入 5 条演示题目；重复项已去重。')
      break
    case 'close-drawer':
      $('#drawer').close()
      break
    case 'environment':
      environment(id)
      break
    case 'prepare':
      prepare([...state.selected])
      break
    case 'prepare-one':
      prepare([id])
      break
    case 'prepare-success':
    case 'prepare-error': {
      const ids = el.dataset.ids.split(',')
      ids.forEach(
        (x, i) => (state.env[x] = action === 'prepare-error' && i === 0 ? 'error' : 'ready'),
      )
      save()
      $('#drawer').close()
      render()
      toast(
        action === 'prepare-error'
          ? '第一题准备失败，其他题已就绪。可查看环境日志并重试。'
          : '环境对照通过（模拟），现在可以创建实验。',
      )
      break
    }
    case 'create':
      if (!state.selected.length) {
        toast('请先选择至少一道题。')
        navigate('dataset')
        break
      }
      state.baseline = null
      save()
      navigate('create')
      break
    case 'back-dataset':
      navigate('dataset')
      break
    case 'history':
      navigate('experiments')
      break
    case 'open-job':
      viewTab = 'cases'
      statusFilter = 'all'
      navigate(`job/${id}`)
      break
    case 'job-tab':
      viewTab = el.dataset.tab
      render()
      document.querySelector('[data-action="job-tab"][aria-pressed="true"]')?.focus()
      break
    case 'expand':
      expanded = expanded === id ? null : id
      render()
      break
    case 'trial':
      showTrial(id)
      break
    case 'evidence-tab':
      showTrial(id, el.dataset.tab)
      document.querySelector('[data-action="evidence-tab"][aria-pressed="true"]')?.focus()
      break
    case 'tick':
      tick()
      break
    case 'auto':
      if (timer) {
        clearInterval(timer)
        timer = null
      } else timer = setInterval(tick, 850)
      render()
      break
    case 'cancel':
      showDrawer(
        '取消当前实验',
        '已产生的费用与成绩不会撤销',
        `<p>停止领取新 Trial，停止正在执行的链路并清理。已提交结果保持不变；其余项记为未完成，不计为解题失败。</p>${button('确认取消实验', 'confirm-cancel', '', 'danger')}`,
      )
      break
    case 'confirm-cancel': {
      const j = currentJob()
      if (j) {
        j.status = 'cancelled'
        j.trials.filter((t) => !t.verdict).forEach((t) => (t.life = 'cancelled'))
        clearInterval(timer)
        timer = null
        save()
      }
      $('#drawer').close()
      render()
      break
    }
    case 'rescore': {
      const t = currentJob()?.trials.find((x) => x.id === id)
      if (t) {
        t.scores.push({
          id: t.scores.length + 1,
          result: t.verdict === 'unknown' ? 'pass' : t.verdict,
          diagnostic: true,
        })
        save()
        showTrial(id, 'tests')
        toast('已追加诊断 ScoreAttempt；原始成绩与分母保持不变。')
      }
      break
    }
    case 'reference': {
      const t = currentJob()?.trials.find((x) => x.id === id)
      if (t) {
        t.referenceChecked = true
        save()
        showTrial(id, 'tests')
      }
      break
    }
    case 'filter-fail':
      viewTab = 'cases'
      statusFilter = 'fail'
      render()
      break
    case 'filter-unknown':
      viewTab = 'cases'
      statusFilter = 'unknown'
      render()
      break
    case 'new-comparison':
      newComparison()
      break
    case 'compare':
      navigate(`compare/${id}`)
      break
  }
})
document.addEventListener('change', (e) => {
  const t = e.target
  if (t.dataset.select) {
    state.selected = t.checked
      ? [...new Set([...state.selected, t.dataset.select])]
      : state.selected.filter((id) => id !== t.dataset.select)
    save()
    render()
  } else if (t.id === 'select-all') {
    const ids = visibleCases().map((c) => c.id)
    state.selected = t.checked
      ? [...new Set([...state.selected, ...ids])]
      : state.selected.filter((id) => !ids.includes(id))
    save()
    render()
  } else if (t.id === 'env-filter') {
    envFilter = t.value
    render()
  } else if (t.id === 'result-filter') {
    statusFilter = t.value
    render()
  } else if (t.dataset.check) {
    state.checks = t.checked
      ? [...new Set([...state.checks, t.dataset.check])]
      : state.checks.filter((x) => x !== t.dataset.check)
    save()
  }
})
document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    const pos = e.target.selectionStart
    search = e.target.value
    render()
    $('#search').focus()
    $('#search').setSelectionRange(pos, pos)
  } else if (e.target.closest('#create-form')) {
    readDraft()
    updatePlan()
  }
})
document.addEventListener('submit', (e) => {
  if (e.target.id === 'create-form') {
    e.preventDefault()
    startJob()
  }
})
$('#reset').addEventListener('click', () =>
  showDrawer(
    '重置演示',
    '仅删除本交互 PRD 的浏览器演示数据',
    `<p>清空实验和验收勾选，恢复预置题目与环境状态。不会操作项目文件或真实平台。</p>${button('确认重置', 'reset-confirm', '', 'danger')}`,
  ),
)
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="reset-confirm"]')) {
    clearInterval(timer)
    timer = null
    state = fresh()
    search = ''
    envFilter = 'all'
    statusFilter = 'all'
    viewTab = 'cases'
    expanded = null
    save()
    $('#drawer').close()
    navigate('dataset')
    render()
    toast('演示已重置。')
  }
})
document.querySelector('.skip').addEventListener('click', (event) => {
  event.preventDefault()
  document.querySelector('#main').focus()
  document.querySelector('#main').scrollIntoView()
})
window.addEventListener('hashchange', () => {
  clearInterval(timer)
  timer = null
  $('#drawer').close()
  render()
  $('#main').focus({ preventScroll: true })
})
save()
render()
