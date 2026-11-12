import { test, expect } from '@playwright/test'

async function openNavigation(page: import('@playwright/test').Page) {
  if (await page.getByRole('button', { name: '展开侧栏', exact: true }).isVisible())
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
}

test('original shell, project tree and task board persist without workspace or project chat', async ({
  page,
  request,
}) => {
  let projectReads = 0
  let agentReads = 0
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const path = new URL(req.url()).pathname
    if (path === '/api/projects') projectReads++
    if (path === '/api/agents') agentReads++
  })
  const { agents } = await (await request.get('/api/agents')).json()
  const firstDirectory = agents.find((agent: { name: string }) => agent.name === 'pi').directory
  const secondDirectory = agents.find((agent: { name: string }) => agent.name === 'codex').directory
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '选择需求或 Agent' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '项目导航' })).toHaveCSS('width', '296px')
  await expect(page.getByRole('separator', { name: '调整聊天与任务栏宽度' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Todo', exact: true })).toBeVisible()
  await expect(page.getByText('工作空间', { exact: false })).toHaveCount(0)
  await expect(page.getByText('项目对话', { exact: true })).toHaveCount(0)
  await expect.poll(() => agentReads, { timeout: 8000 }).toBeGreaterThan(2)
  expect(projectReads).toBe(1)
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('本地重构')
  await page.getByRole('textbox', { name: '描述', exact: true }).fill('保留原始布局')
  await page.getByRole('button', { name: '添加工作目录', exact: true }).click()
  await page.getByRole('textbox', { name: '工作目录 1', exact: true }).fill(firstDirectory)
  await page.getByRole('button', { name: '添加工作目录', exact: true }).click()
  await page.getByRole('textbox', { name: '工作目录 2', exact: true }).fill(secondDirectory)
  await expect(page.getByRole('radio', { name: '首选工作目录 1', exact: true })).toBeChecked()
  await page.screenshot({ path: 'test-results/project-directories-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(
    page
      .getByRole('button', { name: '收起项目 本地重构', exact: true })
      .locator('svg.lucide-blocks'),
  ).toHaveCount(1)
  expect(projectReads).toBe(2)
  let stored = (await (await request.get('/api/projects')).json()).projects.find(
    (p: { name: string }) => p.name === '本地重构',
  )
  expect(stored.directories).toEqual([firstDirectory, secondDirectory])
  expect(stored.preferred_directory).toBe(firstDirectory)
  await page.getByRole('button', { name: '在本地重构中新建需求', exact: true }).click()
  await page.getByRole('textbox', { name: '需求名称', exact: true }).fill('单机控制台')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('heading', { name: '单机控制台', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑项目 本地重构', exact: true }).click()
  await page.getByRole('textbox', { name: '描述', exact: true }).fill('编辑项目后仍停留当前需求')
  await expect(page.getByRole('textbox', { name: '工作目录 1', exact: true })).toHaveValue(
    firstDirectory,
  )
  await page.getByRole('radio', { name: '首选工作目录 2', exact: true }).check()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('heading', { name: '单机控制台', exact: true })).toBeVisible()
  expect(projectReads).toBe(3)
  stored = (await (await request.get('/api/projects')).json()).projects.find(
    (p: { name: string }) => p.name === '本地重构',
  )
  expect(stored.preferred_directory).toBe(secondDirectory)
  await page.getByRole('button', { name: '在待开始中新建任务', exact: true }).click()
  await page.getByRole('textbox', { name: '任务名称', exact: true }).fill('集成 reind')
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
  const task = page.getByRole('button', { name: '打开任务 集成 reind', exact: true })
  await expect(task).toBeVisible()
  await task.click()
  await expect(page.locator('.task-detail')).toBeVisible()
  await page.keyboard.press('Escape')
  await page
    .locator('.task-card')
    .filter({ hasText: '集成 reind' })
    .getByRole('button', { name: /任务操作$/ })
    .click()
  await page.getByRole('menuitem', { name: '移至已完成', exact: true }).click()
  await expect(page.locator('.task-group-done')).toContainText('集成 reind')
  expect(projectReads).toBe(3)
  await page.reload()
  await page.getByRole('button', { name: '展开项目 本地重构', exact: true }).click()
  await page.getByRole('button', { name: '单机控制台', exact: true }).click()
  expect(projectReads).toBe(4)
  await page.getByRole('button', { name: '编辑项目 本地重构', exact: true }).click()
  await expect(page.getByRole('radio', { name: '首选工作目录 2', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.task-group-done')).toContainText('集成 reind')
  await page.getByRole('button', { name: '个人菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await expect(page.locator('.settings-dialog')).toBeVisible()
  await expect(page.getByText('默认工作空间', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('original Agent chat supports streaming, history and approval', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('hello')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('log')).toContainText('Hello 1')
  await expect(page.locator('.message.own .message-bubble')).toHaveCSS(
    'background-color',
    'rgb(234, 242, 255)',
  )
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    const bubble = page.locator('.message.own .message-bubble')
    await expect(bubble.locator('span')).toHaveText('hello')
    const space = await bubble.evaluate((element) => {
      const style = getComputedStyle(element)
      const text = element.querySelector('span')!
      const range = document.createRange()
      range.selectNodeContents(text)
      return {
        horizontal:
          element.getBoundingClientRect().width -
          range.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        inside:
          element.getBoundingClientRect().height -
          text.getBoundingClientRect().height -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
        after:
          element.closest('article')!.getBoundingClientRect().bottom -
          element.getBoundingClientRect().bottom,
      }
    })
    expect(space.horizontal).toBeLessThanOrEqual(2)
    expect(space.inside).toBeLessThanOrEqual(5)
    expect(space.after).toBeLessThanOrEqual(8)
    await page.screenshot({
      path: `test-results/user-message-${viewport.width}.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Hello 1')
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('approval')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('heading', { name: 'Agent 请求审批' })).toBeVisible()
  await page.getByRole('button', { name: '批准', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Hello 2')
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('第一行\n第二行')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('log')).toContainText('Hello 3')
  expect(await page.locator('.message.own .message-bubble span').last().textContent()).toBe(
    '第一行\n第二行',
  )
  const longMessage = '这是一条需要自动换行的长消息。'.repeat(30)
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(longMessage)
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('log')).toContainText('Hello 4')
  const longBubble = page.locator('.message.own .message-bubble').last()
  expect(await longBubble.locator('span').textContent()).toBe(longMessage)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await longBubble.evaluate((element) => {
      const text = element.querySelector('span')!
      return {
        wraps: text.getBoundingClientRect().height > parseFloat(getComputedStyle(text).lineHeight),
        fits:
          element.scrollWidth <= element.clientWidth &&
          element.getBoundingClientRect().right <=
            element.parentElement!.getBoundingClientRect().right,
      }
    })
    expect(layout.wraps).toBeTruthy()
    expect(layout.fits).toBeTruthy()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy()
  }
})

test('original split layout, compact rail and mobile chat keep working', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('execution')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('log')).toContainText('Hello 1')
  const separator = page.getByRole('separator', { name: '调整聊天与任务栏宽度' })
  const initial = await separator.getAttribute('aria-valuenow')
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).not.toHaveAttribute('aria-valuenow', initial!)
  await page.screenshot({ path: 'test-results/original-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '窄侧栏' })).toHaveCSS('width', '56px')
  await expect(page.getByRole('button', { name: '当前项目对话' })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/original-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('slow')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await page.getByRole('button', { name: '停止执行', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toHaveCount(0)
  await openNavigation(page)
  await expect(page.getByRole('complementary', { name: '项目导航' })).toBeVisible()
})

test('original Agent settings create local and remote providers', async ({ page, request }) => {
  const { agents } = await (await request.get('/api/agents')).json()
  const directory = agents.find((agent: { name: string }) => agent.name === 'pi').directory
  await page.goto('/')
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click()
  await expect(page.locator('.agent-config-dialog')).toBeVisible()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('ui-helper')
  await page.getByRole('combobox', { name: 'Agent 类型' }).selectOption('pi')
  await page.getByRole('button', { name: '本地配置', exact: true }).click()
  await page.getByRole('textbox', { name: '工作目录', exact: true }).fill(directory)
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click()
  await expect(page.getByRole('button', { name: '与ui-helper对话', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '与ui-helper对话', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Agent 对话', exact: true }).getByRole('alert'),
  ).toContainText('rein agent up ui-helper')
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('kept as a draft')
  await expect(page.getByRole('button', { name: '发送消息按钮' })).toBeDisabled()
  const up = await request.post('/api/agents/ui-helper/availability', { data: { enabled: true } })
  expect(up.ok()).toBeTruthy()
  await expect(page.locator('.chat-heading')).toContainText('在线')
  await expect(page.getByRole('button', { name: '发送消息按钮' })).toBeEnabled()
  const down = await request.post('/api/agents/ui-helper/availability', {
    data: { enabled: false },
  })
  expect(down.ok()).toBeTruthy()
  await expect(page.locator('.chat-heading')).toContainText('Agent 已下线')
  await expect(page.getByRole('button', { name: '发送消息按钮' })).toBeDisabled()
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('ui-remote')
  await page.getByRole('button', { name: 'A2A 配置', exact: true }).click()
  await page.getByRole('switch', { name: '远程 Agent', exact: true }).click()
  await page.getByRole('textbox', { name: '服务地址', exact: true }).fill('http://127.0.0.1:19999')
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click()
  await expect(page.getByRole('button', { name: '与ui-remote对话', exact: true })).toBeVisible()
  const saved = await (await request.get('/api/agents')).json()
  expect(saved.agents.find((agent: { name: string }) => agent.name === 'ui-remote').enabled).toBe(
    false,
  )
})

test('project directory editor stays compact on mobile and falls back when a preference is removed', async ({
  page,
  request,
}) => {
  const { agents } = await (await request.get('/api/agents')).json()
  const first = agents.find((agent: { name: string }) => agent.name === 'pi').directory
  const second = agents.find((agent: { name: string }) => agent.name === 'codex').directory
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await openNavigation(page)
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('移动项目')
  await page.getByRole('button', { name: '添加工作目录', exact: true }).click()
  await page.getByRole('textbox', { name: '工作目录 1', exact: true }).fill(first)
  await page.getByRole('button', { name: '添加工作目录', exact: true }).click()
  await page.getByRole('textbox', { name: '工作目录 2', exact: true }).fill(second)
  await page.getByRole('radio', { name: '首选工作目录 2', exact: true }).check()
  await page.screenshot({ path: 'test-results/project-directories-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.getByRole('button', { name: '移除工作目录 2', exact: true }).click()
  await expect(page.getByRole('radio', { name: '首选工作目录 1', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved = (await (await request.get('/api/projects')).json()).projects.find(
    (p: { name: string }) => p.name === '移动项目',
  )
  expect(saved.directories).toEqual([first])
  expect(saved.preferred_directory).toBe(first)
})

test('Agent process is collapsed as a group with timing and hover actions', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(page.getByRole('log')).toHaveAttribute('aria-busy', 'false')
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('execution')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  const response = page.locator('.agent-message').last()
  await expect(response.locator('.hub-final-answer')).toHaveText('Hello 1')
  const progress = response.locator('.hub-progress')
  const reasoning = response.locator('.hub-reasoning').first()
  const tool = response.locator('.hub-tool').filter({ hasText: '已运行 bash' })
  await expect(progress).not.toHaveAttribute('open')
  await expect(progress.locator(':scope > summary')).toContainText('用时')
  await expect(response.locator('.message-author time')).toHaveAttribute('datetime', /T.*Z$/)
  await expect(response.locator('.message-author')).not.toContainText('已完成')
  await expect(reasoning).toBeHidden()
  await expect(tool).toBeHidden()
  await page.mouse.move(0, 0)
  await expect(response.locator('.hub-message-actions')).toHaveCSS('opacity', '0')
  await page.screenshot({ path: 'test-results/chat-collapsed-desktop.png', fullPage: true })
  await response.hover()
  await expect(response.locator('.hub-message-actions')).toHaveCSS('opacity', '1')
  await response.getByRole('button', { name: '复制回答', exact: true }).click()
  await expect(response.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Hello 1')
  await response.getByRole('button', { name: '执行信息', exact: true }).click()
  await expect(page.getByRole('region', { name: '执行信息', exact: true })).toContainText('Session')
  await expect(page.locator('.MuiPopover-paper')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/chat-run-info.png', fullPage: true })
  await page.keyboard.press('Escape')
  await progress.locator(':scope > summary').focus()
  await page.keyboard.press('Enter')
  await expect(reasoning).toBeVisible()
  await expect(response.locator('.hub-tool')).toHaveCount(2)
  await expect(tool.locator('summary')).toContainText('ls -la')
  await expect(tool).toHaveCSS('border-top-width', '0px')
  await expect(tool.locator('.hub-activity-content')).toBeHidden()
  await expect(response.locator('.hub-tool-error summary')).toContainText('执行失败 read')
  await reasoning.locator('summary').click()
  await expect(reasoning.locator('p')).toHaveText('检查仓库结构。')
  await tool.locator('summary').click()
  await expect(tool.locator('.hub-activity-content')).toContainText('文件B')
  await expect(tool.locator('.hub-activity-content')).toContainText('ls -la')
  await page.reload()
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(page.locator('.hub-final-answer')).toHaveText('Hello 1')
  await expect(page.locator('.hub-progress[open]')).toHaveCount(0)
  await expect(page.locator('.hub-tool').first()).toBeHidden()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('arguments-large')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.locator('.hub-final-answer').last()).toHaveText('Hello 2')
  await page.setViewportSize({ width: 390, height: 844 })
  const latest = page.locator('.agent-message').last()
  await latest.locator('.hub-progress > summary').click()
  const preview = latest.locator('.hub-tool .hub-activity-preview').first()
  await expect(preview).toHaveCSS('text-overflow', 'ellipsis')
  expect(
    await preview.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBeTruthy()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await latest.locator('.hub-progress > summary').click()
  await latest.locator('.hub-final-answer').scrollIntoViewIfNeeded()
  const mobile = await context
    .browser()!
    .newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto('/')
  await mobilePage.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await mobilePage.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(mobilePage.locator('.hub-final-answer').last()).toHaveText('Hello 2')
  await expect(mobilePage.locator('.hub-message-actions').last()).toHaveCSS('opacity', '1')
  await mobilePage.screenshot({ path: 'test-results/chat-collapsed-mobile.png', fullPage: true })
  await mobile.close()
})

test('intermediate replies stay inside the process and old records do not invent timing', async ({
  page,
}) => {
  const finished = Date.parse('2026-11-11T15:13:08Z')
  const record = {
    run: {
      run_id: 'example-run',
      attempt_id: 'example-attempt',
      session_id: 'example-session',
      state: 'completed',
      cancel_requested: false,
      last_sequence: 4,
      finished_at: finished,
    },
    agent_id: 'pi',
    prompt: '检查执行过程',
    created_at: '2026-11-11T15:12:00Z',
    version: '1',
    events: [
      {
        sequence: 1,
        event: {
          type: 'text',
          item_id: 'commentary',
          text: '我先检查配置。',
          complete: true,
          reasoning: false,
        },
      },
      {
        sequence: 2,
        event: {
          type: 'tool',
          call_id: 'call',
          name: 'read',
          input: { path: 'README.md' },
          output: { text: '配置内容' },
          complete: true,
          is_error: false,
        },
      },
      {
        sequence: 3,
        event: {
          type: 'text',
          item_id: 'commentary-2',
          text: '现在开始核对。',
          complete: true,
          reasoning: false,
        },
      },
      {
        sequence: 4,
        event: {
          type: 'text',
          item_id: 'final',
          text: '最终结论：配置正确。',
          complete: true,
          reasoning: false,
        },
      },
    ],
    command_acks: [],
  }
  let legacy = false
  await page.route('**/api/agents/pi/history?**', (route) =>
    route.fulfill({
      json: {
        runs: [{ ...record, run: { ...record.run, finished_at: legacy ? null : finished } }],
        sessions: [{ id: 'example-session', prompt: record.prompt }],
        session_id: 'example-session',
        next_cursor: '',
        stream_cursor: '0',
      },
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  const response = page.locator('.agent-message').last()
  await expect(response.locator('.hub-final-answer')).toHaveText('最终结论：配置正确。')
  await expect(response.locator('.hub-progress > summary')).toHaveText('用时 1分 8秒')
  await expect(response.locator('.message-author time')).toHaveAttribute(
    'datetime',
    '2026-11-11T15:13:08.000Z',
  )
  await expect(response.getByText('我先检查配置。', { exact: true })).toBeHidden()
  await expect(response.getByText('现在开始核对。', { exact: true })).toBeHidden()
  await response.locator('.hub-progress > summary').click()
  await expect(response.getByText('我先检查配置。', { exact: true })).toBeVisible()
  await expect(response.getByText('现在开始核对。', { exact: true })).toBeVisible()
  expect(
    await response
      .locator('.hub-progress-content > *')
      .evaluateAll((elements) => elements.map((element) => element.className)),
  ).toEqual(['hub-message-text', 'hub-tool', 'hub-message-text'])
  await page.screenshot({ path: 'test-results/chat-process-expanded.png', fullPage: true })
  legacy = true
  await page.reload()
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(response.locator('.hub-progress > summary')).toHaveText('用时未记录')
  await expect(response.locator('.message-author')).toContainText('结束时间未记录')
})
