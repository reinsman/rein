import { test, expect } from '@playwright/test'

test('Agent skills default to Rein with empty extras and retain native compatibility', async ({
  page,
  request,
}) => {
  const { agents } = await (await request.get('/api/agents')).json()
  const { skills: _skills, ...base } = agents.find(
    (agent: { name: string }) => agent.name === 'codex',
  )
  expect(
    (await request.post('/api/agents', { data: { ...base, name: 'skill-source-helper' } })).ok(),
  ).toBeTruthy()
  const status = await (await request.get('/api/agents/skill-source-helper/skills')).json()
  await page.goto('/')
  await page.getByRole('button', { name: 'skill-source-helper设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent 设置 · skill-source-helper' })
  await dialog.getByRole('button', { name: 'SKILL 配置', exact: true }).click()
  const source = dialog.getByRole('combobox', { name: '默认技能来源', exact: true })
  const extra = dialog.getByRole('textbox', { name: '技能目录', exact: true })
  const sourceGroup = dialog.getByRole('region', { name: '默认技能来源', exact: true })
  const discovered = dialog.getByRole('region', { name: '已发现的技能', exact: true })
  await expect(sourceGroup.getByText('默认技能目录', { exact: true })).toBeVisible()
  await expect(discovered.getByRole('button', { name: '刷新技能', exact: true })).toBeVisible()
  await expect(source).toHaveValue('rein')
  await expect(extra).toHaveValue('')
  await expect(dialog.locator('.skill-default-path')).toHaveText(
    status.source_path.replace(/\/rein-spec$/, ''),
  )
  await expect(dialog).toContainText(
    '安装到原生用户技能目录，同一配置目录的其他 Agent 也可发现；不覆盖已有文件。',
  )
  await expect(
    discovered.getByRole('switch', { name: '启用技能 rein-spec', exact: true }),
  ).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(250)
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true)
    await page.screenshot({
      path: `test-results/skill-source-${width}.png`,
      animations: 'disabled',
    })
  }
  await source.selectOption('native')
  await expect(dialog.locator('.skill-default-path')).toHaveText(
    status.install_path.replace(/\/rein-spec$/, ''),
  )
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(dialog).toBeHidden()
  const saved = (await (await request.get('/api/agents')).json()).agents.find(
    (agent: { name: string }) => agent.name === 'skill-source-helper',
  )
  expect(saved.skill_source).toBe('native')
  expect(saved.skill_directories ?? []).toEqual([])
  await page.reload()
  if (await page.getByRole('button', { name: '展开侧栏', exact: true }).isVisible())
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await page.getByRole('button', { name: 'skill-source-helper设置', exact: true }).click()
  await dialog.getByRole('button', { name: 'SKILL 配置', exact: true }).click()
  await expect(source).toHaveValue('native')
  await expect(extra).toHaveValue('')
})
