import { test, expect } from '@playwright/test'

test('system settings edit shared native config and keep orchestration separate', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '个人菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 配置', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Agent 配置', exact: true })
  const defaults = panel.getByRole('region', { name: '类型默认值' })
  const codex = panel.getByRole('textbox', { name: 'config.toml', exact: true })
  const save = panel.getByRole('button', { name: '保存配置', exact: true })
  const permissions = panel.getByRole('combobox', { name: '默认权限', exact: true })
  const loginNote = panel.getByRole('note', { name: 'Codex 登录说明' })
  await expect(loginNote).toContainText('首次使用需单独登录')
  await expect(permissions).toHaveValue('full_access')
  await expect(loginNote.locator('code')).toHaveText(
    /env CODEX_HOME='.+\/agents\/codex' codex login/,
  )
  await permissions.selectOption('read_only')
  await panel.getByRole('button', { name: '保存默认权限', exact: true }).click()
  await expect(permissions).toBeEnabled()
  await expect(permissions).toHaveValue('read_only')
  await expect(codex).toBeHidden()
  await panel.getByText('配置文件', { exact: true }).click()
  await expect(codex).toBeVisible()
  const original = await codex.inputValue()
  await codex.fill('malformed [')
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('invalid TOML')
  const changed = 'model = "fixture-shared-model"\nmodel_reasoning_effort = "medium"\n'
  await codex.fill(changed)
  await save.click()
  await expect(save).toBeDisabled()
  await expect(defaults).toContainText('fixture-shared-model')
  await expect(defaults).toContainText('medium')
  await expect
    .poll(async () => (await (await request.get('/api/agent-types/codex')).json()).files[0].content)
    .toBe(changed)
  const provider = panel.getByRole('combobox', { name: 'Agent 类型', exact: true })
  await provider.selectOption('pi')
  await expect(loginNote).toHaveCount(0)
  await expect(panel.getByText('原生完全访问', { exact: true })).toBeVisible()
  await expect(permissions).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'models.json', exact: true })).toBeVisible()
  await panel
    .getByRole('combobox', { name: '配置文件', exact: true })
    .selectOption({ label: 'settings.json' })
  await expect(panel.getByRole('textbox', { name: 'settings.json', exact: true })).toBeVisible()
  await provider.selectOption('codex')
  await expect(codex).toHaveValue(changed)
  await expect(permissions).toHaveValue('read_only')
  await panel.getByText('配置文件', { exact: true }).click()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(250)
    await expect
      .poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true)
    await page.screenshot({
      path: `test-results/agent-type-config-${width}.png`,
      animations: 'disabled',
    })
  }
  await page.getByRole('button', { name: 'Agents 编排', exact: true }).click()
  await expect(page.getByLabel('主 Agent', { exact: true })).toBeVisible()
  await expect(page.getByText('默认终端', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭配置', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'codex设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent 设置 · codex' })
  const access = dialog.getByRole('combobox', { name: '访问级别', exact: true })
  const openPermissions = () =>
    dialog.getByRole('button', { name: '权限配置', exact: true }).click()
  const saveAgent = () => dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await openPermissions()
  await expect(access).toHaveValue('')
  await expect(dialog.getByText('类型默认值 · 只读', { exact: true })).toBeVisible()
  await access.selectOption('full_access')
  await saveAgent()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'codex设置', exact: true }).click()
  await openPermissions()
  await expect(access).toHaveValue('full_access')
  await access.selectOption('')
  await saveAgent()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'codex设置', exact: true }).click()
  await openPermissions()
  await expect(access).toHaveValue('')
  await dialog.getByRole('button', { name: '模型与思考', exact: true }).click()
  await expect(dialog.getByText('类型默认值 · fixture-shared-model', { exact: true })).toBeVisible()
  await expect(dialog.getByText('类型默认值 · medium', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '模型覆盖' })).toHaveValue('')
  await expect(dialog.getByRole('combobox', { name: '思考强度' })).toHaveValue('')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(250)
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true)
    await page.screenshot({
      path: `test-results/agent-effective-settings-${width}.png`,
      animations: 'disabled',
    })
  }
  expect(
    (
      await request.put('/api/agent-types/codex/config.toml', {
        data: { previous: changed, content: original },
      })
    ).ok(),
  ).toBeTruthy()
  expect(
    (
      await request.put('/api/agent-types/codex/permissions', {
        data: { permissions: 'full_access' },
      })
    ).ok(),
  ).toBeTruthy()
})
