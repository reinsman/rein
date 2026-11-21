import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

async function projectWithSpec(request: APIRequestContext, name: string) {
  const { agents } = await (await request.get('/api/agents')).json()
  const directory = agents.find((agent: { name: string }) => agent.name === 'pi').directory
  const requirement = { id: randomUUID(), title: `${name}需求`, description: '' }
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
  await page.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill(project)
  await page.getByRole('button', { name: requirement, exact: true }).click()
}
async function expectStatusNextToTitle(node: Locator) {
  await expect
    .poll(() =>
      node.evaluate((element) => {
        const title = element.querySelector('.nav-text')!.getBoundingClientRect()
        const status = element.querySelector('.node-status')!.getBoundingClientRect()
        const gap = status.left - title.right
        return gap >= 0 && gap <= 12
      }),
    )
    .toBe(true)
}

test('chat previews workspace files and clears an at-mention only after it is visible', async ({
  browser,
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { project, requirement } = await projectWithSpec(request, '聊天引用')
  const directory = join(project.preferred_directory, 'src')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'preview.txt'), '第一行\n<script>plain text</script>\n第三行')
  const outside = join(dirname(project.preferred_directory), 'secret-outside.txt')
  writeFileSync(outside, 'outside content')
  symlinkSync(outside, join(directory, 'linked.txt'))
  await select(page, project.name, requirement.title)
  await page.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill('')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  const node = page.getByRole('button', { name: requirement.title, exact: true })
  const unread = node.locator('.node-mention')

  const response = await request.post(`/api/requirements/${requirement.id}/chat`, {
    data: { prompt: 'fixture-chat-references', request_id: randomUUID() },
  })
  expect(response.ok()).toBe(true)
  const { run } = await response.json()
  await expect(unread).toBeVisible()
  const observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const observer = await observerContext.newPage()
  await observer.goto('/')
  await observer.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill(project.name)
  const observerUnread = observer
    .getByRole('button', { name: requirement.title, exact: true })
    .locator('.node-mention')
  await expect(observerUnread).toBeVisible()
  await page.bringToFront()
  const receiptSaved = page.waitForResponse(
    (response) => response.url().endsWith('/api/workflow/chat-mentions/read') && response.ok(),
  )
  await node.click()
  const answer = page.locator('.hub-final-answer')
  await expect(answer.locator('.chat-mention')).toHaveText(['@Haibin', '@codex'])
  const { keys } = await (await receiptSaved).json()
  expect(keys).toHaveLength(1)
  expect((await (await request.get('/api/workflow')).json()).read_chat_mentions).toContain(keys[0])
  await expect(unread).toHaveCount(0)
  await expect(observerUnread).toHaveCount(0)
  await observerContext.close()
  for (const author of ['user', 'agent']) {
    const header = page.locator(`[data-run-anchor="${run.run_id}-${author}"] .message-author`)
    const gap = await header.evaluate((element) => {
      const name = element.firstElementChild!.getBoundingClientRect()
      const time = element.querySelector('time')!.getBoundingClientRect()
      return time.left - name.right
    })
    expect(gap).toBe(11)
  }
  await expect(answer.getByRole('link', { name: '目录外', exact: true })).toHaveCount(0)
  await expect(answer.getByText('目录外', { exact: true })).toBeVisible()
  await expect(answer.getByRole('button', { name: 'src/preview.txt:2', exact: true })).toBeVisible()
  const fileLink = answer.getByRole('button', { name: '清单', exact: true })
  await fileLink.focus()
  await fileLink.press('Enter')
  const preview = page.getByRole('dialog', { name: /src\/preview\.txt:2/ })
  await expect(preview.locator('mark')).toHaveText('<script>plain text</script>')
  await expect(preview.locator('script')).toHaveCount(0)
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(fileLink).toBeFocused()

  await answer.getByRole('button', { name: '符号链接', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('符号链接')
  await expect(page.getByRole('dialog')).not.toContainText('outside content')
  const blocked = await request.post(`/api/runs/${run.run_id}/file`, {
    data: { path: '../secret-outside.txt' },
  })
  expect(blocked.status()).toBe(400)
  expect(await blocked.text()).not.toContain('outside content')
  await page.reload()
  await expect(page.locator('.hub-final-answer .chat-mention')).toHaveCount(2)
  await expect(unread).toHaveCount(0)
  expect(errors).toEqual([])
})

test('legacy at-mention receipts migrate when the Console opens', async ({ page, request }) => {
  const legacyKey = 'mention:' + JSON.stringify(['task-message', randomUUID()])
  await page.goto('/')
  await page.evaluate(
    (key) => localStorage.setItem('rein.read-node-notices', JSON.stringify([key])),
    legacyKey,
  )
  await page.reload()
  await expect
    .poll(async () => (await (await request.get('/api/workflow')).json()).read_chat_mentions)
    .toContain(legacyKey)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('rein.read-node-notices')))
    .toBe('[]')
})

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
  await page
    .getByRole('textbox', { name: '你想做什么？', exact: true })
    .fill('首选工作目录被删除后自动回退。')
  await page.getByRole('button', { name: '开始对话', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: `${requirement.title} - 首选目录回退`, exact: true }),
  ).toBeVisible()
  await expect(page.locator('.spec-tree .lucide-waypoints')).toHaveCount(1)
  await expect(page.getByText('Hello 1', { exact: true })).toBeVisible()
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
    'requirements.md':
      '# 首选目录回退\n删除首选目录时选择第一个有效目录。\n\n## Acceptance Criteria\n' +
      plan.criteria.map((item) => `- ${item.id}: ${item.text}`).join('\n'),
    'design.md': '# 技术设计\n沿用现有项目配置。',
    'tasks.md': plan.tasks
      .map(
        (item) =>
          `- [ ] ${item.id} ${item.title}\n  ${item.description}\n  Acceptance: ${item.acceptance_ids.join(', ')}`,
      )
      .join('\n'),
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
  await page.getByRole('button', { name: '不修改，直接进入', exact: true }).click()
  await page.getByRole('tab', { name: '设计', exact: true }).click()
  await expect(page.locator('.spec-panel')).toContainText('沿用现有项目配置。')
  await expect
    .poll(async () => {
      const history = await (
        await request.get(`/api/agents/pi/history?session_id=${spec.session_id}`)
      ).json()
      return (
        history.runs.length >= 2 &&
        history.runs.every((r: { run: { state: string } }) => r.run.state === 'completed')
      )
    })
    .toBe(true)
  await page.getByRole('button', { name: '确认设计，拆分任务', exact: true }).click()
  await page.getByRole('button', { name: '不修改，直接进入', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await expect
    .poll(async () => {
      const history = await (
        await request.get(`/api/agents/pi/history?session_id=${spec.session_id}`)
      ).json()
      return (
        history.runs.length >= 3 &&
        history.runs.every((r: { run: { state: string } }) => r.run.state === 'completed')
      )
    })
    .toBe(true)
  await expect(page.locator('.spec-progress-heading')).toBeVisible()
  await expect(
    page.locator('.spec-panel').getByRole('button', { name: 'tasks.md', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.locator('.spec-panel').getByRole('button', { name: '编辑', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.spec-panel').getByRole('button', { name: '预览', exact: true }),
  ).toBeVisible()
  const laterTask = page.locator('.spec-task-item').filter({ hasText: '补齐空目录提示' })
  await expect(laterTask.getByRole('button', { name: '提交到 Todo', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '开始构建', exact: true }).click()
  await expect(page.locator('.spec-panel')).toContainText('待开始')
  await laterTask.getByRole('button', { name: '提交到 Todo', exact: true }).click()
  await expect(laterTask).toContainText('待开始')
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Todo', exact: true })).toBeVisible()
  await expect(page.locator('.task-card').filter({ hasText: '实现首选目录回退' })).toContainText(
    'Coding',
  )
  await expect(page.locator('.task-card')).toHaveCount(2)
  await page.screenshot({
    path: 'test-results/spec-todo-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  const { agents } = await (await request.get('/api/agents')).json()
  const sourceDirectory = join(
    dirname(agents.find((agent: { name: string }) => agent.name === 'pi').directory),
    'specs',
    spec.directory,
  )
  writeFileSync(join(sourceDirectory, 'require-approval'), '')
  writeFileSync(join(sourceDirectory, 'require-document-approval'), '')
  await request.post('/api/workflow/settings', {
    data: { main_agent: 'pi', coding_agents: ['pi'], review_agents: ['codex'], automatic: true },
  })
  const requirementStatus = page
    .getByRole('button', { name: requirement.title, exact: true })
    .locator('.node-status')
  const specStatus = page
    .getByRole('button', { name: '打开 Spec 首选目录回退', exact: true })
    .locator('.node-status')
  const waiting = page.locator('[data-task-message="waiting"]')
  await expect(waiting).toContainText('@Haibin')
  await expect(waiting.locator('.message-author strong')).toHaveText('pi')
  await expect(waiting.getByRole('img', { name: '系统消息', exact: true })).toBeVisible()
  await expect(waiting.locator('.message-bubble')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(waiting.locator('.message-bubble')).toHaveCSS(
    'border-left',
    '1px solid rgb(229, 232, 239)',
  )
  const waitingActions = waiting.locator('.message-task-actions')
  await expect(waitingActions.getByRole('button', { name: 'Handoff', exact: true })).toHaveCount(0)
  await expect(waitingActions).toHaveCSS('border-left', '1px solid rgb(229, 232, 239)')
  await expect(requirementStatus).toHaveAttribute('data-state', 'waiting')
  await expect(specStatus).toHaveAttribute('data-state', 'waiting')
  const waitingCard = page.locator('.task-card').filter({ hasText: '实现首选目录回退' })
  await expect(waitingCard.getByRole('button', { name: '消除需要你回复提示' })).toBeVisible()
  await waiting.getByRole('button', { name: '查看任务交互', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Agent 会话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible()
  const taskDetail = page.getByRole('region', { name: '任务详情', exact: true })
  await taskDetail.getByRole('button', { name: '消除需要你回复提示' }).click()
  await expect(waitingCard.locator('.node-status[data-state="waiting"]')).toHaveCount(0)
  await expect(requirementStatus).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible()
  unlinkSync(join(sourceDirectory, 'require-approval'))
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(
    page.locator('.task-detail').getByRole('button', { name: '确认', exact: true }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  const documentInteraction = page.locator('[data-task-message="update_waiting"]')
  await expect(documentInteraction).toContainText('@Haibin')
  await expect(documentInteraction.locator('.message-author strong')).toHaveText('pi')
  await expect(requirementStatus).toHaveCount(0)
  await expect(specStatus).toHaveAttribute('data-state', 'waiting')
  await expect(page.getByRole('button', { name: '确认', exact: true })).toBeVisible()
  unlinkSync(join(sourceDirectory, 'require-document-approval'))
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/workflow')).json()).specs.find(
          (s: { id: string }) => s.id === spec.id,
        ).phase,
      { timeout: 15000 },
    )
    .toBe('ready_verification')
  await expect(specStatus).toHaveAttribute('data-state', 'ready')
  await expect(requirementStatus).toHaveCount(0)
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
  await page.getByRole('tab', { name: 'Agent 会话', exact: true }).click()
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
  const started = page.locator('[data-task-message="started"]').first()
  await expect(started.locator('.message-author strong')).toHaveText('pi')
  const startedActions = started.locator('.message-task-actions')
  await expect(startedActions.getByRole('button', { name: '查看任务', exact: true })).toBeVisible()
  await expect(startedActions.getByRole('button', { name: 'Handoff', exact: true })).toHaveCount(0)
  await expect(startedActions).toHaveCSS('border-left', '1px solid rgb(229, 232, 239)')
  await expect(
    page.locator('[data-task-message="completed"]').filter({ hasText: 'codex' }).first(),
  ).toBeVisible()
  const completion = page.locator('[data-task-message="completed"]').filter({
    hasText: '已完成「实现首选目录回退」',
  })
  await expect(completion.getByRole('img', { name: '系统消息', exact: true })).toBeVisible()
  const actions = completion.locator('.message-task-actions')
  const handoffBorder = await actions.evaluate((element) => getComputedStyle(element).borderLeft)
  await expect(completion.locator('.message-bubble')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(completion.locator('.message-bubble')).toHaveCSS('border-left', handoffBorder)
  await expect(completion.locator('.message-bubble')).not.toContainText('验证证据')
  await expect(completion).not.toContainText('本次按照任务范围完成实现检查')
  const handoffButton = completion.getByRole('button', { name: 'Handoff', exact: true })
  const taskButton = completion.getByRole('button', { name: '查看任务', exact: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(handoffButton).toBeVisible()
    await expect(taskButton).toBeVisible()
    await expect
      .poll(() =>
        actions.evaluate((element) => {
          const preview = element.querySelector('.handoff-links button')!.getBoundingClientRect()
          const task = element.querySelector(':scope > button')!.getBoundingClientRect()
          return (
            preview.right <= task.left &&
            Math.abs(preview.top + preview.height / 2 - task.top - task.height / 2) < 1
          )
        }),
      )
      .toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await handoffButton.click()
  const handoff = page.getByRole('dialog', { name: 'Task Handoff · 实现首选目录回退' })
  await expect(handoff.locator('.sdd-markdown')).toContainText('本次按照任务范围完成实现检查')
  await handoff.getByText('查看完整任务报告').click()
  await expect(handoff.getByText(/验证证据：Deterministic fixture assertion/)).toBeVisible()
  await handoff.getByRole('button', { name: '关闭交接文件', exact: true }).click()
  await expect
    .poll(
      async () => {
        const workflow = await (await request.get('/api/workflow')).json()
        return workflow.messages
          .filter(
            (message: { spec_id: string; kind: string }) =>
              message.spec_id === spec.id && message.kind === 'completed',
          )
          .every((message: { update_done: boolean }) => message.update_done)
      },
      { timeout: 15000 },
    )
    .toBe(true)
  const completedDocument = await (await request.get(`/api/artifacts/${spec.id}/tasks.md`)).json()
  expect(completedDocument.content).toContain('- [x] T-01')
  expect(completedDocument.content).toContain('- [x] T-02')
  expect(completedDocument.content).toContain('## Verification Results')
  await expect(page.locator('.task-group-done .task-card')).toHaveCount(4)
  await expect(
    page.locator('.task-group-done .group-header img[src$="main-MaterialCheck.svg"]'),
  ).toBeVisible()
  await expect(
    page.locator('.task-group-done .task-state img[src$="main-MaterialCheck.svg"]'),
  ).toHaveCount(4)
  await expect(requirementStatus).toHaveCount(0)
  await expect(specStatus).toHaveCount(0)
  await page
    .locator('.task-group-done')
    .getByRole('button', { name: /Coding Handoff/ })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: /Task Handoff · .+/ })).toContainText(
    '本次按照任务范围完成实现检查',
  )
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
  let eventStreams = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events') eventStreams++
  })
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
  const composer = page.getByRole('textbox', { name: '发送消息', exact: true })
  await composer.fill('需求讨论草稿')
  await page.getByRole('button', { name: '打开 Spec Spec A', exact: true }).click()
  await expect(composer).toHaveValue('')
  await composer.fill('只属于 A 的讨论')
  await page.getByRole('button', { name: '打开 Spec Spec B', exact: true }).click()
  await expect(composer).toHaveValue('')
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('只属于 B 的讨论')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.getByText('Hello 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开 Spec Spec A', exact: true }).click()
  await expect(composer).toHaveValue('只属于 A 的讨论')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.getByText('Hello 1', { exact: true })).toBeVisible()
  await expect(page.getByText('只属于 A 的讨论', { exact: true })).toBeVisible()
  await expect(page.getByText('只属于 B 的讨论', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await expect(composer).toHaveValue('需求讨论草稿')
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
  await page.getByRole('button', { name: 'Agents 编排', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '为 pi 安装 rein-spec？' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'pi Coding角色', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'codex Review角色', exact: true })).toBeChecked()
  expect(eventStreams).toBe(1)
  await page.getByLabel('主 Agent', { exact: true }).selectOption('codex')
  await expect(page.getByRole('dialog', { name: '为 codex 安装 rein-spec？' })).toHaveCount(0)
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

test('Spec document edits share phase review and next-document choices with chat', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '统一阶段审阅')
  const { spec } = await (
    await request.post('/api/specs', {
      data: {
        requirement_id: requirement.id,
        title: '计算器',
        description: '基础计算器',
        start: true,
      },
    })
  ).json()
  await select(page, project.name, requirement.title)
  await page.getByRole('button', { name: '打开 Spec 计算器', exact: true }).click()
  const panel = page.locator('.spec-panel')
  const progress = async () =>
    JSON.parse(
      (await (await request.get(`/api/artifacts/${spec.id}/.spec-state.json`)).json()).content,
    )
  await expect(panel.getByRole('button', { name: '确认需求，继续设计', exact: true })).toBeEnabled()
  const original = (await (await request.get(`/api/artifacts/${spec.id}/requirements.md`)).json())
    .content
  const stateBefore = await progress()
  await panel.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = panel.locator('textarea:not([aria-hidden="true"])').first()
  await editor.fill('未保存的修改')
  await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(
    (await (await request.get(`/api/artifacts/${spec.id}/requirements.md`)).json()).content,
  ).toBe(original)
  expect(await progress()).toEqual(stateBefore)
  await panel.getByRole('button', { name: '编辑', exact: true }).click()
  await editor.fill('# 计算器需求\n\n## Acceptance Criteria\n- AC-01: 支持加减乘除并提示除零错误。')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '确认需求，继续设计', exact: true })).toBeEnabled()
  expect((await progress()).phase).toBe('requirements')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await panel.getByRole('button', { name: '确认需求，继续设计', exact: true }).click()
  await expect(panel.locator('.spec-phase-status')).toContainText('设计 · 待确认')
  const currentDot = panel
    .getByRole('tab', { name: '设计', exact: true })
    .locator('.spec-document-state')
  await expect(currentDot).toHaveAttribute('aria-label', '当前阶段')
  expect(await currentDot.evaluate((dot) => getComputedStyle(dot, '::before').backgroundColor)).toBe(
    'rgb(8, 102, 255)',
  )
  const originalDesign = (await (await request.get(`/api/artifacts/${spec.id}/design.md`)).json())
    .content
  await request.post(`/api/artifacts/${spec.id}/tasks.md`, {
    data: { content: '# 现有任务\n- [ ] T-01 原任务\n  Acceptance: AC-01\n' },
  })
  await page.getByRole('tab', { name: '需求', exact: true }).click()
  await panel.getByRole('button', { name: '编辑', exact: true }).click()
  await editor.fill('# 计算器需求修订\n\n## Acceptance Criteria\n- AC-01: 修改后的验收说明。')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.locator('.spec-phase-status')).toContainText('需求 · 待确认')
  expect((await progress()).phase).toBe('requirements')
  expect((await (await request.get(`/api/artifacts/${spec.id}/design.md`)).json()).content).toBe(
    originalDesign,
  )
  await expect(panel.getByRole('button', { name: '确认修改', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '确认需求，继续设计', exact: true }).click()
  const choice = page.getByRole('dialog', { name: '下一阶段文档已存在', exact: true })
  await expect(choice).toContainText('design.md')
  await page.screenshot({
    path: 'test-results/spec-stage-choice-desktop.png',
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/spec-stage-choice-mobile.png',
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await choice.getByRole('button', { name: '不修改，直接进入', exact: true }).click()
  await expect(panel.locator('.spec-phase-status')).toContainText('设计 · 待确认')
  expect((await (await request.get(`/api/artifacts/${spec.id}/design.md`)).json()).content).toBe(
    originalDesign,
  )
  await panel.getByRole('button', { name: '确认设计，拆分任务', exact: true }).click()
  await expect(choice).toContainText('tasks.md')
  const holdPlanning = join(
    dirname(project.preferred_directory),
    'specs',
    spec.directory,
    'hold-planning',
  )
  writeFileSync(holdPlanning, '')
  try {
    await choice.getByRole('button', { name: '修改后进入', exact: true }).click()
    await expect(panel.locator('.spec-phase-status')).toContainText('任务 · 处理中')
    expect(
      (await (await request.get('/api/workflow')).json()).specs.find(
        (item: { id: string }) => item.id === spec.id,
      ).phase,
    ).toBe('design')
    const designTab = panel.getByRole('tab', { name: '设计', exact: true })
    const tasksTab = panel.getByRole('tab', { name: '任务', exact: true })
    await expect(designTab.locator('.spec-document-state.confirmed .lucide-check')).toHaveCount(1)
    await expect(tasksTab).toHaveAttribute('aria-description', '进行中')
    await expect(tasksTab).toHaveAttribute('aria-current', 'step')
    await expect(tasksTab.locator('.lucide-loader-circle')).toHaveClass(/spin/)
    await designTab.click()
    await expect(designTab).toHaveAttribute('aria-selected', 'true')
    await expect(designTab).not.toHaveAttribute('aria-current')
    await expect(tasksTab).toHaveAttribute('aria-current', 'step')
    await tasksTab.click()
    await page.screenshot({
      path: 'test-results/spec-stage-progress-desktop.png',
      animations: 'disabled',
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Spec', exact: true }).click()
    await expect(designTab.locator('.lucide-check')).toBeVisible()
    await expect(tasksTab.locator('.lucide-loader-circle')).toBeVisible()
    await page.screenshot({
      path: 'test-results/spec-stage-progress-mobile.png',
      animations: 'disabled',
    })
    await page.setViewportSize({ width: 1440, height: 900 })
  } finally {
    unlinkSync(holdPlanning)
  }
  await expect(panel.locator('.spec-phase-status')).toContainText('任务 · 待确认')
  await expect(panel).toContainText('修订实现')
  expect((await progress()).phase).toBe('tasks')
  const path = join(
    dirname(project.preferred_directory),
    'specs',
    spec.directory,
    '.spec-state.json',
  )
  const ready = readFileSync(path, 'utf8')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(ready), blocking: '请确认任务边界。' }))
  await expect(panel.locator('.spec-phase-status')).toContainText('等待补充信息')
  await expect(panel.getByRole('button', { name: '开始构建', exact: true })).toBeDisabled()
  writeFileSync(path, ready)
  await expect(panel.getByRole('button', { name: '开始构建', exact: true })).toBeEnabled()
  const savedTasks = (await (await request.get(`/api/artifacts/${spec.id}/tasks.md`)).json())
    .content
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Spec', exact: true }).click()
  await panel.getByRole('button', { name: '编辑', exact: true }).click()
  await editor.fill(savedTasks + '\n未保存的任务备注。')
  expect(
    await panel
      .locator('.spec-document-toolbar')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBeTruthy()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect((await (await request.get(`/api/artifacts/${spec.id}/tasks.md`)).json()).content).toBe(
    savedTasks,
  )
})

test('refresh restores the last Spec tab, mobile panel and task detail, and tolerates stale locations', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '恢复操作界面')
  const { spec } = await (
    await request.post('/api/specs', {
      data: { requirement_id: requirement.id, title: '保留标签页', description: '恢复导航位置' },
    })
  ).json()
  await select(page, project.name, requirement.title)
  await page.getByRole('button', { name: '打开 Spec 保留标签页', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  await expect(page.locator('.spec-progress-heading')).toBeVisible()
  await page.locator('.spec-panel').getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('.spec-panel .spec-empty')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Spec', exact: true }).click()
  await page.route('**/api/projects', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.continue()
  })
  await page.reload()
  await expect(page.locator('.split-layout')).toHaveClass(/mobile-show-tasks/)
  await expect(page.locator('.spec-panel')).toBeVisible()
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.spec-document-toolbar')).toContainText('tasks.md')
  await expect(page.locator('.spec-progress-heading')).toBeVisible()
  await expect(page.locator('.spec-panel .spec-empty')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('rein.navigation')!).scope.specId),
    )
    .toBe(spec.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  const { task } = await (
    await request.post('/api/tasks', {
      data: {
        requirement_id: requirement.id,
        title: '恢复工作记录页',
        description: '保留详情位置',
        role: 'coding',
      },
    })
  ).json()
  await page.getByRole('button', { name: '打开任务 恢复工作记录页', exact: true }).click()
  await page.getByRole('tab', { name: 'Agent 会话', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: requirement.title, exact: true })).toBeVisible()
  await expect(page.locator('.task-detail')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Agent 会话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('rein.navigation')!).selectedTask),
    )
    .toBe(task.id)
  await page.evaluate(
    ({ projectId, requirementId }) => {
      localStorage.setItem(
        'rein.navigation',
        JSON.stringify({
          scope: {
            id: 'removed-spec',
            specId: 'removed-spec',
            requirementId,
            projectId,
            title: '过期标题',
            label: 'Spec',
          },
          selectedTask: 'removed-task',
          mobilePanel: 'chat',
        }),
      )
    },
    { projectId: project.id, requirementId: requirement.id },
  )
  await page.reload()
  await expect(page.getByRole('heading', { name: requirement.title, exact: true })).toBeVisible()
  await expect(page.locator('.task-detail')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('rein.navigation')!).scope.specId ?? null,
      ),
    )
    .toBeNull()
  await page.evaluate(() => localStorage.setItem('rein.navigation', '{broken'))
  await page.reload()
  await expect(page.getByRole('heading', { name: '选择需求或 Agent', exact: true })).toBeVisible()
})

test('Spec Builder starts a typed conversation and chat approval matches the panel', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '创建 Spec')
  await select(page, project.name, requirement.title)
  await page.getByRole('button', { name: `新建 Spec ${requirement.title}`, exact: true }).click()
  const builder = page.getByRole('dialog', { name: '新建Spec', exact: true })
  await expect(builder.getByRole('radio', { name: '构建新东西', exact: true })).toBeChecked()
  await expect(builder.getByRole('radio')).toHaveCount(2)
  await expect(builder.getByText('快速方案', { exact: true })).toHaveCount(0)
  await expect(builder.getByRole('textbox', { name: /工作目录|项目文件夹/ })).toHaveCount(0)
  await builder.getByRole('textbox', { name: 'Spec 名称', exact: true }).fill('修复导出崩溃')
  await expect(builder.getByRole('button', { name: '开始对话', exact: true })).toBeDisabled()
  await builder
    .getByRole('textbox', { name: '你想做什么？', exact: true })
    .fill('导出大文件时崩溃，需要保留现有格式。')
  await builder.getByRole('radio', { name: '修复 bug', exact: true }).check()
  await page.screenshot({
    path: 'test-results/spec-builder-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/spec-builder-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await builder.getByRole('button', { name: '开始对话', exact: true }).click()
  await expect(builder).toBeHidden()
  const log = page.getByRole('log', { name: 'pi的聊天记录', exact: true })
  await expect(log).toContainText('请创建 Spec「修复导出崩溃」')
  await expect(log).toContainText('工作类型：修复 bug')
  await expect(log).not.toContainText('REIN_SPEC_USER_MESSAGE')
  await expect(page.locator('.spec-panel')).toContainText('大文件导出不会崩溃', { timeout: 8000 })
  await expect(page.locator('.spec-panel')).toContainText('当前文档已就绪', { timeout: 8000 })
  await expect(page.locator('.hub-run-status')).toHaveCount(0)
  const snapshot = await (await request.get('/api/workflow')).json()
  const spec = snapshot.specs.find((s: { title: string }) => s.title === '修复导出崩溃')
  expect(spec.kind).toBe('bugfix')
  const stateFile = async () =>
    JSON.parse(
      (await (await request.get(`/api/artifacts/${spec.id}/.spec-state.json`)).json()).content,
    )
  expect(await stateFile()).toMatchObject({
    phase: 'requirements',
    blocking: 'User review of requirements.md',
    context: { template: 'bugfix' },
  })
  await expect(page.locator('.MuiSnackbar-root')).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/spec-conversation-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/spec-conversation-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Spec', exact: true }).click()
  await page.screenshot({
    path: 'test-results/spec-document-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.spec-panel').getByRole('button', { name: '编辑', exact: true }).click()
  await page
    .locator('.spec-panel textarea:not([aria-hidden="true"])')
    .first()
    .fill(
      '# 导出修复需求\n\n## Acceptance Criteria\n- AC-01: 大文件导出不会崩溃，保留现有导出格式\n保留已审阅的草稿。',
    )
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('同意')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.locator('.hub-alert')).toContainText('请先保存右侧 Spec 草稿')
  expect(
    (await (await request.get('/api/workflow')).json()).specs.find(
      (s: { id: string }) => s.id === spec.id,
    ).phase,
  ).toBe('requirements')
  await page.locator('.spec-panel').getByRole('button', { name: '保存', exact: true }).click()
  await expect(
    page.getByText('文档已保存，主 Agent 将在对应阶段审阅', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.getByRole('tab', { name: '设计', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.spec-panel')).toContainText('分析内存占用的根因', { timeout: 8000 })
  expect(await stateFile()).toMatchObject({ phase: 'design', blocking: 'User review of design.md' })
  await expect(page.locator('.hub-run-status')).toHaveCount(0)
  await page.getByRole('button', { name: '确认设计，拆分任务', exact: true }).click()
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.spec-progress-heading')).toBeVisible()
  await expect(page.locator('.spec-task-main')).toContainText('修复大文件导出')
  await page.locator('.spec-panel').getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('.spec-panel .sdd-markdown')).toContainText('T-01 修复大文件导出')
  await page.locator('.spec-panel').getByRole('button', { name: '任务进度', exact: true }).click()
  await expect(log).toContainText('确认设计，拆分任务')
  expect(await stateFile()).toMatchObject({ phase: 'tasks', blocking: 'User review of tasks.md' })
  await expect(page.locator('.hub-run-status')).toHaveCount(0)
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('按这份任务计划执行吧')
  await page.getByRole('button', { name: '发送消息按钮', exact: true }).click()
  await expect(page.locator('.spec-phase-status')).toContainText('构建中')
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/workflow')).json()).tasks.filter(
          (t: { spec_id: string }) => t.spec_id === spec.id,
        ).length,
    )
    .toBe(1)
  await page.reload()
  await page.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill(project.name)
  await page.getByRole('button', { name: '打开 Spec 修复导出崩溃', exact: true }).click()
  await expect(log).toContainText('请创建 Spec「修复导出崩溃」')
  await expect(page.locator('.spec-phase-status')).toContainText('构建中')
})

test('a failed initial Spec conversation can retry after the main Agent comes online', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '重试首轮')
  await request.post('/api/agents/pi/availability', { data: { enabled: false } })
  try {
    await select(page, project.name, requirement.title)
    await page.getByRole('button', { name: `新建 Spec ${requirement.title}`, exact: true }).click()
    await page.getByRole('textbox', { name: 'Spec 名称', exact: true }).fill('离线后恢复')
    await page
      .getByRole('textbox', { name: '你想做什么？', exact: true })
      .fill('为导出功能增加进度提示。')
    await page.getByRole('button', { name: '开始对话', exact: true }).click()
    await expect(page.locator('.spec-panel')).toContainText('开始 Spec 对话失败')
    const retry = page.getByRole('button', { name: '重试开始对话', exact: true })
    await expect(retry).toBeDisabled()
    await request.post('/api/agents/pi/availability', { data: { enabled: true } })
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(page.getByRole('log')).toContainText('请创建 Spec「离线后恢复」')
    await expect(page.getByRole('log')).toContainText('工作类型：构建新东西')
    const state = await (await request.get('/api/workflow')).json()
    expect(
      state.specs.filter((s: { requirement_id: string }) => s.requirement_id === requirement.id),
    ).toHaveLength(1)
    expect(
      state.specs.find((s: { requirement_id: string }) => s.requirement_id === requirement.id)
        .error,
    ).toBeNull()
  } finally {
    await request.post('/api/agents/pi/availability', { data: { enabled: true } })
  }
})

test('main Agent skill installation needs consent and supports all three roles', async ({
  page,
  request,
}) => {
  const { agents: initialAgents } = await (await request.get('/api/agents')).json()
  const { skills: _skills, ...nativePi } = initialAgents.find(
    (agent: { name: string }) => agent.name === 'pi',
  )
  await request.put('/api/agents/pi', { data: { ...nativePi, skill_source: 'native' } })
  await request.post('/api/workflow/settings', {
    data: { main_agent: null, coding_agents: [], review_agents: [], automatic: false },
  })
  let installs = 0
  page.on('request', (event) => {
    if (event.method() === 'POST' && event.url().endsWith('/api/agents/pi/skills')) installs += 1
  })
  await page.goto('/')
  await page.getByRole('button', { name: '个人菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Agents 编排', exact: true }).click()
  await page.getByLabel('主 Agent', { exact: true }).selectOption('pi')
  const dialog = page.getByRole('dialog', { name: '为 pi 安装 rein-spec？' })
  await expect(dialog).toBeVisible()
  const before = await (await request.get('/api/agents/pi/skills')).json()
  expect(before.source_path).toContain('/skills/rein-spec')
  expect(before.rein_spec_installed).toBe(false)
  await expect(dialog).toContainText(before.source_path)
  await expect(dialog).toContainText(before.install_path)
  await page.screenshot({
    path: 'test-results/skill-install-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/skill-install-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '暂不安装', exact: true }).click()
  expect(installs).toBe(0)
  expect((await (await request.get('/api/agents/pi/skills')).json()).rein_spec_installed).toBe(
    false,
  )
  await page.getByRole('checkbox', { name: 'pi Coding角色', exact: true }).check()
  await page.getByRole('checkbox', { name: 'pi Review角色', exact: true }).check()
  await page.getByRole('button', { name: '保存编排配置', exact: true }).click()
  await expect
    .poll(async () => (await (await request.get('/api/workflow')).json()).settings)
    .toEqual({
      main_agent: 'pi',
      coding_agents: ['pi'],
      review_agents: ['pi'],
      automatic: false,
    })
  await page.getByRole('button', { name: '安装 rein-spec', exact: true }).click()
  await page.route('**/api/agents/pi/skills', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 400, json: { error: '安装目录不可写，请检查权限后重试' } })
      await page.unroute('**/api/agents/pi/skills')
    } else await route.continue()
  })
  await page.getByRole('button', { name: '允许安装', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('安装目录不可写')
  await page.getByRole('button', { name: '允许安装', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(installs).toBe(2)
  const agentRow = page
    .locator('.workflow-agent-row')
    .filter({ has: page.getByRole('checkbox', { name: 'pi Coding角色', exact: true }) })
  const roles = agentRow.getByRole('group', { name: 'pi角色', exact: true })
  const skills = agentRow.getByRole('group', { name: 'pi技能', exact: true })
  for (const label of ['主 Agent', 'Coding', 'Review']) await expect(roles).toContainText(label)
  await expect(roles.locator('.agent-label')).toHaveCount(3)
  await expect(roles).not.toContainText('rein-spec')
  await expect(skills).toContainText('rein-spec')
  await expect(skills.locator('.agent-role-label')).toHaveCount(0)
  expect((await (await request.get('/api/agents/pi/skills')).json()).rein_spec_installed).toBe(true)
  await page.screenshot({
    path: 'test-results/agent-roles-mobile.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({
    path: 'test-results/agent-roles-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  const roster = page
    .locator('.agent-roster-row')
    .filter({ has: page.getByRole('button', { name: '与pi对话', exact: true }) })
  for (const label of ['主 Agent', 'Coding', 'Review'])
    await expect(roster.locator('.agent-labels')).toContainText(label)
  await expect(roster.locator('.agent-label')).toHaveCount(3)
  await expect(roster).not.toContainText('rein-spec')
  await page.reload()
  for (const label of ['主 Agent', 'Coding', 'Review'])
    await expect(roster.locator('.agent-labels')).toContainText(label)
  await expect(roster.locator('.agent-label')).toHaveCount(3)
  await expect(roster).not.toContainText('rein-spec')
  await page.screenshot({
    path: 'test-results/agent-labels-sidebar.png',
    fullPage: true,
    animations: 'disabled',
  })
})

test('Todo deletion requires stopped execution and survives reload', async ({ page, request }) => {
  const { project, requirement } = await projectWithSpec(request, '删除 Todo')
  const response = await request.post('/api/tasks', {
    data: { requirement_id: requirement.id, title: '可以删除的任务', role: 'coding' },
  })
  const { task } = await response.json()
  const directory = join(dirname(project.directories[0]), 'tasks', task.directory)
  writeFileSync(join(directory, 'hold-running'), '')
  await request.post(`/api/tasks/${task.id}/action`, { data: { action: 'start' } })
  await select(page, project.name, requirement.title)
  const card = page.locator('.task-card').filter({ hasText: task.title })
  const requirementStatus = page
    .getByRole('button', { name: requirement.title, exact: true })
    .locator('.node-status')
  await expect(card).toContainText('停止任务')
  await expect(requirementStatus).toHaveAttribute('data-state', 'running')
  await expectStatusNextToTitle(page.getByRole('button', { name: requirement.title, exact: true }))
  await expect(card.locator('.node-status')).toHaveAttribute('data-state', 'running')
  await card.getByRole('button', { name: `打开任务 ${task.title}` }).click()
  await expect(requirementStatus).toHaveCount(0)
  await expect(card.locator('.node-status')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
  await card.getByRole('button', { name: /任务操作$/ }).click()
  await expect(page.getByRole('menuitem', { name: '删除任务', exact: true })).toBeDisabled()
  expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBe(false)
  await page.keyboard.press('Escape')
  await card.getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(card).toContainText('已暂停')
  await expect(card.getByRole('button', { name: '重试任务', exact: true })).toBeVisible()
  await expect(requirementStatus).toHaveCount(0)
  await card.getByRole('button', { name: /任务操作$/ }).click()
  await page.getByRole('menuitem', { name: '删除任务', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(requirementStatus).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.task-card').filter({ hasText: task.title })).toHaveCount(0)
  expect((await (await request.get('/api/agents/pi/history')).json()).runs.length).toBeGreaterThan(
    0,
  )
})

test('sidebar follows Spec generation, interaction and failure away from the Spec page', async ({
  page,
  request,
}) => {
  let streams = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/events') streams++
  })
  const { project, requirement } = await projectWithSpec(request, '侧栏状态')
  const { spec } = await (
    await request.post('/api/specs', {
      data: { requirement_id: requirement.id, title: '后台生成与交互', description: '' },
    })
  ).json()
  const directory = join(dirname(project.directories[0]), 'specs', spec.directory)
  writeFileSync(join(directory, 'hold-planning'), '')
  expect((await request.post(`/api/specs/${spec.id}/start`)).ok()).toBe(true)
  await select(page, project.name, requirement.title)
  const requirementNode = page.getByRole('button', { name: requirement.title, exact: true })
  const specNode = page.getByRole('button', { name: `打开 Spec ${spec.title}`, exact: true })
  const requirementStatus = requirementNode.locator('.node-status')
  const specStatus = specNode.locator('.node-status')
  await expect(specStatus).toHaveAttribute('data-state', 'running')
  await expect(specStatus.locator('svg')).toHaveClass(/spin/)
  await expect(requirementStatus).toHaveCount(0)
  await expect(specNode.locator('.lucide-waypoints')).toHaveCount(1)
  await page.screenshot({
    path: 'test-results/sidebar-generating-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await specNode.click()
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '发送消息', exact: true })
  await composer.fill('先澄清')
  await composer.press('Enter')
  await expect(page.getByText('已排队，本轮执行结束后发送')).toBeVisible()
  await requirementNode.click()
  const followup = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/specs/${spec.id}/chat`) &&
      response.request().postDataJSON()?.prompt === '先澄清',
  )
  unlinkSync(join(directory, 'hold-planning'))
  expect((await followup).ok()).toBe(true)
  await expect(specStatus).toHaveCount(0)
  expect(
    (
      await request.post(`/api/specs/${spec.id}/chat`, {
        data: { prompt: '信息已补充', request_id: randomUUID() },
      })
    ).ok(),
  ).toBe(true)
  await expect(specStatus).toHaveAttribute('data-state', 'ready')
  expect(
    (await request.post(`/api/specs/${spec.id}/action`, { data: { action: 'pause' } })).ok(),
  ).toBe(true)
  await expect(specStatus).toHaveAttribute('data-state', 'ready')
  await expect(specStatus).toHaveAttribute('aria-label', '可进入下一阶段')
  await expectStatusNextToTitle(specNode)
  await page.screenshot({
    path: 'test-results/sidebar-ready-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await expect(requirementStatus).toHaveCount(0)
  await specNode.click()
  const specWorkspace = page.getByRole('region', { name: 'Spec 工作区', exact: true })
  await expect(specStatus).toHaveAttribute('data-state', 'paused')
  const stoppedDot = specWorkspace
    .getByRole('tab', { name: '需求', exact: true })
    .locator('.spec-document-state')
  await expect(stoppedDot).toHaveAttribute('aria-label', '已停止，未完成')
  expect(await stoppedDot.evaluate((dot) => getComputedStyle(dot, '::before').backgroundColor)).toBe(
    'rgb(122, 129, 144)',
  )
  await specWorkspace.getByRole('button', { name: '消除已停止或暂停提示' }).click()
  await expect(specStatus).toHaveCount(0)
  await requirementNode.click()
  const { run } = await (
    await request.post(`/api/specs/${spec.id}/chat`, {
      data: {
        prompt: 'fixture-approval',
        request_id: randomUUID(),
      },
    })
  ).json()
  await expect(specStatus).toHaveAttribute('data-state', 'waiting')
  await expect(requirementStatus).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill('')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  await expect(specStatus).toHaveAttribute('data-state', 'waiting')
  await page.screenshot({
    path: 'test-results/sidebar-interaction-desktop.png',
    animations: 'disabled',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await expect(specStatus).toBeVisible()
  await expect(requirementStatus).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/sidebar-interaction-mobile.png',
    animations: 'disabled',
    fullPage: true,
  })
  const record = await (await request.get(`/api/runs/${run.run_id}`)).json()
  const interaction = record.events.findLast(
    (item: { event: { type: string } }) => item.event.type === 'interaction',
  ).event
  const workflow = await (await request.get('/api/workflow')).json()
  expect(workflow.execution_runs[spec.id]).toContainEqual({
    id: run.run_id,
    state: 'waiting_input',
    interaction_id: interaction.interaction_id,
  })
  expect(
    (
      await request.post(`/api/runs/${run.run_id}/reply`, {
        data: {
          attempt_id: run.attempt_id,
          command_id: randomUUID(),
          interaction_id: interaction.interaction_id,
          response: { confirmed: true },
        },
      })
    ).ok(),
  ).toBe(true)
  await expect(specStatus).toHaveAttribute('data-state', 'ready')
  await expect(requirementStatus).toHaveCount(0)
  await expectStatusNextToTitle(specNode)
  await page.screenshot({
    path: 'test-results/sidebar-ready-mobile.png',
    animations: 'disabled',
    fullPage: true,
  })
  expect(
    (
      await request.post(`/api/specs/${spec.id}/chat`, {
        data: {
          prompt: 'fixture-crash',
          request_id: randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true)
  await expect(specStatus).toHaveAttribute('data-state', 'failed')
  await expect(requirementStatus).toHaveCount(0)
  await specNode.click()
  await page.getByRole('button', { name: 'Spec', exact: true }).click()
  await specWorkspace.getByRole('button', { name: '消除执行异常提示' }).click()
  await expect(specWorkspace.getByText(/主 Agent 执行失败/)).toBeVisible()
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await expect(specStatus).toHaveCount(0)
  expect(streams).toBe(1)
})

test('a failed Spec task in Todo warns both nodes and clears after retry', async ({
  page,
  request,
}) => {
  const { project, requirement } = await projectWithSpec(request, '异常任务汇总')
  const { spec } = await (
    await request.post('/api/specs', {
      data: {
        requirement_id: requirement.id,
        title: '交接异常',
        description: '验证异常提示',
        start: true,
      },
    })
  ).json()
  await expect
    .poll(async () => {
      const history = await (
        await request.get(`/api/agents/pi/history?session_id=${spec.session_id}`)
      ).json()
      return history.runs[0]?.run.state
    })
    .toBe('completed')
  for (const [action, phase] of [
    ['approve_requirements', 'design'],
    ['approve_design', 'tasks'],
  ]) {
    expect((await request.post(`/api/specs/${spec.id}/action`, { data: { action } })).ok()).toBe(
      true,
    )
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/workflow')).json()).specs.find(
            (item: { id: string }) => item.id === spec.id,
          ).phase,
      )
      .toBe(phase)
  }
  const missingHandoff = join(
    dirname(project.directories[0]),
    'specs',
    spec.directory,
    'missing-handoff-once',
  )
  writeFileSync(missingHandoff, '')
  expect(
    (await request.post(`/api/specs/${spec.id}/action`, { data: { action: 'build' } })).ok(),
  ).toBe(true)
  await select(page, project.name, requirement.title)
  const card = page.locator('.task-card')
  await expect(card).toHaveCount(1)
  const requirementStatus = page
    .getByRole('button', { name: requirement.title, exact: true })
    .locator('.node-status')
  const specStatus = page
    .getByRole('button', { name: `打开 Spec ${spec.title}`, exact: true })
    .locator('.node-status')
  await card.getByRole('button', { name: '开始任务', exact: true }).click()
  await expect(card.locator('.queue-error')).toContainText('artifacts are invalid')
  await expect(requirementStatus).toHaveAttribute('data-state', 'failed')
  await expect(specStatus).toHaveAttribute('data-state', 'failed')
  await expect(requirementStatus).toHaveAttribute('aria-label', '执行异常')
  await expect(requirementStatus.locator('svg')).toHaveAttribute(
    'class',
    await specStatus.locator('svg').getAttribute('class'),
  )
  await page.reload()
  await expect(requirementStatus).toHaveAttribute('data-state', 'failed')
  await card.getByRole('button', { name: '消除执行异常提示' }).click()
  await expect(requirementStatus).toHaveCount(0)
  await expect(specStatus).toHaveCount(0)
  await page.reload()
  await expect(card.locator('.queue-error')).toContainText('artifacts are invalid')
  await expect(card.getByRole('button', { name: '消除执行异常提示' })).toHaveCount(0)
  await expect(requirementStatus).toHaveCount(0)
  writeFileSync(missingHandoff, '')
  await page.getByRole('button', { name: `打开 Spec ${spec.title}`, exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
  const retry = page
    .locator('.spec-task-item')
    .getByRole('button', { name: '重试任务', exact: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    if (width === 390) await page.getByRole('button', { name: 'Spec', exact: true }).click()
    await expect(retry).toBeVisible()
    expect(
      await retry.evaluate((button) => {
        const label = button.previousElementSibling
        if (label?.textContent !== '已暂停') return false
        const status = label.getBoundingClientRect()
        const control = button.getBoundingClientRect()
        return (
          control.left >= status.right &&
          Math.abs(control.top + control.height / 2 - status.top - status.height / 2) <= 1
        )
      }),
    ).toBe(true)
  }
  await retry.click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: requirement.title, exact: true }).click()
  await expect(card.getByRole('button', { name: '消除执行异常提示' })).toBeVisible()
  await expect(requirementStatus).toHaveAttribute('data-state', 'failed')
  await card.getByRole('button', { name: '重试任务', exact: true }).click()
  await expect(card).toContainText('已完成')
  await expect(requirementStatus).toHaveCount(0)
  await expect(specStatus.and(page.locator('[data-state="failed"]'))).toHaveCount(0)
})
