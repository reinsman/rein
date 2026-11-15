import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const titles = ['需求规格与验收标准', '技术设计与约束', '开发实现', '验证与验收']
const openTask = (page: Page, title: string) =>
  page.getByRole('button', { name: `打开任务 ${title}`, exact: true }).click()
const detail = (page: Page) => page.locator('.task-detail')

async function legacyProject(request: APIRequestContext, name: string, withSpec = false) {
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
        tasks: [
          { id: randomUUID(), title: '原有任务', status: 'todo' },
          ...(withSpec
            ? [{ id: randomUUID(), title: titles[0], status: 'todo', type: 'spec' }]
            : []),
        ],
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

test('drawer double-click expands and unwinds to the saved drag position', async ({
  page,
  request,
}) => {
  const project = await legacyProject(request, '抽屉双击')
  await selectRequirement(page, project.name, project.requirements[0].title)
  await openTask(page, '原有任务')
  const separator = page.getByRole('separator', { name: '调整任务详情宽度', exact: true })
  const width = () => separator.getAttribute('aria-valuenow').then(Number)
  const todoWidth = await page
    .locator('.task-panel')
    .evaluate((element) => element.getBoundingClientRect().width)
  async function dragTo(nextWidth: number) {
    const box = (await separator.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(1440 - nextWidth, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
  }
  async function expectWidth(expected: number) {
    await expect.poll(async () => Math.abs((await width()) - expected)).toBeLessThanOrEqual(1)
  }
  await dragTo(400)
  const savedRatio = await page.evaluate(() => localStorage.getItem('rein.detailRatio'))
  await separator.dblclick()
  await expectWidth(todoWidth)
  await separator.dblclick()
  await expectWidth(1440 - 296)
  await separator.dblclick()
  await expectWidth(todoWidth)
  await separator.dblclick()
  await expectWidth(400)
  expect(await page.evaluate(() => localStorage.getItem('rein.detailRatio'))).toBe(savedRatio)

  // The button and separator share one history, including when used alternately.
  await page.getByRole('button', { name: '覆盖 Todo 栏', exact: true }).click()
  await expectWidth(todoWidth)
  await separator.dblclick()
  await expectWidth(1440 - 296)
  await page.getByRole('button', { name: '缩回 Todo 栏', exact: true }).click()
  await expectWidth(todoWidth)
  await separator.dblclick()
  await expectWidth(400)

  // A custom position already covering Todo must expand directly to the chat edge.
  await dragTo(todoWidth + 40)
  await separator.dblclick()
  await expectWidth(1440 - 296)
  await separator.dblclick()
  await expectWidth(todoWidth)
  await separator.dblclick()
  await expectWidth(todoWidth + 40)

  await dragTo(todoWidth)
  await separator.dblclick()
  await expectWidth(1440 - 296)
  await separator.dblclick()
  await expectWidth(todoWidth)
  // Dragging while unwinding starts a new cycle from the new custom width.
  await dragTo(420)
  await separator.focus()
  await page.keyboard.press('Enter')
  await expectWidth(todoWidth)
  await page.keyboard.press('Enter')
  await expectWidth(1440 - 296)
  await page.keyboard.press('Enter')
  await expectWidth(todoWidth)
  await page.keyboard.press('Enter')
  await expectWidth(420)
  await page.keyboard.press('Escape')
  await openTask(page, '原有任务')
  await expectWidth(420)
})

test('the floating task drawer preserves resize, expand, focus, unsaved drafts and mobile behavior', async ({
  page,
  request,
}) => {
  const project = await legacyProject(request, '抽屉交互', true)
  await selectRequirement(page, project.name, project.requirements[0].title)
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
  await page.getByRole('button', { name: '覆盖 Todo 栏', exact: true }).click()
  const todoEdge = await page
    .locator('.task-panel')
    .evaluate((element) => element.getBoundingClientRect().left)
  expect(
    Math.abs((await page.locator('.MuiDrawer-paper').boundingBox())!.x - todoEdge),
  ).toBeLessThan(0.1)
  await page.getByRole('button', { name: '覆盖群聊栏', exact: true }).click()
  expect(Math.abs((await detail(page).boundingBox())!.x - 296)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '缩回 Todo 栏', exact: true }).click()
  expect(
    Math.abs((await page.locator('.MuiDrawer-paper').boundingBox())!.x - todoEdge),
  ).toBeLessThan(0.1)
  await page.getByRole('button', { name: '恢复自定义宽度', exact: true }).click()
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
