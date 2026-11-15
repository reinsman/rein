import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function projectWithSpec(request: APIRequestContext, name: string) {
  const { agents } = await (await request.get('/api/agents')).json()
  const directory = agents.find((agent: { name: string }) => agent.name === 'pi').directory
  const requirement = { id: randomUUID(), title: `${name}需求`, description: '', tasks: [] }
  const project = {
    id: randomUUID(),
    name,
    description: '',
    directories: [directory],
    preferred_directory: directory,
    requirements: [requirement],
  }
  expect(
    (await request.post('/api/projects', { data: { project, previous: null } })).ok(),
  ).toBeTruthy()
  await request.post('/api/workflow/settings', {
    data: { main_agent: 'pi', coding_agents: ['pi'], review_agents: ['codex'], automatic: false },
  })
  return { project, requirement }
}
async function select(page: Page, project: string, requirement: string) {
  await page.goto('/')
  await page.getByRole('button', { name: `展开项目 ${project}`, exact: true }).click()
  await page.getByRole('button', { name: requirement, exact: true }).click()
}
test('Spec build and verification use the shared queue and real handoff artifacts', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { project, requirement } = await projectWithSpec(request, 'Spec 编排')
  await select(page, project.name, requirement.title)
  await expect(page.locator('.task-card')).toHaveCount(0)
  await page.getByRole('button', { name: `新建 Spec ${requirement.title}`, exact: true }).click()
  await page.getByRole('textbox', { name: 'Spec 名称', exact: true }).fill('首选目录回退')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: `${requirement.title} - 首选目录回退`, exact: true }),
  ).toBeVisible()
  await expect(page.locator('.spec-tree .lucide-waypoints')).toHaveCount(1)
  const snapshot = await (await request.get('/api/workflow')).json()
  const spec = snapshot.specs.find(
    (s: { requirement_id: string }) => s.requirement_id === requirement.id,
  )
  const plan = {
    criteria: [
      { id: 'AC-01', text: '首选目录可以自动回退' },
      { id: 'AC-02', text: '无有效目录时提示补充' },
    ],
    tasks: [
      {
        id: 'T-01',
        title: '实现首选目录回退',
        description: '持久化回退结果',
        acceptance_ids: ['AC-01'],
      },
      {
        id: 'T-02',
        title: '补齐空目录提示',
        description: '阻止无效目录执行',
        acceptance_ids: ['AC-02'],
      },
    ],
  }
  for (const [file, content] of Object.entries({
    'requirements.md': '# 首选目录回退\n删除首选目录时选择第一个有效目录。',
    'design.md': '# 技术设计\n沿用现有项目配置。',
    'tasks.md': '- [ ] [T-01] 实现首选目录回退\n- [ ] [T-02] 补齐空目录提示',
    'plan.json': JSON.stringify(plan),
  }))
    expect(
      (await request.post(`/api/artifacts/${spec.id}/${file}`, { data: { content } })).ok(),
    ).toBeTruthy()
  await expect(page.locator('.spec-panel')).toContainText('删除首选目录时选择第一个有效目录。', {
    timeout: 8000,
  })
  await page.screenshot({
    path: 'test-results/spec-requirements-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await page.getByRole('button', { name: '确认需求，继续设计', exact: true }).click()
  await page.getByRole('tab', { name: '设计', exact: true }).click()
  await expect(page.locator('.spec-panel')).toContainText('沿用现有项目配置。')
  await page.getByRole('button', { name: '确认设计，拆分任务', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: '开始构建', exact: true }).click()
  await expect(page.locator('.spec-panel')).toContainText('待开始')
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Todo', exact: true })).toBeVisible()
  await expect(page.locator('.task-card').filter({ hasText: '实现首选目录回退' })).toContainText(
    'Coding',
  )
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.screenshot({
    path: 'test-results/spec-todo-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await request.post('/api/workflow/settings', {
    data: { main_agent: 'pi', coding_agents: ['pi'], review_agents: ['codex'], automatic: true },
  })
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/workflow')).json()).specs.find(
          (s: { id: string }) => s.id === spec.id,
        ).phase,
      { timeout: 15000 },
    )
    .toBe('ready_verification')
  await page.getByRole('button', { name: '打开 Spec 首选目录回退', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await expect(page.locator('.spec-panel')).toContainText('2 / 2 已完成')
  await expect(
    page.locator('.spec-panel').getByRole('button', { name: /Coding Handoff/ }),
  ).toHaveCount(2)
  await page
    .locator('.spec-panel')
    .getByRole('button', { name: '实现首选目录回退', exact: true })
    .click()
  await expect(page.locator('.task-detail')).toBeVisible()
  await expect(page.getByRole('button', { name: '覆盖 Spec 栏', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '工作记录', exact: true }).click()
  await expect(page.locator('.task-detail')).toContainText('Hello 1')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '提交验证', exact: true }).click()
  await page.getByRole('tab', { name: '验证', exact: true }).click()
  await expect(page.getByRole('button', { name: '完成验证', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await page.getByRole('button', { name: '完成验证', exact: true }).click()
  await expect(page.locator('.spec-phase-status')).toContainText('已完成')
  await page.screenshot({
    path: 'test-results/spec-verification-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await expect(page.locator('.task-group-done .task-card')).toHaveCount(4)
  await page
    .locator('.task-group-done')
    .getByRole('button', { name: /Coding Handoff/ })
    .first()
    .click()
  await expect(page.getByRole('dialog')).toContainText('本次按照任务范围完成实现检查')
  await page.getByRole('button', { name: '关闭交接文件', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await page.getByRole('button', { name: '打开 Spec 首选目录回退', exact: true }).click()
  await page.getByRole('button', { name: 'Spec', exact: true }).click()
  await page.screenshot({
    path: 'test-results/spec-mobile.png',
    animations: 'disabled',
    fullPage: true,
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  expect(errors).toEqual([])
})

test('Spec conversations stay isolated and requirement chat creates direct tasks', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '会话隔离')
  for (const title of ['Spec A', 'Spec B'])
    expect(
      (
        await request.post('/api/specs', {
          data: { requirement_id: requirement.id, title, description: '' },
        })
      ).ok(),
    ).toBeTruthy()
  await select(page, project.name, requirement.title)
  await page.getByRole('button', { name: '打开 Spec Spec A', exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('只属于 A 的讨论')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.getByText('Hello 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开 Spec Spec B', exact: true }).click()
  await expect(page.getByText('只属于 A 的讨论', { exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('只属于 B 的讨论')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.getByText('Hello 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开 Spec Spec A', exact: true }).click()
  await expect(page.getByText('只属于 A 的讨论', { exact: true })).toBeVisible()
  await expect(page.getByText('只属于 B 的讨论', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('添加任务：补充配置文档')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.locator('.task-card').filter({ hasText: '补充配置文档' })).toContainText(
    '直接任务',
  )
  const state = await (await request.get('/api/workflow')).json()
  expect(
    state.tasks.find((task: { title: string }) => task.title === '补充配置文档').spec_id,
  ).toBeNull()
  await page.getByRole('button', { name: '需求配置', exact: true }).click()
  await page.getByRole('button', { name: '执行环境', exact: true }).click()
  await expect(page.getByLabel('pi任务角色', { exact: true })).toHaveValue('coding')
  await expect(page.getByLabel('codex任务角色', { exact: true })).toHaveValue('review')
  await page.getByLabel('主 Agent', { exact: true }).selectOption('codex')
  await page.getByRole('button', { name: '保存编排配置', exact: true }).click()
  await expect
    .poll(async () => (await (await request.get('/api/workflow')).json()).settings.main_agent)
    .toBe('codex')
  await page.screenshot({
    path: 'test-results/workflow-settings-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
})
