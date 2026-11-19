import { test, expect } from '@playwright/test'

test('completed runs expose file diffs outside the collapsed process, including saved history', async ({
  page,
}) => {
  const path = 'src/' + 'long-directory/'.repeat(12) + 'config.ts'
  const workspace = '/projects/rein'
  const tools = [
    {
      call_id: 'codex',
      name: 'fileChange',
      input: {
        changes: [
          {
            path: `${workspace}/${path}`,
            kind: { type: 'update' },
            diff: '--- a/config.ts\n+++ b/config.ts\n@@ -9,2 +19,3 @@\n keep\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -41 +52 @@\n-old2\n+change2',
          },
        ],
      },
      complete: false,
    },
    {
      call_id: 'codex',
      name: 'fileChange',
      complete: true,
    },
    { call_id: 'edit', name: 'edit', input: { path }, complete: false },
    {
      call_id: 'edit',
      name: 'edit',
      output: { details: { diff: '-  7 new\n+  7 newer\n+  8 next\n   8 same' } },
      complete: true,
    },
    {
      call_id: 'write',
      name: 'write',
      input: {
        path: 'notes.md',
        content: '<script>alert("plain text")</script>\n' + 'long line '.repeat(100),
      },
      complete: true,
    },
    {
      call_id: 'add',
      name: 'fileChange',
      input: {
        changes: [{ path: 'added.JSON', kind: { type: 'add' }, diff: 'hello\n--- data\n' }],
      },
      complete: true,
    },
    {
      call_id: 'delete',
      name: 'fileChange',
      input: { changes: [{ path: 'removed.png', kind: { type: 'delete' }, diff: 'goodbye\n' }] },
      complete: true,
    },
    {
      call_id: 'rename',
      name: 'fileChange',
      input: {
        changes: [
          {
            path: 'before.ts',
            kind: { type: 'update', move_path: `${workspace}/after.ts` },
            diff: '',
          },
        ],
      },
      complete: true,
    },
    {
      call_id: 'extra',
      name: 'fileChange',
      input: {
        changes: [
          { path: `${workspace}/src/extra.tar.gz`, kind: 'add', diff: 'extra' },
          { path: `${workspace}-other/outside`, kind: 'delete', diff: 'outside' },
        ],
      },
      complete: true,
    },
    {
      call_id: 'failed',
      name: 'fileChange',
      input: { changes: [{ path: 'failed.ts', diff: '+failed' }] },
      complete: true,
      is_error: true,
    },
    {
      call_id: 'pending',
      name: 'fileChange',
      input: { changes: [{ path: 'pending.ts', diff: '+pending' }] },
      complete: false,
    },
    {
      call_id: 'malformed',
      name: 'fileChange',
      input: { changes: [null, { path: 123, diff: '+invalid' }] },
      complete: true,
    },
    { call_id: 'read', name: 'read', input: { path: 'read-only.ts' }, complete: true },
  ]
  const events = tools.map((tool, index) => ({
    sequence: index + 1,
    event: { type: 'tool', ...tool },
  }))
  await page.route('**/api/agents/codex/history?**', (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            run: {
              run_id: 'changes',
              attempt_id: 'attempt',
              session_id: 'changes',
              state: 'completed',
              working_directory: workspace,
              cancel_requested: false,
              last_sequence: events.length + 1,
            },
            agent_id: 'codex',
            prompt: '更新文件',
            created_at: new Date().toISOString(),
            version: '1',
            events: [
              ...events,
              {
                sequence: events.length + 1,
                event: { type: 'text', item_id: 'answer', text: '修改完成。', complete: true },
              },
            ],
            command_acks: [],
          },
        ],
        sessions: [{ id: 'changes', prompt: '更新文件' }],
        session_id: 'changes',
        next_cursor: '',
        stream_cursor: '0',
      },
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: '与codex对话', exact: true }).click()
  const changes = page.getByRole('region', { name: '文件变更', exact: true })
  await expect(changes.getByRole('heading')).toHaveText('文件变更 · 7 个文件')
  await expect(changes.locator('details')).toHaveCount(5)
  const more = changes.getByRole('button', { name: '显示剩余 2 个' })
  await more.click()
  await expect(changes.locator('details')).toHaveCount(7)
  for (const [filename, glyph] of [
    [path, 'file-code'],
    ['notes.md', 'file-text'],
    ['added.JSON', 'file-braces-corner'],
    ['removed.png', 'file-image'],
    ['src/extra.tar.gz', 'file-archive'],
    [`${workspace}-other/outside`, 'file'],
  ]) {
    const row = changes.getByText(filename, { exact: true }).locator('..')
    await expect(row.locator(`svg.lucide-${glyph}`)).toBeVisible()
  }
  const collapse = changes.getByRole('button', { name: '收起', exact: true })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await expect(changes.locator(':scope > :last-child')).toHaveText('收起')
  await collapse.click()
  await expect(changes.locator('details')).toHaveCount(5)
  await expect(page.locator('.hub-final-answer')).toHaveText('修改完成。')
  await expect(page.locator('.hub-progress')).not.toHaveAttribute('open')
  const file = changes
    .locator('details')
    .filter({ has: page.locator('.hub-file-path', { hasText: path }) })
  await expect(file.locator('.hub-file-path')).toHaveText(path)
  await expect(file.locator('.hub-count-add')).toHaveText('+5')
  await expect(file.locator('.hub-count-delete')).toHaveText('-3')
  await file.locator('summary').click()
  await expect(file.locator('pre')).toHaveCount(2)
  const removed = file.locator('.hub-diff-delete').first()
  await expect(removed.locator('.hub-line-text')).toHaveText('-old')
  await expect(removed.locator('.hub-line-number')).toHaveText(['10', ''])
  const added = file.locator('.hub-diff-add').last()
  await expect(added.locator('.hub-line-text')).toHaveText('+next')
  await expect(added.locator('.hub-line-number')).toHaveText(['', '8'])
  await expect(file.locator('.hub-diff-hunk').last()).toHaveText('@@ -41 +52 @@')
  await expect(
    file
      .locator('pre')
      .first()
      .getByText('+change2', { exact: true })
      .locator('..')
      .locator('.hub-line-number'),
  ).toHaveText(['', '52'])
  await expect(
    file
      .locator('pre')
      .last()
      .getByText('same', { exact: true })
      .locator('..')
      .locator('.hub-line-number'),
  ).toHaveText(['8', '9'])
  const write = changes.locator('details').filter({ hasText: 'notes.md' })
  await write.locator('summary').click()
  await expect(write).toContainText('写入内容（未记录原内容）')
  await expect(write.locator('pre')).toContainText('<script>alert("plain text")</script>')
  await expect(write.locator('.hub-diff-add, script')).toHaveCount(0)
  for (const [name, label] of [
    ['added.JSON', '新增'],
    ['removed.png', '删除'],
    ['before.ts', '重命名 → after.ts'],
  ]) {
    const entry = changes
      .locator('details')
      .filter({ has: page.locator('.hub-file-path', { hasText: name }) })
    await entry.locator('summary').click()
    await expect(entry.locator('.hub-change-label').first()).toHaveText(label)
    if (label === '新增') {
      await expect(entry.locator('.hub-diff-add .hub-line-text')).toHaveText([
        '+hello',
        '+--- data',
      ])
      await expect(entry.locator('.hub-count-add')).toHaveText('+2')
      await expect(entry.locator('.hub-count-delete')).toHaveText('-0')
    }
    if (label === '删除')
      await expect(entry.locator('.hub-diff-delete .hub-line-text')).toHaveText('-goodbye')
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(() =>
        changes.evaluate((element) =>
          Array.from(element.querySelectorAll<HTMLElement>('.hub-file-change, summary, pre'))
            .filter(
              (item) =>
                item.getBoundingClientRect().right > element.getBoundingClientRect().right + 1,
            )
            .map((item) => ({
              tag: item.tagName,
              width: item.clientWidth,
              parent: element.clientWidth,
            })),
        ),
      )
      .toEqual([])
    await write.locator('pre').focus()
    await expect(write.locator('pre')).toBeFocused()
    await page.waitForTimeout(250)
    await page.screenshot({
      path: `test-results/run-changes-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    })
  }
  await page.reload()
  await expect(changes.getByRole('heading')).toHaveText('文件变更 · 7 个文件')
  await expect(changes.locator('details')).toHaveCount(5)
})

test('runs without successful file changes do not show a change section', async ({ page }) => {
  await page.route('**/api/agents/pi/history?**', (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            run: {
              run_id: 'read',
              attempt_id: 'attempt',
              session_id: 'read',
              state: 'completed',
              cancel_requested: false,
              last_sequence: 1,
            },
            agent_id: 'pi',
            prompt: '只读检查',
            created_at: new Date().toISOString(),
            version: '1',
            events: [
              {
                sequence: 1,
                event: {
                  type: 'tool',
                  call_id: 'read',
                  name: 'read',
                  input: { path: 'README.md' },
                  complete: true,
                },
              },
            ],
            command_acks: [],
          },
        ],
        sessions: [{ id: 'read', prompt: '只读检查' }],
        session_id: 'read',
        next_cursor: '',
        stream_cursor: '0',
      },
    }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: '与pi对话', exact: true }).click()
  await expect(page.locator('.hub-duration, .hub-progress')).toBeVisible()
  await expect(page.getByRole('region', { name: '文件变更', exact: true })).toHaveCount(0)
})
