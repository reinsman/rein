import { expect, test } from '@playwright/test'

test('a side chat forks one Agent reply and keeps its first message as the title', async ({
  page,
  request,
}) => {
  const { agents } = await (await request.get('/api/agents')).json()
  const { executable, directory, native_config } = agents.find(
    (agent: { name: string }) => agent.name === 'codex',
  )
  expect(
    (
      await request.post('/api/agents', {
        data: { name: 'fork-codex', provider: 'codex', executable, directory, native_config },
      })
    ).ok(),
  ).toBe(true)
  expect(
    (await request.post('/api/agents/fork-codex/availability', { data: { enabled: true } })).ok(),
  ).toBe(true)
  await page.setViewportSize({ width: 1720, height: 960 })
  await page.goto('/')
  await page.getByRole('button', { name: '与fork-codex对话', exact: true }).click()
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  const main = page.getByRole('region', { name: 'Agent 对话', exact: true })
  const composer = main.getByRole('textbox', { name: '发送消息', exact: true })
  await composer.fill('主对话第一条消息')
  await composer.press('Enter')
  await expect(main.getByText('Hello 1', { exact: true })).toBeVisible()
  await composer.fill('主对话之后的消息')
  await composer.press('Enter')
  await expect(main.getByText('Hello 2', { exact: true })).toBeVisible()
  const { session_id } = await (await request.get('/api/agents/fork-codex/history')).json()
  const forkList = `/api/sessions/${session_id}/forks`
  let forkSubmissions = 0
  page.on('request', (entry) => {
    if (entry.method() === 'POST' && new URL(entry.url()).pathname.endsWith('/fork'))
      forkSubmissions++
  })
  const origin = main.locator('.agent-message').filter({ hasText: 'Hello 1' })
  await origin.hover()
  const frame = page.locator('.split-layout > .chat-panes')
  const originalWidth = (await frame.boundingBox())!.width
  const start = origin.getByRole('button', { name: '创建侧边对话', exact: true })
  await start.click()

  const side = page.getByRole('region', { name: '侧边对话', exact: true })
  const sideComposer = side.getByRole('textbox', { name: '发送侧边对话消息' })
  const inherited = side.getByRole('region', { name: '继承的历史' })
  const divider = page.getByRole('separator', { name: '调整主栏与侧边对话宽度' })
  const todoDivider = page.getByRole('separator', { name: '调整聊天与任务栏宽度' })
  await expect(inherited.getByText('主对话第一条消息', { exact: true })).toBeVisible()
  await expect(inherited.getByText('Hello 1', { exact: true })).toBeVisible()
  await expect(inherited.getByText('主对话之后的消息')).toHaveCount(0)
  await expect(side.getByText('从这里继续', { exact: true })).toBeVisible()
  await expect(side.getByRole('heading', { name: '侧边对话' })).toBeVisible()
  await sideComposer.fill('只编辑草稿')
  await expect(side.getByRole('button', { name: '侧边对话操作', exact: true })).toHaveCount(0)
  await side.getByRole('button', { name: '关闭侧边对话', exact: true }).click()
  await expect(side).toHaveCount(0)
  expect(await (await request.get(forkList)).json()).toEqual([])
  expect(forkSubmissions).toBe(0)

  const workspace = page.locator('.split-layout')
  const memory = page.getByRole('region', { name: 'Memory 栏' })
  async function expectNoHorizontalOverflow() {
    await expect
      .poll(() => workspace.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    )
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(originalWidth)
  const originalMainAt1440 = (await main.boundingBox())!.width
  await start.click()
  await expect(side).toHaveCSS('width', '360px')
  await expect(memory).toHaveCSS('width', '360px')
  expect((await main.boundingBox())!.width).toBeLessThan(originalMainAt1440)
  await todoDivider.press('ArrowRight')
  await expect(memory).toHaveCSS('width', '360px')
  await expectNoHorizontalOverflow()
  await side.getByRole('button', { name: '关闭侧边对话', exact: true }).click()

  await page.setViewportSize({ width: 1720, height: 960 })
  await start.click()
  await expect
    .poll(async () => (await frame.boundingBox())!.width - originalWidth)
    .toBeGreaterThanOrEqual(360)
  await expect(side).toHaveCSS('width', '360px')
  const todoBefore = (await todoDivider.boundingBox())!.x
  await divider.press('ArrowLeft')
  await expect(side).toHaveCSS('width', '384px')
  expect((await todoDivider.boundingBox())!.x).toBe(todoBefore)
  const handle = (await divider.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x - 24, handle.y + handle.height / 2, { steps: 3 })
  await page.mouse.up()
  await expect.poll(async () => (await side.boundingBox())!.width).toBeGreaterThan(400)
  expect((await todoDivider.boundingBox())!.x).toBe(todoBefore)
  await divider.dblclick()
  await expect
    .poll(async () =>
      Math.abs((await main.boundingBox())!.width - (await side.boundingBox())!.width),
    )
    .toBeLessThanOrEqual(1)
  expect((await todoDivider.boundingBox())!.x).toBe(todoBefore)
  for (let count = 0; count < 20; count++) await divider.press('ArrowLeft')
  await expect(main).toHaveCSS('width', '360px')
  await side.getByRole('button', { name: '定位原消息', exact: true }).click()
  await expect(origin).toBeFocused()

  const title = '把无备用目录和配置目录失效这两种情况都单独验证，并把结果总结给我'
  await sideComposer.fill(title)
  await sideComposer.press('Enter')
  await expect(side.getByText('Hello 2', { exact: true })).toBeVisible()
  const abbreviated = Array.from(title).slice(0, 28).join('') + '…'
  await expect(side.getByRole('heading')).toHaveText(abbreviated)
  await expect(side.getByRole('heading')).toHaveAttribute('title', title)
  await expect(main.getByText(title, { exact: true })).toHaveCount(0)
  await sideComposer.fill('补充一条侧边消息')
  await sideComposer.press('Enter')
  await expect(side.getByText('Hello 3', { exact: true })).toBeVisible()
  expect(forkSubmissions).toBe(1)
  await expect(side.getByRole('heading')).toHaveText(abbreviated)
  const reopen = origin.getByRole('button', { name: '打开侧边对话，4 条消息', exact: true })
  await expect(reopen).toBeVisible()
  await page.screenshot({ path: 'test-results/chat-fork-desktop.png', animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 960 })
  const switcher = page.getByRole('group', { name: '切换聊天栏' })
  await expect(side).toBeVisible()
  await expect(main).toBeHidden()
  await expect(divider).toHaveCount(0)
  expect((await memory.boundingBox())!.width).toBeGreaterThanOrEqual(360)
  await expectNoHorizontalOverflow()
  await side.getByRole('button', { name: '定位原消息', exact: true }).click()
  await expect(origin).toBeFocused()
  await expect(side).toBeHidden()
  await switcher.getByRole('button', { name: '侧边对话', exact: true }).click()
  await expect(side.getByRole('heading')).toHaveText(abbreviated)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(side).toBeVisible()
  await expectNoHorizontalOverflow()
  await switcher.getByRole('button', { name: '主 Chat', exact: true }).click()
  await expect(main).toBeVisible()
  await expectNoHorizontalOverflow()
  await page.setViewportSize({ width: 1720, height: 960 })
  await side.getByRole('button', { name: '关闭侧边对话', exact: true }).click()
  await expect(side).toHaveCount(0)
  await expect.poll(async () => (await frame.boundingBox())!.width).toBe(originalWidth)
  await page.reload()
  await reopen.click()
  await expect(side.getByRole('heading')).toHaveText(abbreviated)
  await side.getByRole('button', { name: '侧边对话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除侧边对话', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除侧边对话？' })
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await expect(side).toHaveCount(0)
  await expect(reopen).toHaveCount(0)
  await expect(origin.getByRole('button', { name: '创建侧边对话', exact: true })).toHaveCount(1)
  await expect(main.getByText('主对话之后的消息', { exact: true })).toBeVisible()
})
