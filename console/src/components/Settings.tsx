import { useState } from 'react'
import {
  Button,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  ListItemButton,
  Select,
  TextField,
} from '@mui/material'
import type { ReactNode } from 'react'
import type { Preferences } from '../services/preferences'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'

const categories = [
  { name: '通用', icon: 'tune', description: '偏好设置适用于此设备。' },
  { name: '模型与连接', icon: 'flow', description: '管理本机 Agent 登录状态及可选的模型提供商。' },
  { name: '执行环境', icon: 'computer', description: '控制本机任务的运行方式与并发。' },
  { name: '通知', icon: 'notify', description: '选择希望收到提醒的任务事件。' },
  { name: '数据与隐私', icon: 'shield', description: '管理本机记录与 Agent 记忆。' },
]
export function Row({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="setting-row">
      <div>
        <label>{label}</label>
        <p>{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}
interface Props {
  open: boolean
  onClose: () => void
  value: Preferences
  onChange: (value: Preferences) => boolean
  notify: (text: string) => void
}
export function Settings({ open, onClose, value, onChange, notify }: Props) {
  const [category, setCategory] = useState(0)
  const [status, setStatus] = useState('更改自动保存')
  const [connection, setConnection] = useState<string | null>(null)
  const [connectionName, setConnectionName] = useState('')
  const [endpoint, setEndpoint] = useState('http://localhost:8080')
  const [connections, setConnections] = useState(['Codex', 'Claude Code', 'Pi'])
  function update<K extends keyof Preferences>(key: K, next: Preferences[K]) {
    const ok = onChange({ ...value, [key]: next })
    setStatus(ok ? '更改已保存到此设备' : '当前浏览器无法保存，设置仅本次有效')
    notify(ok ? '配置已保存' : '配置已应用，本地存储不可用')
  }
  function select(key: keyof Preferences, label: string, options: string[]) {
    return (
      <Select
        native
        value={String(value[key])}
        onChange={(e) => update(key, e.target.value as never)}
        inputProps={{ 'aria-label': label }}
        className="setting-select"
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </Select>
    )
  }
  function toggle(key: keyof Preferences, label: string) {
    return (
      <ButtonBase
        role="switch"
        aria-label={label}
        aria-checked={Boolean(value[key])}
        className="setting-switch"
        onClick={() => update(key, !value[key] as never)}
      >
        <img src={`/icons/switch-MuiSwitchSmall${value[key] ? 'On' : 'Off'}.svg`} alt="" />
      </ButtonBase>
    )
  }
  async function exportData() {
    const blob = new Blob([await reinService.exportData()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rein-demo-data.json'
    a.click()
    URL.revokeObjectURL(url)
    notify('模拟数据已导出')
  }
  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth={false}
        className="settings-dialog"
        slotProps={{
          paper: {
            sx: {
              width: 1040,
              maxWidth: 'calc(100vw - 32px)',
              height: 720,
              maxHeight: 'calc(100dvh - 32px)',
              margin: 2,
            },
          },
        }}
      >
        <DialogTitle className="settings-title">
          配置
          <Action label="关闭配置" icon="close" onClick={onClose} />
        </DialogTitle>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="配置分类">
            {categories.map((item, i) => (
              <ListItemButton
                selected={category === i}
                key={item.name}
                onClick={() => setCategory(i)}
              >
                <Icon name={item.icon} />
                {item.name}
              </ListItemButton>
            ))}
            <span className="spacer" />
            <small>Rein · 本机配置</small>
          </nav>
          <section className="settings-content" aria-label={categories[category].name}>
            <h2>{categories[category].name}</h2>
            <p className="settings-description">{categories[category].description}</p>
            <div className="settings-fields">
              {category === 0 && (
                <>
                  <Row label="外观" description="选择界面配色。">
                    {select('appearance', '外观', ['浅色'])}
                  </Row>
                  <Row label="语言" description="界面显示语言。">
                    {select('language', '语言', ['简体中文'])}
                  </Row>
                  <Row label="界面字号" description="适合开发人员的紧凑排版。">
                    {select('fontSize', '界面字号', ['13 px · 紧凑', '14 px · 标准'])}
                  </Row>
                  <Row label="发送消息" description="Shift + Enter 始终换行。">
                    {select('sendMode', '发送消息方式', ['Enter 发送', 'Ctrl / ⌘ + Enter 发送'])}
                  </Row>
                </>
              )}
              {category === 1 && (
                <>
                  <Row label="默认模型" description="未单独指定时使用 Agent 自身配置。">
                    {select('model', '默认模型', ['跟随 Agent 配置', 'Codex', 'Claude Code', 'Pi'])}
                  </Row>
                  {connections.map((name) => (
                    <Row key={name} label={name} description="本机 CLI · 演示状态">
                      <div className="connection-actions">
                        <span className="connected">
                          <span className="status-dot done" />
                          模拟连接
                        </span>
                        <Button
                          variant="outlined"
                          onClick={() => {
                            setConnection(name)
                            setConnectionName(name)
                          }}
                        >
                          管理
                        </Button>
                      </div>
                    </Row>
                  ))}
                  <Row
                    label="其他模型提供商"
                    description="按需配置 API 连接，不影响已有 CLI 登录。"
                  >
                    <Button
                      variant="outlined"
                      onClick={() => {
                        setConnection('new')
                        setConnectionName('')
                      }}
                    >
                      添加连接
                    </Button>
                  </Row>
                </>
              )}
              {category === 2 && (
                <>
                  <Row label="执行器" description="本机后台运行服务。">
                    <span className="muted">模拟状态 · Local</span>
                  </Row>
                  <Row label="最大并发任务" description="同时执行的任务数上限。">
                    {select('concurrency', '最大并发任务', [
                      '1 个任务',
                      '2 个任务',
                      '3 个任务',
                      '5 个任务',
                    ])}
                  </Row>
                  <Row label="关闭页面后继续运行" description="后台运行偏好，接入执行服务后生效。">
                    {toggle('background', '关闭页面后继续运行')}
                  </Row>
                  <Row label="隔离任务工作目录" description="代码任务使用独立工作目录。">
                    {toggle('isolation', '隔离任务工作目录')}
                  </Row>
                  <Row label="默认终端" description="用于显示 Agent CLI 的字体。">
                    {select('terminal', '默认终端', [
                      'JetBrains Mono · 12 px',
                      'JetBrains Mono · 13 px',
                    ])}
                  </Row>
                </>
              )}
              {category === 3 && (
                <>
                  <Row label="需要你回复" description="Agent 等待确认或补充信息时提醒。">
                    {toggle('replyNotification', '需要你回复')}
                  </Row>
                  <Row label="任务完成" description="任务执行结束并可查看结果时提醒。">
                    {toggle('doneNotification', '任务完成')}
                  </Row>
                  <Row label="任务异常" description="失败或意外中断时提醒。">
                    {toggle('errorNotification', '任务异常')}
                  </Row>
                  <Row label="提示音" description="通知到达时播放声音。">
                    {toggle('sound', '提示音')}
                  </Row>
                  <Row label="浏览器通知" description="通知偏好将在接入任务服务后生效。">
                    <Button
                      variant="outlined"
                      onClick={() => notify('已模拟允许桌面通知，未请求浏览器权限')}
                    >
                      允许桌面通知
                    </Button>
                  </Row>
                </>
              )}
              {category === 4 && (
                <>
                  <Row label="操作日志保留时间" description="保留 Agent 的执行记录，便于回溯。">
                    {select('retention', '操作日志保留时间', ['7 天', '30 天', '90 天'])}
                  </Row>
                  <Row label="导出数据" description="导出当前演示的任务、会话和聊天记录。">
                    <Button variant="outlined" onClick={() => void exportData()}>
                      导出
                    </Button>
                  </Row>
                  <Row label="本地数据目录" description="查看日志与会话记录的保存位置。">
                    <Button
                      variant="outlined"
                      onClick={() => notify('本演示数据存放于浏览器内存中，没有本地文件目录')}
                    >
                      打开目录
                    </Button>
                  </Row>
                  <Row label="缓存" description="重置本次演示的模拟数据，保留界面偏好。">
                    <Button
                      variant="outlined"
                      onClick={async () => {
                        await reinService.reset()
                        notify('模拟数据已重置，界面偏好已保留')
                      }}
                    >
                      清理缓存
                    </Button>
                  </Row>
                </>
              )}
            </div>
            <div className="settings-status" role="status">
              <Icon name="save" size={14} />
              <span>{category === 1 ? '连接状态为前端模拟，未连接本机服务' : status}</span>
            </div>
          </section>
        </div>
      </Dialog>
      <Dialog open={!!connection} onClose={() => setConnection(null)} fullWidth maxWidth="xs">
        <DialogTitle className="dialog-title">
          {connection === 'new' ? '添加模拟连接' : `管理 ${connection}`}
          <Action label="关闭连接配置" icon="close" onClick={() => setConnection(null)} />
        </DialogTitle>
        <DialogContent>
          <form
            className="connection-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (connection === 'new') setConnections((prev) => [...prev, connectionName])
              setConnection(null)
              notify('模拟连接已保存，仅本次演示有效')
            }}
          >
            <p className="muted">仅演示配置流程，不收集密钥，也不会发起真实连接。</p>
            <TextField
              label="连接名称"
              required
              value={connectionName}
              onChange={(e) => setConnectionName(e.target.value)}
            />
            <TextField
              label="服务地址"
              type="url"
              required
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <Button type="submit" variant="contained" disabled={!connectionName.trim()}>
              保存模拟配置
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
