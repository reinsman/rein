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
  let workflowReads = 0
  let eventStreams = 0
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const path = new URL(req.url()).pathname
    if (path === '/api/projects') projectReads++
    if (path === '/api/agents') agentReads++
    if (path === '/api/workflow') workflowReads++
    if (path === '/api/events') eventStreams++
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
  await expect(page.getByRole('button', { name: '与pi对话', exact: true })).toBeVisible()
  await page.waitForTimeout(4500)
  expect(agentReads).toBe(0)
  expect(workflowReads).toBe(0)
  expect(eventStreams).toBe(1)
  expect(projectReads).toBe(1)
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('本地重构')
  await page.getByRole('textbox', { name: '描述', exact: true }).fill('保留原始布局')
  await page.screenshot({
    path: 'test-results/project-settings-basic-desktop.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '工作目录', exact: true }).click()
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
  await page.getByRole('button', { name: '工作目录', exact: true }).click()
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
  await expect(page.getByRole('menuitem', { name: '移至已完成', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-group-todo')).toContainText('集成 reind')
  expect(projectReads).toBe(3)
  await page.reload()
  await expect(page.getByRole('heading', { name: '单机控制台', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '收起项目 本地重构', exact: true })).toBeVisible()
  expect(projectReads).toBe(4)
  await page.getByRole('button', { name: '编辑项目 本地重构', exact: true }).click()
  await page.getByRole('button', { name: '工作目录', exact: true }).click()
  await expect(page.getByRole('radio', { name: '首选工作目录 2', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.task-group-todo')).toContainText('集成 reind')
  await page.getByRole('button', { name: '个人菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await expect(page.locator('.settings-dialog')).toBeVisible()
  await expect(page.getByText('默认工作空间', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('chat content fits the shared minimum pane width and grows when resized', async ({ page }) => {
  const row = '|' + ' W |'.repeat(32)
  const answer = [row, '|' + ' --- |'.repeat(32), row, '', '![结果图](/wide-result.svg)'].join('\n')
  await page.route('**/wide-result.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="24"><rect width="760" height="24" fill="gray"/></svg>',
    }),
  )
  await page.route('**/api/agents/codex/history?**', (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            run: {
              run_id: 'chat-sizing',
              attempt_id: 'attempt',
              session_id: 'chat-sizing',
              state: 'completed',
              cancel_requested: false,
              last_sequence: 1,
            },
            agent_id: 'codex',
            prompt: '这是一条需要随聊天栏宽度自动换行的长消息。'.repeat(80),
            created_at: new Date().toISOString(),
            version: '1',
            events: [
              {
                sequence: 1,
                event: { type: 'text', item_id: 'answer', text: answer, complete: true },
              },
            ],
          },
        ],
        sessions: [{ id: 'chat-sizing', prompt: '检查聊天栏宽度' }],
        session_id: 'chat-sizing',
        next_cursor: '',
        stream_cursor: '',
      },
    }),
  )
  await page.goto('/')
  const separator = page.getByRole('separator', { name: '调整聊天与任务栏宽度' })
  async function dragDivider(x: number) {
    const box = (await separator.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
  }
  const pane = page.locator('.split-layout > .chat-panel')
  await dragDivider(300)
  await expect(pane).toHaveCSS('width', '360px')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(pane).toHaveCSS('width', '360px')

  const image = page.getByRole('img', { name: '结果图' })
  await image.evaluate((element: HTMLImageElement) => element.decode())
  const table = page.getByRole('table')
  await expect(table).toHaveCSS('overflow-x', 'auto')
  expect(await table.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
    await table.evaluate((element) => element.clientWidth),
  )
  const log = page.getByRole('log')
  expect(await log.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(
    1,
  )

  const bubble = page.locator('.message.own .message-bubble')
  const initialWidth = (await bubble.boundingBox())!.width
  await dragDivider(1060)
  await expect
    .poll(async () => (await bubble.boundingBox())!.width)
    .toBeGreaterThan(initialWidth + 150)
  await expect.poll(async () => (await bubble.boundingBox())!.width).toBeGreaterThan(600)
  await page.screenshot({ path: 'test-results/chat-resized-desktop.png', animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/chat-resized-mobile.png', animations: 'disabled' })
  await expect
    .poll(() => bubble.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1)
  expect(await log.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(
    1,
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

test('original Agent chat supports streaming, history and approval', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '发送消息', exact: true })
  const pending = Promise.withResolvers<void>()
  await page.route(
    '**/api/runs',
    async (route) => {
      await pending.promise
      await route.continue()
    },
    { times: 1 },
  )
  try {
    await composer.fill('hello')
    await page.getByRole('button', { name: '发送消息按钮' }).click()
    await composer.fill('发送期间输入的草稿')
  } finally {
    pending.resolve()
  }
  await expect(page.getByRole('log')).toContainText('Hello 1')
  await expect(composer).toHaveValue('发送期间输入的草稿')
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
  const historyButton = page.getByRole('button', { name: '会话历史', exact: true })
  const history = page.getByRole('region', { name: '会话历史', exact: true })
  const existingSession = history.getByRole('button', { name: /^hello\b/ })
  await composer.fill('已有会话的草稿')
  await historyButton.click()
  await expect(existingSession).toHaveAttribute('aria-current', 'true')
  await expect(existingSession.locator('time')).toHaveAttribute('datetime', /^\d{4}-/)
  await expect(page.getByRole('complementary', { name: '项目导航' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible()
  await expect(composer).toBeHidden()
  await history.getByRole('button', { name: '返回对话', exact: true }).click()
  await expect(historyButton).toBeFocused()
  await expect(composer).toHaveValue('已有会话的草稿')
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(composer).toHaveValue('')
  await composer.fill('新会话的草稿')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(composer).toHaveValue('')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(composer).toHaveValue('新会话的草稿')
  await historyButton.click()
  const search = history.getByRole('searchbox', { name: '搜索会话', exact: true })
  await search.fill('不存在的会话')
  await expect(history.getByRole('status')).toHaveText('没有找到匹配的会话')
  await search.fill('HELLO')
  await expect(existingSession).not.toHaveAttribute('aria-current')
  await existingSession.click()
  await expect(composer).toHaveValue('已有会话的草稿')
  await page.reload()
  await expect(page.getByRole('button', { name: '与codex对话', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('log')).toContainText('Hello 1')
  await expect(composer).toHaveValue('')
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('approval')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  await expect(page.getByRole('heading', { name: 'Agent 请求审批' })).toBeVisible()
  const approval = page.locator('.hub-interaction')
  await expect(approval.locator('pre').first()).toHaveText('echo fixture')
  await expect(approval).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(() =>
        approval.evaluate((element) => {
          const card = element.getBoundingClientRect()
          const composer = element
            .closest('.chat-panel')!
            .querySelector('.composer')!
            .getBoundingClientRect()
          const [decline, approve] = [...element.querySelectorAll('button')].map((button) =>
            button.getBoundingClientRect(),
          )
          return {
            aligned:
              Math.abs(card.x - composer.x) <= 1 && Math.abs(card.width - composer.width) <= 1,
            visible: composer.bottom <= innerHeight,
            actionsRight:
              Math.abs(card.right - approve.right - 13) <= 1 && decline.right < approve.x,
          }
        }),
      )
      .toEqual({ aligned: true, visible: true, actionsRight: true })
    await page.screenshot({ path: `test-results/approval-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
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
    await expect
      .poll(() =>
        longBubble.evaluate((element) => {
          const text = element.querySelector('span')!
          return {
            wraps:
              text.getBoundingClientRect().height > parseFloat(getComputedStyle(text).lineHeight),
            fits:
              element.scrollWidth <= element.clientWidth &&
              element.getBoundingClientRect().right <=
                element.parentElement!.getBoundingClientRect().right,
          }
        }),
      )
      .toEqual({ wraps: true, fits: true })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy()
  }
})

for (const width of [1440, 390]) {
  test(`composer stays in the fixed ${width}px viewport as execution grows`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 })
    await page.goto('/')
    await openNavigation(page)
    await page.getByRole('button', { name: '与pi对话', exact: true }).click()
    await expect(page.getByRole('log')).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    const composer = page.locator('.composer')
    const initial = (await composer.boundingBox())!
    const bottom = initial.y + initial.height
    const input = page.getByRole('textbox', { name: '发送消息', exact: true })
    await input.fill('固定窗口中的长对话记录。\n'.repeat(60))
    await page.getByRole('button', { name: '发送消息按钮' }).click()
    await expect(page.locator('.hub-final-answer').last()).toHaveText('Hello 1')
    await input.fill('execution-pause')
    await page.getByRole('button', { name: '发送消息按钮' }).click()
    const response = page.locator('.agent-message').last()
    await expect(response.locator('.hub-progress > summary')).toContainText('执行中')
    await response.locator('.hub-progress > summary').click()
    await response.locator('.hub-tool').first().locator('summary').click()
    await input.fill('第一行\n第二行\n第三行\n第四行\n第五行')
    async function expectDockVisible() {
      await expect
        .poll(() =>
          composer.evaluate((element, expectedBottom) => {
            const rect = element.getBoundingClientRect()
            const dock = element.parentElement!.getBoundingClientRect()
            const log = element.closest('.chat-panel')!.querySelector('.messages')!
            const send = element.querySelector('.send-button')!.getBoundingClientRect()
            return {
              anchored: Math.abs(rect.bottom - expectedBottom) <= 1,
              visible: rect.bottom <= innerHeight && rect.top >= 0,
              scrolls: log.scrollHeight > log.clientHeight,
              separate: log.getBoundingClientRect().bottom <= dock.top + 1,
              sendVisible: send.top >= rect.top && send.bottom <= rect.bottom,
            }
          }, bottom),
        )
        .toEqual({
          anchored: true,
          visible: true,
          scrolls: true,
          separate: true,
          sendVisible: true,
        })
    }
    await expectDockVisible()
    await page.screenshot({ path: `test-results/composer-running-${width}.png` })
    await page.getByRole('button', { name: '停止执行', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止执行', exact: true })).toHaveCount(0)
    await expectDockVisible()
    await expect(input).toHaveValue('第一行\n第二行\n第三行\n第四行\n第五行')
  })
}

test('approval shows reasons, working directory and the matching file changes', async ({
  page,
}) => {
  const cwd = '/project/' + 'long-directory/'.repeat(20)
  let fileChange = false
  await page.route('**/api/agents/codex/history?**', (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            run: {
              run_id: 'approval-details',
              attempt_id: 'attempt',
              session_id: 'approval-details',
              state: 'waiting_approval',
              cancel_requested: false,
              last_sequence: 2,
            },
            agent_id: 'codex',
            prompt: '检查审批内容',
            created_at: new Date().toISOString(),
            version: '1',
            events: [
              {
                sequence: 1,
                event: {
                  type: 'tool',
                  call_id: 'change-1',
                  name: 'fileChange',
                  input: { changes: [{ path: `${cwd}config.json`, diff: '- false\n+ true' }] },
                },
              },
              {
                sequence: 2,
                event: {
                  type: 'interaction',
                  interaction_id: 'approval-1',
                  approval_required: true,
                  method: fileChange
                    ? 'item/fileChange/requestApproval'
                    : 'item/commandExecution/requestApproval',
                  parameters: fileChange
                    ? { itemId: 'change-1', reason: '需要更新项目配置', grantRoot: cwd }
                    : { command: 'echo 审批内容', cwd, reason: '需要在项目目录中执行命令' },
                },
              },
            ],
            command_acks: [],
          },
        ],
        sessions: [{ id: 'approval-details', prompt: '检查审批内容' }],
        session_id: 'approval-details',
        next_cursor: '',
        stream_cursor: '0',
      },
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  const approval = page.locator('.hub-interaction')
  await expect(approval).toContainText('需要在项目目录中执行命令')
  await expect(approval).toContainText(`工作目录：${cwd}`)
  await expect(approval.locator('pre').first()).toHaveText('echo 审批内容')
  await approval.getByText('请求详情', { exact: true }).click()
  await expect(approval.locator('details pre')).toContainText(
    'item/commandExecution/requestApproval',
  )
  fileChange = true
  await page.reload()
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(approval).toContainText('需要更新项目配置')
  await expect(approval.locator('details')).not.toHaveAttribute('open')
  await approval.getByText('请求详情', { exact: true }).click()
  await expect(approval.locator('details pre')).toBeVisible()
  await expect(approval.locator('details pre')).toContainText(`${cwd}config.json`)
  await expect(approval.locator('details pre')).toContainText('- false\\n+ true')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await approval.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy()
  await page.route('**/api/runs/approval-details/reply', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      attempt_id: 'attempt',
      interaction_id: 'approval-1',
      response: { decision: 'decline' },
    })
    return route.fulfill({ json: {} })
  })
  await approval.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(approval.getByRole('status')).toHaveText('回复已提交，等待 Agent 继续执行。')
  await expect(approval.getByRole('button', { name: '批准', exact: true })).toBeDisabled()
})

test('original split layout, compact rail and mobile chat keep working', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).locator('..').hover()
  await expect(page.getByRole('tooltip')).toHaveText('Enter 发送')
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
  const composer = page.getByRole('textbox', { name: '发送消息', exact: true })
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible()
  await composer.hover()
  await page.getByRole('button', { name: '排队发送', exact: true }).locator('..').hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    /Enter 排队 · (?:⌘|Ctrl)\+Enter 立即指导（Steer）/,
  )
  await composer.fill('下一轮补充')
  await composer.press('Shift+Enter')
  await expect(composer).toHaveValue('下一轮补充\n')
  await composer.press('Enter')
  await expect(page.getByText('已排队，本轮执行结束后发送')).toBeVisible()
  await expect(page.getByRole('log').getByText('下一轮补充', { exact: true })).toHaveCount(0)
  await composer.fill('即时指导')
  await expect(page.getByRole('button', { name: '发送指导', exact: true })).toBeEnabled()
  await composer.press('ControlOrMeta+Enter')
  await expect(page.getByRole('log')).toContainText('Agent 已接收')
  await expect(composer).toHaveValue('')
  await expect(page.getByText('已排队，本轮执行结束后发送')).toBeVisible()
  await page.getByRole('button', { name: '停止执行', exact: true }).click()
  await expect(page.getByRole('log').getByText('下一轮补充', { exact: true })).toBeVisible()
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
  await page.screenshot({
    path: 'test-results/project-settings-basic-mobile.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '工作目录', exact: true }).click()
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
      last_sequence: 5,
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
          item_id: 'reasoning',
          text: '核对配置和预期是否一致。',
          complete: true,
          reasoning: true,
        },
      },
      {
        sequence: 5,
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
  ).toEqual(['hub-message-text', 'hub-tool', 'hub-message-text', 'hub-reasoning'])
  const reasoning = response.locator('.hub-reasoning')
  await reasoning.locator('summary').click()
  await expect(reasoning.locator('p')).toHaveText('核对配置和预期是否一致。')
  await expect(reasoning).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(response.getByRole('img', { name: '系统消息', exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/chat-process-expanded.png', fullPage: true })
  legacy = true
  await page.reload()
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(response.locator('.hub-progress > summary')).toHaveText('用时未记录')
  await expect(response.locator('.message-author')).toContainText('结束时间未记录')
})

test('long interaction cards scroll within half the chat and collapse tool parameters', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('long-approval')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  const card = page.getByLabel('Agent 交互请求', { exact: true })
  await expect(card).toBeVisible()
  await expect(card.locator('details')).not.toHaveAttribute('open')
  await expect(card.getByText(/TOOL_ARGUMENTS_ONLY_IN_DETAILS/)).not.toBeVisible()
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport)
    await expect
      .poll(() =>
        card.evaluate((element) => ({
          bounded:
            element.getBoundingClientRect().height <=
            element.closest('.messages')!.clientHeight / 2,
          scrollable:
            element.scrollHeight > element.clientHeight &&
            getComputedStyle(element).overflowY === 'auto',
        })),
      )
      .toEqual({ bounded: true, scrollable: true })
    await card.getByRole('button', { name: '批准', exact: true }).scrollIntoViewIfNeeded()
    await expect(card.getByRole('button', { name: '批准', exact: true })).toBeInViewport()
    await page.screenshot({
      path: `test-results/long-interaction-${viewport.width}.png`,
      fullPage: true,
    })
  }
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(card).toHaveCount(0)
})

test('per-Agent settings persist permissions, model, effort and skill selection', async ({
  page,
  request,
}) => {
  const { agents } = await (await request.get('/api/agents')).json()
  const { skills: _skills, ...base } = agents.find(
    (agent: { name: string }) => agent.name === 'codex',
  )
  const beforePi = agents.find((agent: { name: string }) => agent.name === 'pi')
  expect(
    (await request.post('/api/agents', { data: { ...base, name: 'settings-helper' } })).ok(),
  ).toBeTruthy()
  await page.goto('/')
  await page.getByRole('button', { name: 'settings-helper设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent 设置 · settings-helper' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '权限配置', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '访问级别' })).toHaveValue('')
  await expect(page.locator('.agent-config-dialog .MuiDialog-container')).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: '.impeccable/review/agent-settings-desktop.png',
    animations: 'disabled',
  })
  await dialog.getByRole('combobox', { name: '访问级别' }).selectOption('read_only')
  await dialog.getByRole('button', { name: '模型与思考', exact: true }).click()
  await dialog.getByRole('textbox', { name: '模型覆盖' }).fill('custom-model')
  await expect(dialog.getByText('此 Agent 独立设置', { exact: true }).first()).toBeVisible()
  await dialog.getByRole('combobox', { name: '思考强度' }).selectOption('high')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await page.getByRole('button', { name: 'settings-helper设置', exact: true }).click()
  await dialog.getByRole('button', { name: '权限配置', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '访问级别' })).toHaveValue('read_only')
  await dialog.getByRole('button', { name: '模型与思考', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '模型覆盖' })).toHaveValue('custom-model')
  await expect(dialog.getByRole('combobox', { name: '思考强度' })).toHaveValue('high')
  await dialog.getByRole('button', { name: 'SKILL 配置', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '默认技能来源' })).toHaveValue('rein')
  await expect(dialog.getByRole('textbox', { name: '技能目录' })).toHaveValue('')
  await expect(dialog).toContainText(
    '安装到原生用户技能目录，同一配置目录的其他 Agent 也可发现；不覆盖已有文件。',
  )
  await dialog.getByRole('button', { name: '刷新技能', exact: true }).click()
  const skill = dialog.getByRole('switch', { name: '启用技能 rein-spec', exact: true })
  await expect(skill).toBeVisible()
  await skill.click()
  await expect(skill).toHaveAttribute('aria-checked', 'false')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(dialog).toBeHidden()
  const updated = (await (await request.get('/api/agents')).json()).agents
  const saved = updated.find((agent: { name: string }) => agent.name === 'settings-helper')
  expect(saved.permissions).toBe('read_only')
  expect(saved.disabled_skills).toHaveLength(1)
  expect(saved.native_config).toBe(base.native_config)
  expect(saved.executable).toBe(base.executable)
  const afterPi = updated.find((agent: { name: string }) => agent.name === 'pi')
  expect({ ...afterPi, skills: null }).toEqual({ ...beforePi, skills: null })
  await page.getByRole('button', { name: 'settings-helper设置', exact: true }).click()
  await dialog.getByRole('button', { name: '本地配置', exact: true }).click()
  await dialog.getByRole('textbox', { name: '工作目录' }).fill('/missing/rein-test-directory')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('directory')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: '工作目录' }).fill(base.directory)
  await dialog.getByRole('button', { name: '关闭 Agent 设置' }).click()
  await expect(dialog.getByText('有尚未保存的更改。', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: '放弃更改', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible()
  await openNavigation(page)
  await page.getByRole('button', { name: 'settings-helper设置', exact: true }).click()
  await dialog.getByRole('button', { name: '权限配置', exact: true }).click()
  await expect(page.locator('.agent-config-dialog .MuiDialog-container')).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: '.impeccable/review/agent-settings-mobile.png',
    animations: 'disabled',
  })
  expect(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy()
  await dialog.getByRole('button', { name: '关闭 Agent 设置' }).click()
  await request.delete('/api/agents/settings-helper')
  const longName = 'agent-' + 'x'.repeat(58)
  expect(
    (await request.post('/api/agents', { data: { ...base, name: longName } })).ok(),
  ).toBeTruthy()
  await page.reload()
  await openNavigation(page)
  await page.getByRole('button', { name: `${longName}设置`, exact: true }).click()
  const longDialog = page.getByRole('dialog', { name: `Agent 设置 · ${longName}` })
  await expect(longDialog.getByRole('button', { name: '基本设置', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await expect(longDialog.getByRole('button', { name: '关闭 Agent 设置' })).toBeInViewport()
  expect(
    await longDialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy()
  await expect(page.locator('.agent-config-dialog .MuiDialog-container')).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: '.impeccable/review/agent-settings-long-name.png',
    animations: 'disabled',
  })
  await longDialog.getByRole('button', { name: '关闭 Agent 设置' }).click()
  await request.delete(`/api/agents/${longName}`)
})

test('Codex questions offer choices, descriptions and custom answers without choosing defaults', async ({
  page,
}) => {
  const replies: unknown[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/runs\/[^/]+\/reply$/.test(new URL(request.url()).pathname)
    )
      replies.push(request.postDataJSON())
  })
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('questions')
  await page.getByRole('button', { name: '发送消息按钮' }).click()
  const card = page.getByLabel('Agent 交互请求', { exact: true })
  await expect(card.locator('.hub-question')).toHaveCount(3)
  await expect(card.getByRole('radio', { checked: true })).toHaveCount(0)
  const audience = card.getByRole('group', { name: '使用场景：主要在哪个场景使用？', exact: true })
  const retention = card.getByRole('group', { name: '数据保存：数据需要保存多久？', exact: true })
  const constraints = card.getByRole('group', {
    name: '其他约束：还有哪些必须遵守的边界？',
    exact: true,
  })
  await expect(audience).toContainText('单人本机使用，先验证核心流程。')
  await constraints
    .getByRole('textbox', { name: '回复内容', exact: true })
    .fill('先支持本机，不共享个人数据。')
  await card.getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(card.getByRole('alert')).toHaveText('请为每个问题选择选项或填写自定义回复。')
  expect(replies).toHaveLength(0)
  await audience.getByRole('radio', { name: /个人使用（推荐）/ }).check()
  await retention.getByRole('radio', { name: '自定义回复', exact: true }).check()
  await retention
    .getByRole('textbox', { name: '自定义内容', exact: true })
    .fill('保存 90 天，支持导出与主动删除。')
  await retention.getByRole('radio', { name: /仅当前会话/ }).check()
  await retention.getByRole('radio', { name: '自定义回复', exact: true }).check()
  await expect(retention.getByRole('textbox', { name: '自定义内容', exact: true })).toHaveValue(
    '保存 90 天，支持导出与主动删除。',
  )
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expect
      .poll(() =>
        card.evaluate(
          (element) =>
            element.getBoundingClientRect().height <=
            element.closest('.messages')!.clientHeight / 2,
        ),
      )
      .toBe(true)
    await retention.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `test-results/question-options-${viewport.width}.png`,
      fullPage: true,
    })
  }
  await card.getByRole('button', { name: '发送回复', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({
    response: {
      answers: {
        audience: { answers: ['个人使用（推荐）'] },
        retention: { answers: ['保存 90 天，支持导出与主动删除。'] },
        constraints: { answers: ['先支持本机，不共享个人数据。'] },
      },
    },
  })
})

for (const custom of [false, true])
  test(`Pi selection accepts ${custom ? 'custom input' : 'a provided option'}`, async ({
    page,
  }) => {
    let reply: unknown
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/runs\/[^/]+\/reply$/.test(new URL(request.url()).pathname)
      )
        reply = request.postDataJSON()
    })
    await page.goto('/')
    await page.getByRole('button', { name: '与pi对话', exact: true }).click()
    await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('questions')
    await page.getByRole('button', { name: '发送消息按钮' }).click()
    const card = page.getByLabel('Agent 交互请求', { exact: true })
    await expect(card.getByRole('radio', { checked: true })).toHaveCount(0)
    await card
      .getByRole('radio', { name: custom ? '自定义回复' : '项目默认目录（推荐）', exact: true })
      .check()
    if (custom)
      await card
        .getByRole('textbox', { name: '自定义内容', exact: true })
        .fill('使用项目根目录下的独立输出目录。')
    await card.getByRole('button', { name: '发送回复', exact: true }).click()
    await expect(card).toHaveCount(0)
    expect(reply).toMatchObject({
      response: { value: custom ? '使用项目根目录下的独立输出目录。' : '项目默认目录（推荐）' },
    })
  })
