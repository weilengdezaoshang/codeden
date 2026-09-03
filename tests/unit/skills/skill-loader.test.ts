import { describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SkillLoader } from '../../../packages/agent-runtime/src/skills/skill-loader.js'

describe('测试套件：SkillLoader', () => {
  it('验证：发现技能并使用项目定义覆盖用户定义', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-skills-'))
    const home = await mkdtemp(path.join(tmpdir(), 'codeden-skills-home-'))
    try {
      await mkdir(path.join(home, '.codeden', 'skills', 'review'), { recursive: true })
      await mkdir(path.join(root, '.codeden', 'skills', 'review'), { recursive: true })
      await writeFile(
        path.join(home, '.codeden', 'skills', 'review', 'SKILL.md'),
        '---\nname: review\ndescription: 用户版\n---\n旧提示',
      )
      await writeFile(
        path.join(root, '.codeden', 'skills', 'review', 'SKILL.md'),
        '---\nname: review\ndescription: 项目版\nallowed-tools: [read_file]\n---\n检查代码',
      )
      const skills = await new SkillLoader({ projectRoot: root, userHome: home }).discover()
      expect(skills).toHaveLength(1)
      expect(skills[0]?.description).toBe('项目版')
      expect(skills[0]?.allowedTools).toEqual(['read_file'])
      expect(skills[0]?.prompt).toBe('检查代码')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('验证：跳过缺失必填元数据的技能', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codeden-skills-'))
    try {
      await mkdir(path.join(root, '.codeden', 'skills', 'broken'), { recursive: true })
      await writeFile(
        path.join(root, '.codeden', 'skills', 'broken', 'SKILL.md'),
        '---\nname: broken\n---\n内容',
      )
      expect(await new SkillLoader({ projectRoot: root }).discover()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
