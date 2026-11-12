import { useId, useEffect, useState, type RefObject } from 'react'
import type { Task } from '../types'

type Rect = { left: number; top: number; right: number; bottom: number }
type Point = { x: number; y: number }

// Route through the spaces between cards, including after the board stacks.
function route(from: Rect, to: Rect, obstacles: Rect[]): string {
  const horizontal = from.right < to.left || to.right < from.left
  const forward = horizontal ? from.left < to.left : from.top < to.top
  const start = horizontal
    ? { x: forward ? from.right : from.left, y: (from.top + from.bottom) / 2 }
    : { x: (from.left + from.right) / 2, y: forward ? from.bottom : from.top }
  const end = horizontal
    ? { x: forward ? to.left : to.right, y: (to.top + to.bottom) / 2 }
    : { x: (to.left + to.right) / 2, y: forward ? to.top : to.bottom }
  const offset = forward ? 5 : -5
  const a = horizontal ? { ...start, x: start.x + offset } : { ...start, y: start.y + offset }
  const b = horizontal ? { ...end, x: end.x - offset } : { ...end, y: end.y - offset }
  const boxes = obstacles.map((r) => ({
    left: r.left - 4,
    right: r.right + 4,
    top: r.top - 4,
    bottom: r.bottom + 4,
  }))
  const xs = [...new Set([a.x, b.x, ...boxes.flatMap((r) => [r.left, r.right])])].sort(
    (x, y) => x - y,
  )
  const ys = [...new Set([a.y, b.y, ...boxes.flatMap((r) => [r.top, r.bottom])])].sort(
    (x, y) => x - y,
  )
  const key = (x: number, y: number) => y * xs.length + x
  const source = key(xs.indexOf(a.x), ys.indexOf(a.y))
  const target = key(xs.indexOf(b.x), ys.indexOf(b.y))
  const point = (id: number) => ({ x: xs[id % xs.length], y: ys[Math.floor(id / xs.length)] })
  const clear = (p: Point, q: Point) =>
    !boxes.some((r) =>
      p.x === q.x
        ? p.x > r.left &&
          p.x < r.right &&
          Math.max(p.y, q.y) > r.top &&
          Math.min(p.y, q.y) < r.bottom
        : p.y > r.top &&
          p.y < r.bottom &&
          Math.max(p.x, q.x) > r.left &&
          Math.min(p.x, q.x) < r.right,
    )
  const distances = new Map([[source, 0]])
  const previous = new Map<number, number>()
  const open = new Set([source])
  const heuristic = (id: number) => {
    const p = point(id)
    return Math.abs(p.x - b.x) + Math.abs(p.y - b.y)
  }
  while (open.size) {
    let current = -1,
      best = Infinity
    for (const id of open) {
      const score = distances.get(id)! + heuristic(id)
      if (score < best) {
        best = score
        current = id
      }
    }
    if (current === target) {
      const points: Point[] = [end, b]
      while (current !== source) {
        current = previous.get(current)!
        points.push(point(current))
      }
      points.push(start)
      return points
        .reverse()
        .map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`)
        .join(' ')
    }
    open.delete(current)
    const x = current % xs.length,
      y = Math.floor(current / xs.length),
      p = point(current)
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue
      const id = key(nx, ny),
        q = point(id)
      if (!clear(p, q)) continue
      const next = distances.get(current)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
      if (next >= (distances.get(id) ?? Infinity)) continue
      distances.set(id, next)
      previous.set(id, current)
      open.add(id)
    }
  }
  return ''
}

export function TaskDependencies({
  tasks,
  boardRef,
}: {
  tasks: Task[]
  boardRef: RefObject<HTMLDivElement | null>
}) {
  const [paths, setPaths] = useState<{ from: string; to: string; d: string }[]>([])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const markerId = useId()
  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    let frame = 0
    function measure() {
      if (!board) return
      const bounds = board.getBoundingClientRect()
      const rects = new Map<string, Rect>()
      board.querySelectorAll<HTMLElement>('[data-task-id]').forEach((el) => {
        const r = el.getBoundingClientRect()
        rects.set(el.dataset.taskId!, {
          left: r.left - bounds.left,
          right: r.right - bounds.left,
          top: r.top - bounds.top,
          bottom: r.bottom - bounds.top,
        })
      })
      const next: typeof paths = []
      for (const task of tasks)
        for (const id of task.dependsOn ?? []) {
          const from = rects.get(id),
            to = rects.get(task.id)
          if (from && to && id !== task.id) {
            const d = route(from, to, [...rects.values()])
            if (d) next.push({ from: id, to: task.id, d })
          }
        }
      setPaths(next)
      setSize({ width: board.clientWidth, height: board.scrollHeight })
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(board)
    board.querySelectorAll('[data-task-id]').forEach((el) => observer.observe(el))
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [tasks, boardRef])
  return (
    <svg
      className="task-dependencies"
      width={size.width}
      height={size.height}
      aria-label="任务先后依赖"
      role="group"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M 1 1 L 5 3 L 1 5" fill="none" stroke="currentColor" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={`${path.from}-${path.to}`}
          className="dependency-path"
          markerEnd={`url(#${markerId})`}
          d={path.d}
          data-from={path.from}
          data-to={path.to}
          role="img"
          aria-label={`${path.to} 依赖 ${path.from}`}
        >
          <title>
            {path.from} → {path.to}
          </title>
        </path>
      ))}
    </svg>
  )
}
