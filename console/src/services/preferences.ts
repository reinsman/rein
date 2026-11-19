import type { ChatScope } from '../types'

export interface NavigationState {
  scope: ChatScope
  currentProjectId?: string
  currentRequirementId?: string
  selectedTask: string | null
  expanded: boolean
  mobilePanel: 'chat' | 'tasks'
}

export const defaultPreferences = {
  appearance: '浅色',
  language: '简体中文',
  fontSize: '13 px · 紧凑',
  sendMode: 'Enter 发送',
  concurrency: '3 个任务',
  background: true,
  isolation: true,
  replyNotification: true,
  doneNotification: true,
  errorNotification: true,
  sound: false,
  retention: '30 天',
}
export type Preferences = typeof defaultPreferences
const storage = {
  read(key: string): unknown {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      return null
    }
  },
  write(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  },
}
export const preferencesService = {
  navigation(): NavigationState | null {
    const saved = storage.read('rein.navigation') as Partial<NavigationState> | null
    const scope = saved?.scope
    if (
      !scope ||
      typeof scope.id !== 'string' ||
      typeof scope.title !== 'string' ||
      typeof scope.label !== 'string'
    )
      return null
    const restored: ChatScope = { id: scope.id, title: scope.title, label: scope.label }
    for (const key of ['specId', 'agentId', 'projectId', 'requirementId'] as const) {
      if (typeof scope[key] === 'string') restored[key] = scope[key]
    }
    return {
      scope: restored,
      currentProjectId:
        typeof saved?.currentProjectId === 'string' ? saved.currentProjectId : undefined,
      currentRequirementId:
        typeof saved?.currentRequirementId === 'string' ? saved.currentRequirementId : undefined,
      selectedTask: typeof saved?.selectedTask === 'string' ? saved.selectedTask : null,
      expanded: saved?.expanded === true,
      mobilePanel: saved?.mobilePanel === 'tasks' ? 'tasks' : 'chat',
    }
  },
  setNavigation(value: NavigationState) {
    storage.write('rein.navigation', value)
  },
  specView(id: string): { phase: string; tab: number } | null {
    const value = storage.read(`rein.spec-view.${id}`) as {
      phase?: unknown
      tab?: unknown
    } | null
    return value &&
      typeof value.phase === 'string' &&
      typeof value.tab === 'number' &&
      Number.isInteger(value.tab) &&
      value.tab >= 0 &&
      value.tab <= 3
      ? { phase: value.phase, tab: value.tab }
      : null
  },
  setSpecView(id: string, value: { phase: string; tab: number }) {
    storage.write(`rein.spec-view.${id}`, value)
  },
  taskTab(id: string): number | null {
    const value = storage.read(`rein.task-tab.${id}`)
    return value === 0 || value === 1 || value === 2 || value === 3 ? value : null
  },
  setTaskTab(id: string, value: number) {
    storage.write(`rein.task-tab.${id}`, value)
  },
  readNodeNotices(): Set<string> {
    const value = storage.read('rein.read-node-notices')
    return new Set(Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [])
  },
  saveNodeNotices(keys: ReadonlySet<string>) {
    storage.write('rein.read-node-notices', [...keys])
  },
  load(): Preferences {
    const saved = storage.read('rein.preferences') as Partial<Preferences> | null
    const result = { ...defaultPreferences }
    if (saved && typeof saved === 'object')
      for (const key of Object.keys(result) as (keyof Preferences)[]) {
        if (typeof saved[key] === typeof result[key]) Object.assign(result, { [key]: saved[key] })
      }
    return result
  },
  save(value: Preferences) {
    return storage.write('rein.preferences', value)
  },
  sidebar(): boolean {
    return storage.read('rein.sidebar') !== false
  },
  setSidebar(value: boolean) {
    storage.write('rein.sidebar', value)
  },
  split(): number {
    const v = storage.read('rein.split')
    return typeof v === 'number' && v > 0 && v < 1 ? v : 624 / 1304
  },
  setSplit(value: number) {
    storage.write('rein.split', value)
  },
  detailRatio(): number | null {
    const value = storage.read('rein.detailRatio')
    return typeof value === 'number' && value > 0 && value <= 1 ? value : null
  },
  setDetailRatio(value: number) {
    storage.write('rein.detailRatio', value)
  },
}
