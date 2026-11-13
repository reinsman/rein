import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const titles = ['需求规格与验收标准', '技术设计与约束', '开发实现', '验证与验收']
const openTask = (page: Page, title: string) =>
  page.getByRole('button', { name: `打开任务 ${title}`, exact: true }).click()
const detail = (page: Page) => page.locator('.task-detail')

async function newRequirement(page: Page, project: string, requirement: string) {
  await page.goto('/')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill(project)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: `在${project}中新建需求`, exact: true }).click()
  await page.getByRole('textbox', { name: '需求名称', exact: true }).fill(requirement)
  await page
    .getByRole('textbox', { name: '描述', exact: true })
    .fill('项目支持多个工作目录，并能指定首选目录。')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('heading', { name: requirement, exact: true })).toBeVisible()
}
async function legacyProject(request: APIRequestContext, name: string) {
  const project = {
    id: randomUUID(),
    name,
    description: '',
    directories: [],
    preferred_directory: null,
    requirements: [
      {
        id: randomUUID(),
        title: `${name}需求`,
        description: '',
        tasks: [{ id: randomUUID(), title: '原有任务', status: 'todo' }],
      },
    ],
  }
  const response = await request.post('/api/projects', { data: { project } })
  expect(response.ok()).toBeTruthy()
  return project
}
async function selectRequirement(page: Page, project: string, requirement: string) {
  await page.goto('/')
  await page.getByRole('button', { name: `展开项目 ${project}`, exact: true }).click()
  await page.getByRole('button', { name: requirement, exact: true }).click()
}

test('SDD stages persist documents, respect dependencies, and close the repair loop', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newRequirement(page, 'SDD 开发流程', '多工作目录支持')
  await expect(page.locator('.task-group-todo .task-card')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '初始化 SDD', exact: true })).toHaveCount(0)
  await openTask(page, titles[1])
  await expect(detail(page).getByRole('button', { name: '开始任务', exact: true })).toBeDisabled()
  await expect(detail(page)).toContainText('等待 T-01 Spec 完成')
  await page.keyboard.press('Escape')
  await page
    .locator('.task-card')
    .filter({ hasText: titles[1] })
    .getByRole('button', { name: /任务操作$/ })
    .click()
  await page.getByRole('menuitem', { name: '移至进行中', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('等待 T-01 Spec 完成')
  await openTask(page, titles[0])
  await detail(page).getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('进行中')
  await detail(page)
    .getByRole('textbox', { name: '需求规格', exact: true })
    .fill(
      '## 目标与范围\n支持多个本地工作目录。\n\n## 边界\n目录必须存在，删除首选目录后使用第一个有效目录。',
    )
  await detail(page).getByRole('button', { name: '添加验收标准', exact: true }).click()
  await detail(page)
    .getByRole('textbox', { name: '验收标准 1', exact: true })
    .fill('删除首选目录后，回退到第一个有效目录。')
  await detail(page).getByLabel('负责人', { exact: true }).selectOption('codex')
  await detail(page).getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(detail(page).getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled()
  await detail(page).getByRole('button', { name: '预览', exact: true }).click()
  await expect(detail(page).getByRole('heading', { name: '目标与范围', exact: true })).toBeVisible()
  await page.screenshot({
    path: 'test-results/sdd-spec-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await detail(page).getByRole('button', { name: '确认并完成', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('已完成')
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-group-done')).toContainText(titles[0])
  await openTask(page, titles[1])
  await detail(page).getByRole('button', { name: '开始任务', exact: true }).click()
  await detail(page)
    .getByRole('textbox', { name: '技术设计', exact: true })
    .fill(
      '## 实现边界\n沿用项目配置，不引入额外服务。\n\n## 数据结构\n```ts\ndirectories: string[]\npreferred_directory: string | null\n```\n\n## 异常处理\n禁止重复路径；删除首选目录后重新计算首选项。',
    )
  await detail(page).getByRole('button', { name: '保存草稿', exact: true }).click()
  await detail(page).getByRole('button', { name: '预览', exact: true }).click()
  await page.screenshot({
    path: 'test-results/sdd-design-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await detail(page).getByRole('button', { name: '确认并完成', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('已完成')
  await page.keyboard.press('Escape')
  await openTask(page, titles[2])
  await detail(page).getByRole('button', { name: '开始任务', exact: true }).click()
  await detail(page).getByRole('button', { name: '添加子任务', exact: true }).click()
  await detail(page)
    .getByRole('textbox', { name: '开发子任务 1', exact: true })
    .fill('实现路径校验与首选目录回退')
  await expect(detail(page).getByRole('button', { name: '完成开发', exact: true })).toBeDisabled()
  await detail(page).getByRole('checkbox', { name: '完成子任务 1', exact: true }).check()
  await page.screenshot({
    path: 'test-results/sdd-development-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await detail(page).getByRole('button', { name: '完成开发', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('已完成')
  await page.keyboard.press('Escape')
  await openTask(page, titles[3])
  await detail(page).getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(detail(page).getByRole('button', { name: '确认验收', exact: true })).toBeDisabled()
  await detail(page).getByLabel('验收结果 AC-01', { exact: true }).selectOption('failed')
  await detail(page)
    .getByRole('textbox', { name: '验证证据 AC-01', exact: true })
    .fill('人工检查发现删除后仍保留失效目录，需要修复。')
  await page.screenshot({
    path: 'test-results/sdd-verification-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await detail(page).getByRole('button', { name: '保存并返回开发修复', exact: true }).click()
  await expect(detail(page).getByRole('tab', { name: '开发子任务', exact: true })).toBeVisible()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('进行中')
  await detail(page).getByRole('button', { name: '添加子任务', exact: true }).click()
  await detail(page)
    .getByRole('textbox', { name: '开发子任务 2', exact: true })
    .fill('修复删除后的回退路径，并重新检查')
  await detail(page).getByRole('checkbox', { name: '完成子任务 2', exact: true }).check()
  await detail(page).getByRole('button', { name: '完成开发', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('已完成')
  await page.keyboard.press('Escape')
  await openTask(page, titles[3])
  await detail(page).getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(detail(page).getByLabel('验收结果 AC-01', { exact: true })).toHaveValue('pending')
  await detail(page).getByLabel('验收结果 AC-01', { exact: true }).selectOption('passed')
  await detail(page)
    .getByRole('textbox', { name: '验证证据 AC-01', exact: true })
    .fill('重新人工检查：删除首选目录后已回退到第一个有效目录。')
  await detail(page).getByRole('button', { name: '确认验收', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('已完成')
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-group-done .task-card')).toHaveCount(4)
  await page.reload()
  await page.getByRole('button', { name: '展开项目 SDD 开发流程', exact: true }).click()
  await page.getByRole('button', { name: '多工作目录支持', exact: true }).click()
  await expect(page.locator('.task-group-done .task-card')).toHaveCount(4)
  await openTask(page, titles[0])
  await detail(page).getByRole('button', { name: '重新打开', exact: true }).click()
  await expect(detail(page).locator('.sdd-task-status')).toHaveText('进行中')
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-group-todo .task-card')).toHaveCount(3)
  const stored = (await (await request.get('/api/projects')).json()).projects.find(
    (project: { name: string }) => project.name === 'SDD 开发流程',
  )
  const tasks = stored.requirements[0].tasks
  expect(tasks.find((task: { type: string }) => task.type === 'spec').document).toContain(
    '目标与范围',
  )
  expect(tasks.find((task: { type: string }) => task.type === 'tasks').subtasks).toHaveLength(2)
  expect(
    tasks.find((task: { type: string }) => task.type === 'verification').checks[0].status,
  ).toBe('pending')
  expect(errors).toEqual([])
})

test('legacy tasks remain intact and SDD initialization is persistent and idempotent', async ({
  page,
  request,
}) => {
  const project = await legacyProject(request, '旧需求兼容')
  await selectRequirement(page, project.name, project.requirements[0].title)
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.getByRole('button', { name: '初始化 SDD', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '初始化 SDD', exact: true })).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: `展开项目 ${project.name}`, exact: true }).click()
  await page.getByRole('button', { name: project.requirements[0].title, exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '打开任务 原有任务', exact: true })).toBeVisible()
})

test('the floating task drawer preserves resize, expand, focus, unsaved drafts and mobile behavior', async ({
  page,
  request,
}) => {
  const project = await legacyProject(request, '抽屉交互')
  await selectRequirement(page, project.name, project.requirements[0].title)
  await page.getByRole('button', { name: '初始化 SDD', exact: true }).click()
  await openTask(page, titles[0])
  await expect(detail(page)).toBeVisible()
  const initial = await detail(page).boundingBox()
  const titleEdge = await page
    .locator('.task-panel h2')
    .evaluate((element) => element.getBoundingClientRect().right)
  expect(Math.abs(initial!.x - titleEdge)).toBeLessThan(2)
  await expect(page.locator('.MuiBackdrop-root:visible')).toHaveCount(0)
  const separator = page.getByRole('separator', { name: '调整任务详情宽度', exact: true })
  await separator.focus()
  await page.keyboard.press('ArrowLeft')
  const wider = Number(await separator.getAttribute('aria-valuenow'))
  expect(wider).toBeGreaterThan(initial!.width)
  await page.getByRole('button', { name: '展开任务详情', exact: true }).click()
  expect(Math.abs((await detail(page).boundingBox())!.x - 296)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '恢复抽屉宽度', exact: true }).click()
  expect(Math.abs((await detail(page).boundingBox())!.width - wider)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await expect(detail(page)).toBeVisible()
  await detail(page)
    .getByRole('textbox', { name: '需求规格', exact: true })
    .fill('尚未保存的规格内容')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '草稿尚未保存', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '草稿尚未保存', exact: true })).toHaveCount(0)
  await expect(detail(page).getByRole('textbox', { name: '需求规格', exact: true })).toHaveValue(
    '尚未保存的规格内容',
  )
  await detail(page).getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(detail(page).getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled()
  await expect(detail(page).locator('.sdd-editor-fields')).not.toHaveAttribute('disabled')
  await page.keyboard.press('Escape')
  await expect(detail(page)).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: `打开任务 ${titles[0]}`, exact: true }),
  ).toBeFocused()
  await openTask(page, titles[0])
  expect(Math.abs((await detail(page).boundingBox())!.width - wider)).toBeLessThanOrEqual(1)
  await detail(page).getByRole('button', { name: '编辑', exact: true }).click()
  await expect(detail(page).getByRole('textbox', { name: '需求规格', exact: true })).toHaveValue(
    '尚未保存的规格内容',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(detail(page).getByRole('button', { name: '开始任务', exact: true })).toBeVisible()
  expect((await detail(page).boundingBox())!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({
    path: 'test-results/sdd-drawer-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('separator', { name: '调整任务详情宽度', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  expect(
    Number(
      await page
        .getByRole('separator', { name: '调整任务详情宽度', exact: true })
        .getAttribute('aria-valuenow'),
    ),
  ).toBeGreaterThanOrEqual(260)
  await page.mouse.click(12, 300)
  await expect(detail(page)).toHaveCount(0)
})
