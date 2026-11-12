export const defaultPreferences = {
  appearance: '浅色',
  language: '简体中文',
  fontSize: '13 px · 紧凑',
  sendMode: 'Enter 发送',
  model: '跟随 Agent 配置',
  concurrency: '3 个任务',
  background: true,
  isolation: true,
  terminal: 'JetBrains Mono · 12 px',
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
