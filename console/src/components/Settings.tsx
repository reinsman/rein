import { useState } from 'react'
import {
  Alert,
  Button,
  ButtonBase,
  Dialog,
  DialogTitle,
  ListItemButton,
  Select,
} from '@mui/material'
import type { ReactNode } from 'react'
import type { Preferences } from '../services/preferences'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'
import { WorkflowSettings } from './WorkflowSettings'
import { AgentTypeSettings } from './AgentTypeSettings'

const categories = [
  { name: '通用', icon: 'tune', description: '偏好设置适用于此设备。' },
  {
    name: 'Agent 配置',
    icon: 'flow',
    description: '管理 Codex 和 Pi 的类型默认值与共享原生配置。',
  },
  { name: 'Agents 编排', icon: 'computer', description: '分配执行角色并设置任务调度。' },
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
  const [typeConfigDirty, setTypeConfigDirty] = useState(false)
  const [showDraftWarning, setShowDraftWarning] = useState(false)
  function close() {
    if (typeConfigDirty) setShowDraftWarning(true)
    else onClose()
  }
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
        onClose={close}
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
          <Action label="关闭配置" icon="close" onClick={close} />
        </DialogTitle>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="配置分类">
            {categories.map((item, i) => (
              <ListItemButton
                selected={category === i}
                key={item.name}
                onClick={() => {
                  if (i === category) return
                  if (typeConfigDirty) setShowDraftWarning(true)
                  else setCategory(i)
                }}
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
                  {showDraftWarning && <Alert severity="warning">请先保存或放弃修改。</Alert>}
                  <AgentTypeSettings
                    notify={notify}
                    onDirty={(dirty) => {
                      setTypeConfigDirty(dirty)
                      if (!dirty) setShowDraftWarning(false)
                    }}
                  />
                </>
              )}
              {category === 2 && <WorkflowSettings notify={notify} />}
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
              <span>
                {category === 1
                  ? '下次启动原生 Agent 时读取配置'
                  : category === 2
                    ? '角色配置需点击保存'
                    : status}
              </span>
            </div>
          </section>
        </div>
      </Dialog>
    </>
  )
}
