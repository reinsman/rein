import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  ButtonBase,
  Dialog,
  DialogTitle,
  ListItemButton,
  Select,
  TextField,
} from '@mui/material'
import type { Agent, AgentConfiguration } from '../types'
import { agentConfigService } from '../services/agentConfigService'
import { reinService } from '../services/reinService'
import { Row as SettingRow } from './Settings'
import { Action, Icon } from './shared'

const categories = [
  { name: '基本设置', icon: 'settings', description: '设置 Agent 的身份、职责与运行类型。' },
  { name: 'A2A 配置', icon: 'flow', description: '配置 Agent 间的通信与能力发现。' },
  { name: '本地配置', icon: 'computer', description: '配置此 Agent 的本地运行参数。' },
  { name: 'SKILL 配置', icon: 'doc', description: '管理此 Agent 可发现的技能与加载方式。' },
  { name: '记忆存储', icon: 'layers', description: '配置记忆的存储位置与保留方式。' },
]

type Commit = () => Promise<boolean>
function ConfigInput({
  label,
  value,
  onChange,
  numeric = false,
  onCommit,
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  numeric?: boolean
  onCommit: Commit
}) {
  return (
    <TextField
      fullWidth
      value={value}
      type={numeric ? 'number' : 'text'}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => void onCommit()}
      slotProps={{
        htmlInput: {
          'aria-label': label,
          ...(numeric ? { min: 1, max: 86400, step: 1 } : { maxLength: 2000 }),
        },
      }}
    />
  )
}
function ConfigSelect({
  label,
  value,
  options,
  onChange,
  onCommit,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  onCommit: Commit
}) {
  return (
    <Select
      native
      fullWidth
      value={value}
      inputProps={{ 'aria-label': label }}
      onChange={(e) => {
        onChange(e.target.value)
        void onCommit()
      }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {label === 'Agent 类型'
            ? { claude: 'Claude Code', codex: 'Codex', pi: 'pi', a2a: 'A2A' }[
                option as Agent['provider']
              ]
            : option}
        </option>
      ))}
    </Select>
  )
}
function ConfigToggle({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
  onCommit: Commit
}) {
  return (
    <ButtonBase
      role="switch"
      aria-label={label}
      aria-checked={value}
      className="setting-switch"
      onClick={() => {
        onChange(!value)
        void onCommit()
      }}
    >
      <img src={`/icons/switch-MuiSwitchSmall${value ? 'On' : 'Off'}.svg`} alt="" />
    </ButtonBase>
  )
}

export function AgentSettings({
  agent,
  onClose,
  onSaved,
}: {
  agent?: Agent
  onClose: () => void
  onSaved: (agent: Agent) => void
}) {
  const creating = !agent
  const [value, setValue] = useState<AgentConfiguration | null>(null)
  const draft = useRef<AgentConfiguration | null>(null)
  const dirty = useRef(false)
  const navRef = useRef<HTMLElement>(null)
  const [category, setCategory] = useState(0)
  const [error, setError] = useState('')
  const [status, setStatus] = useState(
    creating ? '创建后保存配置，使用 rein agent up 上线' : '请在 Agent 配置文件中修改原生设置',
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let active = true
    void agentConfigService.get(agent).then((config) => {
      if (active) {
        draft.current = config
        setValue(config)
      }
    })
    return () => {
      active = false
    }
  }, [agent])
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const revealSelection = () => {
      if (nav.scrollWidth > nav.clientWidth)
        nav.querySelector('.Mui-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const observer = new ResizeObserver(revealSelection)
    observer.observe(nav)
    revealSelection()
    return () => observer.disconnect()
  }, [category])

  function update<K extends keyof AgentConfiguration>(
    section: K,
    patch: Partial<AgentConfiguration[K]>,
  ) {
    if (!draft.current) return
    const next = { ...draft.current, [section]: { ...draft.current[section], ...patch } }
    if (section === 'basic') {
      const provider = (patch as Partial<AgentConfiguration['basic']>).provider
      if (provider && next.local.executable === draft.current.basic.provider)
        next.local = { ...next.local, executable: provider }
    }
    draft.current = next
    dirty.current = true
    setValue(next)
    setError('')
    setStatus(creating ? '新 Agent 配置待创建' : '编辑中 · 移开焦点后保存')
  }
  async function save(create = false) {
    if (creating && !create) return true
    if (!draft.current || !dirty.current) return true
    setSaving(true)
    try {
      const saved = await reinService.saveAgent(draft.current, agent?.id)
      dirty.current = false
      setError('')
      setStatus('Agent 配置已保存')
      onSaved(saved)
      return true
    } catch (err) {
      setError((err as Error).message)
      setStatus('尚未保存，请修正输入')
      return false
    } finally {
      setSaving(false)
    }
  }
  async function close() {
    await save()
    onClose()
  }
  return (
    <Dialog
      open
      onClose={() => void close()}
      maxWidth={false}
      className="settings-dialog agent-config-dialog"
      aria-labelledby={`agent-settings-${agent?.id ?? 'new'}`}
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
      <DialogTitle className="settings-title" id={`agent-heading-${agent?.id ?? 'new'}`}>
        <span id={`agent-settings-${agent?.id ?? 'new'}`}>
          {creating ? '新建 Agent' : `Agent 设置 · ${value?.basic.name || agent.name}`}
        </span>
        <Action
          label={creating ? '关闭新建 Agent' : '关闭 Agent 设置'}
          icon="close"
          onClick={() => void close()}
        />
      </DialogTitle>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Agent 配置分类" ref={navRef}>
          {categories.map((item, i) => (
            <ListItemButton
              component="button"
              key={item.name}
              selected={category === i}
              onClick={async () => {
                if (await save()) setCategory(i)
              }}
            >
              <Icon name={item.icon} />
              {item.name}
            </ListItemButton>
          ))}
          <span className="spacer" />
          <small>
            {creating ? '新建' : value?.basic.name || agent.name} ·{' '}
            {value
              ? { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', a2a: 'A2A' }[
                  value.basic.provider
                ]
              : ''}
          </small>
        </nav>
        <section className="settings-content" aria-label={categories[category].name}>
          <h2>{categories[category].name}</h2>
          <p className="settings-description">{categories[category].description}</p>
          {error && (
            <Alert severity="error" className="agent-config-error">
              {error}
            </Alert>
          )}
          {!value ? (
            <p role="status">正在载入配置…</p>
          ) : (
            <div className="settings-fields">
              {category === 0 && (
                <>
                  <SettingRow label="名称" description="在对话和任务中显示的名字。">
                    <ConfigInput
                      label="名称"
                      value={value.basic.name}
                      onChange={(name) => update('basic', { name })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="描述" description="说明 Agent 的职责与能力。">
                    <ConfigInput
                      label="描述"
                      value={value.basic.description}
                      onChange={(description) => update('basic', { description })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="Agent 类型" description="选择此 Agent 使用的运行工具。">
                    <ConfigSelect
                      label="Agent 类型"
                      value={value.basic.provider}
                      options={['codex', 'pi']}
                      onChange={(provider) =>
                        update('basic', { provider: provider as Agent['provider'] })
                      }
                      onCommit={save}
                    />
                  </SettingRow>
                </>
              )}
              {category === 1 && (
                <>
                  <SettingRow label="远程 Agent" description="通过 A2A 连接远程 Agent。">
                    <ConfigToggle
                      label="远程 Agent"
                      value={value.a2a.enabled}
                      onChange={(enabled) => update('a2a', { enabled })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="服务地址" description="Agent 的 A2A 接口地址。">
                    <ConfigInput
                      label={'服务地址'}
                      value={value.a2a.endpoint}
                      onChange={(endpoint) => update('a2a', { endpoint })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="Agent Card" description="用于发现能力、技能与认证方式。">
                    <ConfigInput
                      label={'Agent Card'}
                      value={value.a2a.cardPath}
                      onChange={(cardPath) => update('a2a', { cardPath })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="传输协议" description="与远程 Agent 声明的接口一致。">
                    <ConfigSelect
                      label={'传输协议'}
                      value={value.a2a.transport}
                      options={['JSON-RPC', 'HTTP+JSON']}
                      onChange={(transport) =>
                        update('a2a', {
                          transport: transport as AgentConfiguration['a2a']['transport'],
                        })
                      }
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="请求超时（秒）" description="单次通信的最大等待时间。">
                    <ConfigInput
                      label={'请求超时（秒）'}
                      value={value.a2a.timeout}
                      onChange={(timeout) => update('a2a', { timeout: Number(timeout) })}
                      numeric={true}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="流式响应" description="按事件接收执行进度。">
                    <ConfigToggle
                      label={'流式响应'}
                      value={value.a2a.streaming}
                      onChange={(streaming) => update('a2a', { streaming })}
                      onCommit={save}
                    />
                  </SettingRow>
                </>
              )}
              {category === 2 && (
                <>
                  <SettingRow label="可执行文件" description="由执行服务解析，此处不会运行。">
                    <ConfigInput
                      label={'可执行文件'}
                      value={value.local.executable}
                      onChange={(executable) => update('local', { executable })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="工作目录" description="运行任务时使用的目录。">
                    <ConfigInput
                      label={'工作目录'}
                      value={value.local.workingDirectory}
                      onChange={(workingDirectory) => update('local', { workingDirectory })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="默认模型" description="跟随本机 CLI 的模型设置。">
                    <ConfigInput
                      label={'默认模型'}
                      value={value.local.model}
                      onChange={(model) => update('local', { model })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="审批方式" description="需要人工确认的操作范围。">
                    <ConfigSelect
                      label={'审批方式'}
                      value={value.local.approval}
                      options={['每次确认', '项目目录写入', '只读']}
                      onChange={(approval) =>
                        update('local', {
                          approval: approval as AgentConfiguration['local']['approval'],
                        })
                      }
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="执行超时（秒）" description="任务运行的最长等待时间。">
                    <ConfigInput
                      label={'执行超时（秒）'}
                      value={value.local.timeout}
                      onChange={(timeout) => update('local', { timeout: Number(timeout) })}
                      numeric={true}
                      onCommit={save}
                    />
                  </SettingRow>
                </>
              )}
              {category === 3 && (
                <>
                  <SettingRow label="技能目录" description="每个目录包含独立的 SKILL.md。">
                    <ConfigInput
                      label={'技能目录'}
                      value={value.skills.directories}
                      onChange={(directories) => update('skills', { directories })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="启用的技能" description="用英文逗号分隔技能名称。">
                    <ConfigInput
                      label={'启用的技能'}
                      value={value.skills.enabled}
                      onChange={(enabled) => update('skills', { enabled })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="自动发现" description="从配置的目录中发现技能。">
                    <ConfigToggle
                      label={'自动发现'}
                      value={value.skills.autoDiscover}
                      onChange={(autoDiscover) => update('skills', { autoDiscover })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="允许技能命令" description="允许通过技能命令显式调用。">
                    <ConfigToggle
                      label={'允许技能命令'}
                      value={value.skills.allowCommands}
                      onChange={(allowCommands) => update('skills', { allowCommands })}
                      onCommit={save}
                    />
                  </SettingRow>
                </>
              )}
              {category === 4 && (
                <>
                  <SettingRow label="存储方式" description="前端仅保存配置，不创建存储。">
                    <ConfigSelect
                      label={'存储方式'}
                      value={value.memory.backend}
                      options={['本地文件', 'SQLite', 'Chroma']}
                      onChange={(backend) =>
                        update('memory', {
                          backend: backend as AgentConfiguration['memory']['backend'],
                        })
                      }
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="存储目录" description="此 Agent 的记忆存储位置。">
                    <ConfigInput
                      label={'存储目录'}
                      value={value.memory.directory}
                      onChange={(directory) => update('memory', { directory })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="命名空间" description="隔离不同 Agent 的记忆。">
                    <ConfigInput
                      label={'命名空间'}
                      value={value.memory.namespace}
                      onChange={(namespace) => update('memory', { namespace })}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="保留天数" description="记忆记录的保留时间。">
                    <ConfigInput
                      label={'保留天数'}
                      value={value.memory.retentionDays}
                      onChange={(retentionDays) =>
                        update('memory', { retentionDays: Number(retentionDays) })
                      }
                      numeric={true}
                      onCommit={save}
                    />
                  </SettingRow>
                  <SettingRow label="自动保存" description="任务结束后保存记忆。">
                    <ConfigToggle
                      label={'自动保存'}
                      value={value.memory.autoSave}
                      onChange={(autoSave) => update('memory', { autoSave })}
                      onCommit={save}
                    />
                  </SettingRow>
                </>
              )}
            </div>
          )}
          <div className="settings-status" role="status">
            <span>{status}</span>
            {creating && (
              <Button
                variant="contained"
                disabled={saving || !value?.basic.name.trim()}
                onClick={() => void save(true)}
              >
                {saving ? '正在创建…' : '创建 Agent'}
              </Button>
            )}
          </div>
        </section>
      </div>
    </Dialog>
  )
}
