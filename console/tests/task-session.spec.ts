import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, expect, type Locator } from '@playwright/test'

for (const provider of ['pi', 'codex']) {
  test(`task description and live ${provider} guidance share the current execution`, async ({
    page,
    request,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const { agents } = await (await request.get('/api/agents')).json()
    const directory = agents.find((agent: { name: string }) => agent.name === provider).directory
    const requirement = { id: randomUUID(), title: `指导 ${provider}`, description: '' }
    const project = {
      id: randomUUID(),
      name: `任务会话 ${provider}`,
      description: '',
      directories: [directory],
      preferred_directory: directory,
      requirements: [requirement],
    }
    await request.post('/api/projects', { data: { project, previous: null } })
    await request.post('/api/workflow/settings', {
      data: { coding_agents: [provider], automatic: false },
    })
    const { task } = await (
      await request.post('/api/tasks', {
        data: {
          requirement_id: requirement.id,
          title: '修复配置回退',
          description:
            '## 目标\n恢复有效的工作目录。\n\n- 保留已有配置\n- 验证空目录边界\n\n```ts\nconst directory = preferred ?? directories[0]\n```',
          role: 'coding',
        },
      })
    ).json()
    writeFileSync(join(dirname(directory), 'tasks', task.directory, 'hold-running'), '')
    await page.goto('/')
    const search = page.getByRole('textbox', { name: '搜索项目和需求', exact: true })
    await search.fill(project.name)
    await page.getByRole('button', { name: requirement.title, exact: true }).click()
    await search.clear()
    await page.getByRole('button', { name: '打开任务 修复配置回退', exact: true }).click()
    const detail = page.getByRole('region', { name: '任务详情', exact: true })
    await expect(detail.getByRole('heading', { name: '目标', exact: true })).toBeVisible()
    await expect(detail.getByRole('textbox', { name: '任务说明', exact: true })).toHaveCount(0)
    await detail.getByRole('button', { name: '编辑说明', exact: true }).click()
    const description = detail.getByRole('textbox', { name: '任务说明', exact: true })
    await description.fill('## 目标\n恢复有效的工作目录。\n\n- 保留已有配置\n- 验证空目录边界')
    await detail.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(detail.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled()
    await detail.getByRole('button', { name: '预览说明', exact: true }).click()
    if (provider === 'pi') {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(250)
        await expect
          .poll(() =>
            detail.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1),
          )
          .toBe(true)
        await page.screenshot({
          path: `test-results/task-description-${width}.png`,
          animations: 'disabled',
          fullPage: true,
        })
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await detail.getByRole('tab', { name: 'Agent 会话', exact: true }).click()
    const input = detail.getByRole('textbox', { name: '给任务 Agent 发消息', exact: true })
    await expect(input).toBeDisabled()
    await detail.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(input).toBeEnabled()
    await expect(detail.getByLabel('负责人', { exact: true })).toHaveValue(provider)
    const state = await (await request.get('/api/workflow')).json()
    const running = state.tasks.find((item: { id: string }) => item.id === task.id)
    const original = await (await request.get(`/api/runs/${running.run_id}`)).json()
    await input.fill('先补齐空目录的测试，再修改回退逻辑。')
    await detail.getByRole('tab', { name: '任务说明', exact: true }).click()
    await expect(detail.getByRole('button', { name: '编辑说明', exact: true })).toHaveCount(0)
    await detail.getByRole('tab', { name: 'Agent 会话', exact: true }).click()
    await expect(input).toHaveValue('先补齐空目录的测试，再修改回退逻辑。')
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '草稿尚未保存', exact: true })).toHaveCount(0)
    const taskCard = page.getByRole('button', { name: '打开任务 修复配置回退', exact: true })
    await taskCard.click()
    await expect(input).toHaveValue('先补齐空目录的测试，再修改回退逻辑。')
    await page.getByRole('button', { name: `与${provider}对话`, exact: true }).click()
    await expect(detail).toHaveCount(0)
    await page.getByRole('button', { name: requirement.title, exact: true }).click()
    await taskCard.click()
    await expect(input).toHaveValue('先补齐空目录的测试，再修改回退逻辑。')
    async function sendWhileReopening(send: Locator, url: string, submit: () => Promise<void>) {
      const pending = Promise.withResolvers<void>()
      await page.route(
        url,
        async (route) => {
          await pending.promise
          await route.continue()
        },
        { times: 1 },
      )
      try {
        await expect(send).toBeEnabled()
        await submit()
        await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click()
        await taskCard.click()
        await expect(detail.getByText('正在发送…', { exact: true })).toBeVisible()
        await expect(send).toBeDisabled()
      } finally {
        pending.resolve()
      }
    }
    await sendWhileReopening(
      detail.getByRole('button', { name: '发送指导', exact: true }),
      `**/api/runs/${running.run_id}/instruction`,
      () => input.press(provider === 'pi' ? 'Control+Enter' : 'Meta+Enter'),
    )
    await expect(input).toHaveValue('')
    await expect(
      detail.getByText('先补齐空目录的测试，再修改回退逻辑。', { exact: true }),
    ).toBeVisible()
    await expect(detail).toContainText('Agent 已接收')
    const after = await (await request.get(`/api/runs/${running.run_id}`)).json()
    expect(after.run.session_id).toBe(original.run.session_id)
    expect(after.run.attempt_id).toBe(original.run.attempt_id)
    expect(after.run.state).toBe('running')
    const guidance = after.command_acks.find((ack: { instruction?: string }) => ack.instruction)
    expect(guidance.state).toBe('COMMAND_ACK_STATE_APPLIED')
    expect(
      (
        await request.post(`/api/runs/${running.run_id}/instruction`, {
          data: {
            attempt_id: after.run.attempt_id,
            command_id: guidance.commandId,
            instruction: guidance.instruction,
          },
        })
      ).ok(),
    ).toBeTruthy()
    if (provider === 'pi') {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(250)
        await expect
          .poll(() =>
            input.evaluate((element) => element.getBoundingClientRect().bottom < innerHeight),
          )
          .toBe(true)
        await expect
          .poll(() => detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
          .toBe(true)
        await page.screenshot({
          path: `test-results/task-session-${width}.png`,
          animations: 'disabled',
          fullPage: true,
        })
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await input.fill('刷新时清空的草稿')
    const reloadDialogs: string[] = []
    page.once('dialog', async (dialog) => {
      reloadDialogs.push(dialog.type())
      await dialog.accept()
    })
    await page.reload()
    expect(reloadDialogs).toEqual([])
    await expect(detail.getByRole('tab', { name: 'Agent 会话', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(detail).toContainText('Agent 已接收')
    await expect(input).toHaveValue('')
    await input.fill('reject-guidance')
    const steer = detail.getByRole('button', { name: '发送指导', exact: true })
    await expect(steer).toBeEnabled()
    await steer.click()
    await expect(detail.getByRole('alert')).toContainText('Agent 未接收指导')
    await expect(input).toHaveValue('reject-guidance')
    await input.press('Enter')
    await expect(detail.getByText('已排队，本轮执行结束后发送')).toBeVisible()
    await detail.getByRole('button', { name: '撤回', exact: true }).click()
    await expect(input).toHaveValue('reject-guidance')
    await input.fill('停止以后还能继续讨论吗？')
    await input.press('Enter')
    await expect(detail.getByText('已排队，本轮执行结束后发送')).toBeVisible()
    await expect(input).toHaveValue('')
    const checkHistory = async () =>
      (
        await (
          await request.get(`/api/agents/${provider}/history?session_id=${original.run.session_id}`)
        ).json()
      ).runs
    expect(await checkHistory()).toHaveLength(1)
    const queuedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/tasks/${task.id}/chat`) &&
        response.request().method() === 'POST',
    )
    await detail.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(detail.getByRole('button', { name: '开始任务', exact: true })).toBeEnabled()
    await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    await expect(detail).toHaveCount(0)
    expect((await queuedResponse).ok()).toBeTruthy()
    await taskCard.click()
    await expect(detail.getByText('Hello 2', { exact: true })).toBeVisible()
    expect(await checkHistory()).toHaveLength(2)
    await expect(detail).toContainText('Agent 已接收')
    const stopped = (await (await request.get('/api/workflow')).json()).tasks.find(
      (item: { id: string }) => item.id === task.id,
    )
    expect(stopped).toMatchObject({ status: 'todo', paused: true, last_run_id: running.run_id })
    expect(errors).toEqual([])
  })
}

for (const terminal of ['completed', 'failed']) {
  test(`task chat resumes a ${terminal} session without changing the task`, async ({
    page,
    request,
  }) => {
    const provider = terminal === 'completed' ? 'pi' : 'codex'
    const { agents } = await (await request.get('/api/agents')).json()
    const agentDirectory = agents.find(
      (agent: { name: string }) => agent.name === provider,
    ).directory
    const requirement = { id: randomUUID(), title: `续聊 ${terminal}`, description: '' }
    const directory = join(dirname(agentDirectory), requirement.id)
    mkdirSync(directory)
    const project = {
      id: randomUUID(),
      name: `任务续聊 ${terminal}`,
      description: '',
      directories: [directory, agentDirectory],
      preferred_directory: directory,
      requirements: [requirement],
    }
    expect(
      (await request.post('/api/projects', { data: { project, previous: null } })).ok(),
    ).toBeTruthy()
    await request.post('/api/workflow/settings', {
      data: { coding_agents: [provider], automatic: false },
    })
    const title = '检查保存配置'
    const { task } = await (
      await request.post('/api/tasks', {
        data: {
          requirement_id: requirement.id,
          title,
          description: '验证保存配置。',
          role: 'coding',
        },
      })
    ).json()
    if (terminal === 'failed')
      writeFileSync(join(dirname(directory), 'tasks', task.directory, 'crash-execution'), '')
    await page.goto('/')
    await page.getByRole('textbox', { name: '搜索项目和需求', exact: true }).fill(project.name)
    await page.getByRole('button', { name: requirement.title, exact: true }).click()
    await page.getByRole('button', { name: `打开任务 ${title}`, exact: true }).click()
    const detail = page.getByRole('region', { name: '任务详情', exact: true })
    await detail.getByRole('tab', { name: 'Agent 会话', exact: true }).click()
    await detail.getByRole('button', { name: '开始任务', exact: true }).click()
    async function taskState() {
      return (await (await request.get('/api/workflow')).json()).tasks.find(
        (item: { id: string }) => item.id === task.id,
      )
    }
    await expect.poll(async () => (await taskState()).execution_state).toBe(terminal)
    const before = await taskState()
    expect(before).toMatchObject({
      status: terminal === 'completed' ? 'done' : 'todo',
      paused: terminal === 'failed',
      run_id: null,
    })
    const original = (await (await request.get(`/api/runs/${before.last_run_id}`)).json()).run
    const changed = { ...project, preferred_directory: agentDirectory }
    expect(
      (await request.post('/api/projects', { data: { project: changed, previous: project } })).ok(),
    ).toBeTruthy()
    const input = detail.getByRole('textbox', { name: '给任务 Agent 发消息', exact: true })
    await input.fill('请说明刚才发生了什么。')
    await detail.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(detail.getByText('Hello 2', { exact: true })).toBeVisible()
    const history = await (
      await request.get(`/api/agents/${provider}/history?session_id=${original.session_id}`)
    ).json()
    expect(history.runs).toHaveLength(2)
    expect(history.runs[0].run).toMatchObject({
      session_id: original.session_id,
      native_session_id: original.native_session_id,
      working_directory: original.working_directory,
    })
    expect(history.runs[0].run.run_id).not.toBe(original.run_id)
    expect(await taskState()).toEqual(before)
    await page.reload()
    await expect(detail.getByText('请说明刚才发生了什么。', { exact: true })).toBeVisible()
    await expect(detail.getByText('Hello 2', { exact: true })).toBeVisible()
    await expect(input).toBeEnabled()
    if (terminal === 'completed') {
      const completion = page.locator('[data-task-message="completed"]').filter({
        hasText: `已完成「${title}」`,
      })
      await expect(completion.locator('.message-bubble')).not.toContainText('验证证据')
      await input.fill('slow')
      await detail.getByRole('button', { name: '发送消息', exact: true }).click()
      const stopReply = detail.getByRole('button', { name: '停止回复', exact: true })
      await expect(stopReply).toBeEnabled()
      expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBe(false)
      await stopReply.click()
      await expect(stopReply).toHaveCount(0)
      await expect(input).toBeEnabled()
      expect(await taskState()).toEqual(before)
      await page.route('**/api/agents/pi/history?**', async (route) => {
        const response = await route.fetch()
        const data = await response.json()
        const record = data.runs.find(
          (item: { run: { run_id: string } }) => item.run.run_id === original.run_id,
        )
        if (record) {
          record.events.push({
            sequence: record.run.last_sequence + 1,
            event: {
              type: 'tool',
              call_id: 'artifact',
              name: 'edit',
              input: { path: `${original.working_directory}/src/config.ts` },
              output: {
                details: {
                  diff: '-4 old\n+4 new',
                  patch:
                    '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -4 +4,2 @@\n-old\n+new\n+extra',
                },
              },
              complete: true,
            },
          })
        }
        await route.fulfill({ response, json: data })
      })
      await detail.getByRole('tab', { name: 'Handoff', exact: true }).click()
      const handoff = detail.getByRole('tabpanel', { name: 'Handoff' })
      const handoffToggle = handoff.getByRole('button', { name: 'Coding Handoff · pi' })
      await expect(handoffToggle.locator('svg.lucide-hand-helping')).toBeVisible()
      await expect(handoffToggle).toHaveAttribute('aria-expanded', 'false')
      await handoffToggle.press('Enter')
      await expect(handoffToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(handoff.locator('.sdd-markdown')).toContainText('本次按照任务范围完成实现检查')
      await expect(page.getByRole('dialog', { name: /Task Handoff/ })).toHaveCount(0)
      await handoffToggle.press('Space')
      await expect(handoffToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(handoff.locator('.sdd-markdown')).toHaveCount(0)
      await detail.getByRole('tab', { name: '产物', exact: true }).click()
      const panel = detail.getByRole('tabpanel', { name: '产物' })
      await expect(panel.getByText('src/config.ts', { exact: true })).toBeVisible()
      await expect(panel.locator('svg.lucide-file-code')).toBeVisible()
      await expect(panel.locator('.hub-count-add')).toHaveText('+2')
      await expect(panel.locator('.hub-count-delete')).toHaveText('-1')
      await expect(input).toHaveCount(0)
      await page.reload()
      await expect(detail.getByRole('tab', { name: '产物', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await expect(panel.getByText('src/config.ts', { exact: true })).toBeVisible()
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(250)
        for (const [tab, glyph] of [
          ['产物', 'files'],
          ['Handoff', 'hand-helping'],
        ]) {
          const tabButton = detail.getByRole('tab', { name: tab, exact: true })
          await tabButton.click()
          await expect(tabButton.locator(`svg.lucide-${glyph}`)).toBeVisible()
          if (tab === 'Handoff') {
            await handoffToggle.click()
            await expect(handoff.locator('.sdd-markdown')).toBeVisible()
          }
          await expect
            .poll(() =>
              detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            )
            .toBe(true)
          await page.screenshot({
            path: `test-results/task-outputs-${tab === '产物' ? 'artifacts' : 'handoff'}-${width}.png`,
            animations: 'disabled',
            fullPage: true,
          })
        }
      }
      await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
      await page.setViewportSize({ width: 1440, height: 900 })
      const previewLink = completion.getByRole('button', { name: /Coding Handoff/ })
      await expect(previewLink.locator('svg.lucide-hand-helping')).toBeVisible()
      await previewLink.click()
      const preview = page.getByRole('dialog', { name: `Task Handoff · ${title}` })
      await expect(preview.locator('svg.lucide-hand-helping')).toBeVisible()
      await expect(preview.locator('.sdd-markdown')).toContainText('本次按照任务范围完成实现检查')
    }
  })
}
