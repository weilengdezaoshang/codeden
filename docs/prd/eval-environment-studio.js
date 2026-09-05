/* Interactive prototype only. Editor contents are never executed or uploaded. */
function createEnvironmentStudio({ escapeHtml: esc, onChange, onUse, onBack }) {
  const drafts = new Map()
  let activeId = null
  const steps = ['配置环境', '准备项目', '验证与参考解', '构建与自检']
  const checks = ['材料检查', '构建镜像', '启动与重置', '参考解验证', '空跑负例', '重复复现']
  const seedFiles = {
    'environment/Dockerfile':
      'FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY project/ /app/\n# 只复制初始项目；不要复制 tests/ 或 solution/。\n# 正式构建解析基础镜像摘要，并固定制品。\n',
    'environment/project/package.json':
      '{\n  "name": "empty-list-fixture",\n  "private": true,\n  "type": "module"\n}\n',
    'environment/project/src/sum.js':
      '// 初始缺陷：空数组会抛出异常。\nexport const sum = (items) => items.reduce((a, b) => a + b);\n',
    'environment/project/data/input.json': '{ "items": [] }\n',
    'tests/Dockerfile':
      'FROM node:24-bookworm-slim\nWORKDIR /tests\nCOPY . /tests/\nRUN mkdir -p /app/src /logs/verifier\n# 不挂载主机目录，不注入 Agent 的凭据。\n',
    'tests/test.sh':
      '#!/bin/sh\n# 在独立验证容器内检查允许收集的制品。\nmkdir -p /logs/verifier\nif node /tests/assert.mjs; then\n  printf "1\\n" > /logs/verifier/reward.txt\nelse\n  printf "0\\n" > /logs/verifier/reward.txt\nfi\n',
    'tests/assert.mjs':
      'import assert from "node:assert/strict";\nimport { pathToFileURL } from "node:url";\nconst { sum } = await import(pathToFileURL("/app/src/sum.js"));\nassert.equal(sum([]), 0);\nassert.equal(sum([2, 3]), 5);\nassert.equal(sum([-2, 2]), 0);\n',
    'solution/solve.sh':
      '#!/bin/sh\n# 仅参考解自检使用；不交给正常被测 Agent。\nprintf "%s\\n" "export const sum = (items) => items.reduce((a, b) => a + b, 0);" > /app/src/sum.js\n',
  }
  const current = () => drafts.get(activeId)
  const busy = (d) => d.report?.state === 'running' || d.publishing
  const snapshot = (d) =>
    JSON.stringify({
      config: d.config,
      taskInput: d.taskInput,
      files: Object.entries(d.files).sort(([a], [b]) => a.localeCompare(b)),
    })
  const fresh = (d) => d.report?.signature === snapshot(d) && d.report?.scenario === d.scenario
  const canUse = (d) => d.report?.state === 'passed' && fresh(d) && d.reviewed && !d.publishing
  const statusLabel = (status) =>
    ({
      pending: '待执行',
      running: '模拟中',
      passed: '通过',
      failed: '未通过',
      skipped: '未执行',
      cancelled: '已取消',
    })[status]
  function open(id, taskInput) {
    activeId = id
    if (!drafts.has(id))
      drafts.set(id, {
        id: `env-${drafts.size + 1}`,
        owner: id,
        step: 0,
        file: 'environment/Dockerfile',
        verifierFile: 'tests/test.sh',
        selectedCheck: 0,
        config: {
          name: 'empty-list-node',
          cpus: '1',
          memory: '1024',
          timeout: '120',
          network: 'none',
          hosts: '',
          provenance: '平台合成示例，需人工确认与当前任务匹配。',
        },
        taskInput,
        files: { ...seedFiles },
        scenario: 'success',
        report: null,
        reviewed: false,
        revisions: 0,
        lastPublished: null,
        notice: '',
        newPath: '',
      })
    const d = current()
    if (d.taskInput !== taskInput) {
      d.taskInput = taskInput
      d.reviewed = false
    }
  }
  function saveInputs() {
    const d = current()
    const form = document.getElementById('environment-form')
    if (!d || !form || busy(d)) return
    const before = snapshot(d)
    for (const input of form.querySelectorAll('[data-env-config]'))
      d.config[input.getAttribute('data-env-config')] = input.value
    const editor = document.getElementById('studio-code')
    if (editor) d.files[editor.getAttribute('data-path')] = editor.value
    const pathInput = document.getElementById('studio-new-path')
    if (pathInput) d.newPath = pathInput.value
    if (before !== snapshot(d)) d.reviewed = false
    const checkbox = document.getElementById('studio-review')
    if (checkbox && before === snapshot(d)) d.reviewed = checkbox.checked
  }
  function materialErrors(d) {
    const errors = []
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(d.config.name))
      errors.push('环境名称使用 2–60 位小写字母、数字或连字符。')
    if (!d.config.provenance.trim()) errors.push('请说明初始项目的来源与复用授权。')
    if (!d.taskInput.trim()) errors.push('当前任务输入为空，请返回任务包补齐。')
    if (
      !Number.isInteger(Number(d.config.timeout)) ||
      Number(d.config.timeout) < 10 ||
      Number(d.config.timeout) > 1800
    )
      errors.push('单次自检超时填写 10–1800 秒的整数。')
    if (d.config.network === 'allowlist' && !d.config.hosts.trim())
      errors.push('选择域名白名单后，需要填写允许访问的域名。')
    for (const path of Object.keys(seedFiles))
      if (!d.files[path]?.trim()) errors.push(`${path} 不能为空。`)
    if (
      d.files['environment/Dockerfile'] &&
      !/^FROM\s+\S+/im.test(d.files['environment/Dockerfile'])
    )
      errors.push('环境 Dockerfile 缺少 FROM 基础镜像声明。')
    try {
      JSON.parse(d.files['environment/project/package.json'])
    } catch {
      errors.push('package.json 不是有效 JSON。')
    }
    return errors
  }
  function reportLog(index, failed, scenario) {
    if (failed && scenario === 'build')
      return '模拟错误：基础镜像拉取失败。\n检查镜像名称、版本与构建网络，再重新自检。\n后续验证未执行，不能将它记为 Agent 失败。'
    if (failed && scenario === 'nop')
      return '模拟错误：未做任何修改，验证器也给出了通过结果。\n检查测试是否覆盖空数组，以及是否错误地固定返回 reward=1。\n本任务为修复任务，空跑应不通过。'
    if (failed && scenario === 'repeat')
      return '模拟错误：第 1 次参考解通过，第 2 次未通过。\n检查依赖、随机性、初始化数据和残留状态；重新自检全部阶段。'
    return [
      '本地检查：必需文件齐全、JSON 可解析、资源字段有效。\n未执行隐私扫描、许可证审核或恶意内容检查。',
      '模拟构建成功：Agent 镜像与独立验证镜像已准备。\n实际产品应记录构建日志、镜像摘要与构建器版本；这里没有真实镜像。',
      '模拟启动成功：初始项目可读取；新实例未继承上次文件和记忆。\n工作目录 /app；任务执行网络按所选策略设置。',
      '模拟 Oracle：应用 solution/solve.sh，再运行独立验证器。\n参考制品通过全部测试，reward=1。\n这验证题目可解，不是被测 Agent 的成绩。',
      '模拟 Nop：新建干净环境，不作修改，运行同一验证器。\n空数组用例仍失败，reward=0；符合本修复任务预期。',
      '模拟复现：第 1 次与第 2 次分别从全新实例开始。\n两次均为 Oracle=1、Nop=0，运行前初始制品一致。\n不能由一次成功或缓存命中替代重复复现。',
    ][index]
  }
  function runChecks(d) {
    const errors = materialErrors(d)
    d.reviewed = false
    if (errors.length) {
      d.notice = errors.join('\n')
      d.report = null
      onChange()
      return
    }
    d.notice = ''
    const report = {
      signature: snapshot(d),
      scenario: d.scenario,
      state: 'running',
      nodes: checks.map((title) => ({ title, state: 'pending', log: '尚未执行。' })),
    }
    d.report = report
    const failIndex = { success: -1, build: 1, nop: 4, repeat: 5 }[d.scenario]
    const advance = (index) => {
      if (report.state !== 'running') return
      report.nodes[index].state = 'running'
      d.selectedCheck = index
      onChange()
      d.timer = setTimeout(() => {
        if (report.state !== 'running') return
        const failed = index === failIndex
        report.nodes[index] = {
          title: checks[index],
          state: failed ? 'failed' : 'passed',
          log: reportLog(index, failed, report.scenario),
        }
        if (failed) {
          report.state = 'failed'
          report.nodes.slice(index + 1).forEach((node) => {
            node.state = 'skipped'
          })
        } else if (index === checks.length - 1) report.state = 'passed'
        else {
          advance(index + 1)
          return
        }
        onChange()
        document.getElementById('announcement').textContent = failed
          ? '模拟自检未通过。请查看失败节点并修正材料。'
          : '模拟自检通过。请人工复核后保存环境版本。'
      }, 400)
    }
    advance(0)
  }
  function configField(label, name, value, extra = '') {
    return `<label class="field">${label}<input id="studio-${name}" type="text" data-env-config="${name}" value="${esc(value)}" maxlength="${name === 'name' ? 60 : 500}" ${extra} /></label>`
  }
  function configView(d) {
    return `<h3 id="studio-step-title" tabindex="-1">定义可重建的运行条件</h3><p class="inspection-note">以可编辑的 Node 示例起步。平台保存构建配方和版本，不长期保留一个运行中的容器。</p>
      ${configField('环境名称', 'name', d.config.name)}
      <div class="studio-form-grid"><label class="field">CPU<select id="studio-cpus" data-env-config="cpus"><option value="1" ${d.config.cpus === '1' ? 'selected' : ''}>1 核</option><option value="2" ${d.config.cpus === '2' ? 'selected' : ''}>2 核</option></select></label><label class="field">内存<select id="studio-memory" data-env-config="memory"><option value="1024" ${d.config.memory === '1024' ? 'selected' : ''}>1 GB</option><option value="2048" ${d.config.memory === '2048' ? 'selected' : ''}>2 GB</option></select></label>${configField('单次自检超时 / 秒', 'timeout', d.config.timeout, 'inputmode="numeric"')}</div>
      <label class="field">任务执行时的网络<select id="studio-network" data-env-config="network"><option value="none" ${d.config.network === 'none' ? 'selected' : ''}>不访问外网</option><option value="allowlist" ${d.config.network === 'allowlist' ? 'selected' : ''}>仅允许指定域名</option></select><small>构建下载依赖与模型服务连接由平台单独管理；这里限定任务容器的网络。</small></label>
      ${d.config.network === 'allowlist' ? configField('允许访问的域名', 'hosts', d.config.hosts) : ''}
      <label class="field">项目来源与复用说明<textarea id="studio-provenance" data-env-config="provenance" maxlength="2000">${esc(d.config.provenance)}</textarea><small>仅填写获准使用的独立项目。不复制用户真实项目、密钥或本机路径。</small></label>
      <p class="note">当前 Node 样例无第三方依赖。引入依赖时应保留锁文件；发布时记录实际解析的基础镜像摘要。</p>`
  }
  function filesView(d, verifier) {
    const files = Object.keys(d.files).filter((path) =>
      verifier ? !path.startsWith('environment/') : path.startsWith('environment/'),
    )
    const selected = verifier ? d.verifierFile : d.file
    return `<h3 id="studio-step-title" tabindex="-1">${verifier ? '把验证器与参考解留在平台侧' : '准备 Agent 接手前的初始项目'}</h3><p class="inspection-note">${verifier ? '参考解用于证明题目可解；独立验证器判断 Agent 交付的制品。下面的脚本只编辑，不执行。' : '编辑 Dockerfile、初始代码与数据。不要把已修复版本、隐藏测试或答案烘焙进 Agent 镜像。'}</p>
      ${verifier ? '<div class="studio-boundary" aria-label="可信验证边界"><span>Agent 工作区<br><small>只交付允许的制品</small></span><span aria-hidden="true">→</span><span>独立验证容器<br><small>测试与依赖由平台提供</small></span></div>' : ''}
      <div class="studio-files"><ul aria-label="${verifier ? '验证文件' : '环境文件'}">${files.map((path) => `<li><button type="button" data-env-action="file" data-path="${esc(path)}" aria-pressed="${path === selected}">${esc(path.replace('environment/', ''))}<small>${path.startsWith('solution/') ? '仅参考解自检可见' : path.startsWith('tests/') ? '仅验证器可见' : 'Agent 环境'}</small></button></li>`).join('')}</ul><div class="studio-editor"><label for="studio-code">${esc(selected)}</label><textarea id="studio-code" data-path="${esc(selected)}" spellcheck="false" maxlength="20000">${esc(d.files[selected])}</textarea><p class="inspection-note">文本编辑器 · 未执行命令 · 修改后需重新自检</p></div></div>
      <details class="studio-add-file"><summary>添加一个文本文件</summary><label class="field">任务包内相对路径<input id="studio-new-path" type="text" value="${esc(d.newPath)}" placeholder="environment/project/src/helper.js" maxlength="160" /><small>仅支持 environment/、tests/、solution/ 下的相对路径；不填写主机路径。</small></label><button type="button" data-env-action="add-file">添加文件</button></details>
      ${verifier ? '<p class="note section-gap">Oracle 应通过；本修复样例的 Nop 应不通过。无需操作就正确的任务应另定义负例，不能机械套用 Nop 门槛。代码验证也不代替“如实报告”等语义验收。</p>' : '<p class="note section-gap">示例缺陷：sum([]) 会抛错；期望为空数组返回 0。是否代表当前候选问题，必须由任务作者确认。</p>'}`
  }
  function checksView(d) {
    const report = d.report
    const stale = report && !fresh(d)
    const nodes =
      report?.nodes ||
      checks.map((title) => ({
        title,
        state: 'pending',
        log: '点击“开始模拟自检”后逐步产生报告。',
      }))
    const node = nodes[d.selectedCheck]
    return `<h3 id="studio-step-title" tabindex="-1">先证明环境和题目本身可靠</h3><p class="inspection-note">当前检查完全模拟，不启动 Docker、不调用模型、不产生真实镜像。文件内容只进行本地材料检查。</p>
      <div class="studio-run-toolbar"><label class="field">演示分支<select id="studio-scenario"><option value="success" ${d.scenario === 'success' ? 'selected' : ''}>所有阶段通过</option><option value="build" ${d.scenario === 'build' ? 'selected' : ''}>构建失败</option><option value="nop" ${d.scenario === 'nop' ? 'selected' : ''}>空跑误通过</option><option value="repeat" ${d.scenario === 'repeat' ? 'selected' : ''}>两次复现不一致</option></select></label><button class="primary" type="button" data-env-action="run">${report ? '重新模拟自检' : '开始模拟自检'}</button></div>
      ${stale ? '<p class="note warn" role="status">材料或演示分支已变更：以下是旧报告，不能用于当前版本发布。请重新自检。</p>' : ''}
      <ol class="studio-pipeline" aria-label="环境自检节点">${nodes.map((item, index) => `<li><button type="button" data-env-action="check-node" data-index="${index}" class="${item.state}" aria-pressed="${index === d.selectedCheck}"><span>${index + 1}</span>${item.title}<small>${statusLabel(item.state)}</small></button></li>`).join('')}</ol>
      <section class="studio-log" aria-label="自检日志"><div class="panel-title"><h4>${esc(node.title)}</h4><span class="badge ${node.state === 'failed' ? 'error' : ''}">${statusLabel(node.state)}</span></div><pre>${esc(node.log)}</pre></section>
      ${report?.state === 'failed' ? `<div class="actions"><button type="button" data-env-action="step" data-step="${report.scenario === 'build' ? 1 : 2}">${report.scenario === 'build' ? '检查构建配方' : '检查验证与参考解'}</button><span class="inspection-note">修正后重新自检全部阶段，旧报告保留到重跑。</span></div>` : ''}
      <label class="check"><input id="studio-review" type="checkbox" ${d.reviewed ? 'checked' : ''} ${report?.state === 'passed' && !stale ? '' : 'disabled'} /><span>已人工确认任务匹配、素材复用授权和隐私，且参考解/验证器未泄漏给 Agent。<br><small>复选框仅演示复核动作；正式版还需服务端授权、内容扫描与人工审核记录。</small></span></label>
      <div class="actions"><button class="primary" type="button" data-env-action="use" ${canUse(d) ? '' : 'disabled'}>保存环境版本并使用（演示）</button><span class="inspection-note">${canUse(d) ? '将固定当前配方，回填到来源用例。' : '自检通过并人工确认后启用。'}</span></div>`
  }
  function manifest(d) {
    return `# 配置预览，参考 Harbor 的目录分工；未验证格式兼容性\n[task]\nname = ${JSON.stringify(d.config.name)}\nversion = "${d.revisions + 1}.0.0"\n\n[environment]\ncpus = ${Number(d.config.cpus)}\nmemory_mb = ${Number(d.config.memory)}\nnetwork_mode = "${d.config.network === 'none' ? 'no-network' : 'allowlist'}"\n${d.config.network === 'allowlist' ? 'allowed_hosts = ' + JSON.stringify(d.config.hosts.split(/[\s,]+/).filter(Boolean)) + '\n' : ''}\n[verifier]\nenvironment_mode = "separate"\ntimeout_sec = ${Number(d.config.timeout)}\n`
  }
  function view() {
    const d = current()
    const status = d.publishing
      ? '正在保存版本'
      : d.report?.state === 'running'
        ? '自检进行中'
        : d.report && !fresh(d)
          ? '自检已过期'
          : d.report?.state === 'passed'
            ? d.reviewed
              ? '可保存环境版本'
              : '待人工复核'
            : d.report?.state === 'failed'
              ? '自检未通过'
              : d.report?.state === 'cancelled'
                ? '自检已取消'
                : '环境草稿'
    return `<div class="studio-breadcrumb"><button class="link" data-env-action="back">返回当前用例</button><span> / 环境 / 制作环境</span></div><div class="page-head"><div><h2 id="page-title" tabindex="-1">制作可复现环境</h2><p>保存初始项目、运行条件和独立验证方式，让不同 Agent 面对同一道题。</p></div><span class="badge ${d.report?.state === 'failed' ? 'error' : ''}">${status}</span></div>
      <ol class="workflow studio-workflow" aria-label="环境制作步骤">${steps.map((title, index) => `<li><button data-env-action="step" data-step="${index}" ${d.step === index ? 'aria-current="step"' : ''}><span class="step-number">${index + 1}</span>${title}</button></li>`).join('')}</ol>
      <div class="studio-layout"><section class="panel"><form id="environment-form" novalidate><fieldset class="studio-fieldset" ${busy(d) ? 'disabled' : ''}>
      ${d.notice ? `<p class="message error studio-error" role="alert">${esc(d.notice)}</p>` : ''}
      ${d.step === 0 ? configView(d) : d.step === 1 || d.step === 2 ? filesView(d, d.step === 2) : checksView(d)}
      <div class="actions draft-actions"><button type="button" data-env-action="save">保存环境草稿</button><div>${d.step > 0 ? `<button type="button" data-env-action="step" data-step="${d.step - 1}">上一步</button>` : ''}${d.step < 3 ? `<button class="primary" type="button" data-env-action="step" data-step="${d.step + 1}">下一步：${steps[d.step + 1]}</button>` : ''}</div></div>
      </fieldset></form>${d.report?.state === 'running' ? '<div class="actions"><button data-env-action="cancel">取消模拟自检</button><span class="inspection-note" role="status">进行中的模拟检查可取消；编辑在本轮结束后恢复。</span></div>' : ''}</section>
      <aside class="studio-package" aria-label="任务包分区"><h3>这个版本会保存什么</h3><p>目录是交付边界，未发布的草稿不能用于正式评测。</p><dl><div><dt>instruction.md</dt><dd>沿用当前用例输入 · Agent 可见</dd></div><div><dt>environment/</dt><dd>${Object.keys(d.files).filter((p) => p.startsWith('environment/')).length} 个文件 · 初始项目与构建配方</dd></div><div><dt>tests/</dt><dd>独立验证环境 · 平台保管</dd></div><div><dt>solution/</dt><dd>参考解 · 仅题目自检使用</dd></div><div><dt>task.toml</dt><dd>资源、超时、网络与版本</dd></div></dl><details><summary>查看配置预览</summary><pre>${esc(manifest(d))}</pre></details><details><summary>查看当前用例输入</summary><p class="prose">${esc(d.taskInput)}</p></details>${d.lastPublished ? `<p class="note section-gap">上次使用：${esc(d.lastPublished.id)}<br>后续编辑生成新版本，不覆盖已引用版本。</p>` : ''}<details class="studio-sources"><summary>设计依据与边界</summary><p><a href="https://www.harborframework.com/docs/tasks" target="_blank" rel="noreferrer">Harbor 任务结构</a>：环境、验证与参考解分开。</p><p><a href="https://github.com/harbor-framework/terminal-bench/blob/main/docs/TASK_REVIEW_AUTOMATION.md" target="_blank" rel="noreferrer">Terminal-Bench 检查流程</a>：构建、Oracle、Nop 和人工审核。</p><p>资源默认值、离线网络、两次复现和本页布局是本项目的设计选择。未宣称所有框架都强制这些规则。</p></details></aside></div>`
  }
  function update() {
    onChange()
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-env-action]')
    if (!button || button.disabled || !current()) return
    const d = current()
    saveInputs()
    const action = button.getAttribute('data-env-action')
    if (busy(d) && !['back', 'cancel', 'step', 'check-node'].includes(action)) return
    if (action === 'back') {
      onBack()
      return
    }
    if (action === 'step') {
      d.step = Number(button.getAttribute('data-step'))
      d.notice = ''
      update()
      document.getElementById('studio-step-title')?.focus({ preventScroll: true })
    }
    if (action === 'file') {
      const path = button.getAttribute('data-path')
      if (d.step === 1) d.file = path
      else d.verifierFile = path
      update()
      document.getElementById('studio-code')?.focus({ preventScroll: true })
    }
    if (action === 'check-node') {
      d.selectedCheck = Number(button.getAttribute('data-index'))
      update()
      document
        .querySelector(`[data-env-action="check-node"][data-index="${d.selectedCheck}"]`)
        ?.focus({ preventScroll: true })
    }
    if (action === 'save') {
      d.notice = ''
      update()
      document.getElementById('announcement').textContent = '环境草稿已保留在本页，刷新后重置。'
    }
    if (action === 'add-file') {
      const path = d.newPath.trim()
      if (
        !/^(environment|tests|solution)\/[a-zA-Z0-9_./-]+$/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.env') ||
        d.files[path] !== undefined
      )
        d.notice = '请输入未使用的合法相对路径，不允许父目录、绝对路径或 .env。'
      else {
        d.files[path] = ''
        d.newPath = ''
        d.reviewed = false
        d.notice = ''
        d.step = path.startsWith('environment/') ? 1 : 2
        if (d.step === 1) d.file = path
        else d.verifierFile = path
      }
      update()
    }
    if (action === 'run') runChecks(d)
    if (action === 'cancel' && d.report?.state === 'running') {
      clearTimeout(d.timer)
      d.report.state = 'cancelled'
      d.report.nodes.forEach((node) => {
        if (['pending', 'running'].includes(node.state)) node.state = 'cancelled'
      })
      d.reviewed = false
      update()
      document.getElementById('announcement').textContent =
        '模拟自检已取消，已完成阶段保留；尚未获得可发布的检查报告。'
    }
    if (action === 'use' && canUse(d)) {
      const signature = snapshot(d)
      d.publishing = true
      update()
      try {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature))
        const digest = Array.from(new Uint8Array(bytes), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join('')
        if (d.lastPublished?.digest === digest) {
          d.publishing = false
          onUse(d.lastPublished)
          return
        }
        d.revisions++
        const recipe = {
          id: `${d.id}@${d.revisions}`,
          name: d.config.name,
          config: { ...d.config },
          files: { ...d.files },
          digest,
          simulated: true,
          sourceTrace: d.owner,
          taskInput: d.taskInput,
        }
        d.lastPublished = recipe
        d.publishing = false
        onUse(recipe)
      } catch {
        d.publishing = false
        d.notice = '生成配方摘要失败。草稿已保留，请重试。'
        update()
      }
    }
  })
  document.addEventListener('input', (event) => {
    if (!event.target.closest('#environment-form') || !current() || busy(current())) return
    if (event.target.id === 'studio-review' || event.target.id === 'studio-scenario') return
    saveInputs()
    const use = document.querySelector('[data-env-action="use"]')
    if (use) use.disabled = true
  })
  document.addEventListener('change', (event) => {
    if (!event.target.closest('#environment-form') || !current() || busy(current())) return
    const d = current()
    saveInputs()
    if (event.target.id === 'studio-scenario') {
      d.scenario = event.target.value
      d.reviewed = false
    }
    if (event.target.tagName === 'SELECT' || event.target.type === 'checkbox') {
      update()
      document.getElementById(event.target.id)?.focus({ preventScroll: true })
    }
  })
  return { open, view, saveInputs }
}
