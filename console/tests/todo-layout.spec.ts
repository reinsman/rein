import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('Todo settles after resizing across stacked layout breakpoints', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const project = {
    id: randomUUID(),
    name: 'Todo 窄栏稳定性',
    description: '',
    directories: [],
    preferred_directory: null,
    requirements: [{ id: randomUUID(), title: '窄栏布局需求', description: '' }],
  }
  expect((await request.post('/api/projects', { data: { project } })).ok()).toBeTruthy()
  for (let i = 0; i < 6; i++)
    expect(
      (
        await request.post('/api/tasks', {
          data: {
            requirement_id: project.requirements[0].id,
            title: `任务 ${i}：缩小窗口时保留完整的长标题并自动换行，不能反复刷新布局`,
            role: 'coding',
          },
        })
      ).ok(),
    ).toBeTruthy()
  await page.goto('/')
  await page.getByRole('button', { name: `展开项目 ${project.name}`, exact: true }).click()
  await page.getByRole('button', { name: project.requirements[0].title, exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(6)
  for (const width of [1600, 1400, 1200, 1199, 1100, 1000, 900, 899, 600, 390, 1600]) {
    await page.setViewportSize({ width, height: 700 })
    if (width < 900) await page.getByRole('button', { name: '任务', exact: true }).click()
    const samples = await page.locator('.task-groups').evaluate(async (board) => {
      const result = []
      for (let i = 0; i < 15; i++) {
        await new Promise(requestAnimationFrame)
        const svg = board.querySelector('svg.task-dependencies')!
        result.push([
          board.clientWidth,
          board.clientHeight,
          board.scrollWidth,
          board.scrollHeight,
          svg.getAttribute('width'),
          svg.getAttribute('height'),
        ])
      }
      return result
    })
    expect(samples.at(-1)).toEqual(samples.at(-5))
    const last = samples.at(-1)!
    expect(last[2]).toBe(last[0])
    expect(last[3]).toBe(last[1])
    if (width === 1200 || width === 390)
      await page.screenshot({ path: `test-results/todo-layout-${width}.png`, animations: 'disabled' })
  }
  expect(errors).toEqual([])
})
