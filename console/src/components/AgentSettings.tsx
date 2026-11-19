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
import type { AgentPermissions, AgentSkills } from '../localTypes'
import {
  agentConfigService,
  permissionLabels,
  type TypeDefaults,
} from '../services/agentConfigService'
import { reinService } from '../services/reinService'
import { localService } from '../services/localService'
import { Row } from './Settings'
import { Action, Icon } from './shared'

const categories = [
  { name: '基本设置', icon: 'settings', description: '设置此 Agent 的身份与运行类型。' },
  {
    name: '权限配置',
    icon: 'shield',
    description: '继承系统中对应 Agent 类型的默认权限，也可以单独覆盖。',
  },
  {
    name: '模型与思考',
    icon: 'flow',
    description: '查看从类型配置继承的值，并为此 Agent 设置独立覆盖。',
  },
  { name: 'SKILL 配置', icon: 'doc', description: '管理此 Agent 的技能启停和附加技能目录。' },
  { name: '本地配置', icon: 'computer', description: '配置此 Agent 的工作目录与原生运行环境。' },
  { name: 'A2A 配置', icon: 'flow', description: '连接由远端管理的 Agent。' },
]
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
  const [value, setValue] = useState(() => agentConfigService.get(agent))
  const [category, setCategory] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [skills, setSkills] = useState<AgentSkills | null>(agent?.skills ?? null)
  const [skillError, setSkillError] = useState('')
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [directories, setDirectories] = useState((agent?.skill_directories ?? []).join('\n'))
  const navRef = useRef<HTMLElement>(null)
  const remote = !!value.a2a
  const [typeDefaults, setTypeDefaults] = useState<{
    provider: Agent['provider']
    values?: TypeDefaults
    error?: string
  }>()
  const showTypeDefaults =
    !remote && (category === 2 || (category === 1 && value.provider === 'codex'))
  const defaults = typeDefaults?.provider === value.provider ? typeDefaults : undefined
  const effectivePermissions = value.permissions ?? defaults?.values?.permissions
  const defaultPermissionsLabel = defaults?.values
    ? permissionLabels[defaults.values.permissions]
    : defaults?.error
      ? '读取失败'
      : '正在读取…'
  const typeModel = defaults?.error
    ? '读取失败'
    : defaults?.values
      ? agentConfigService.modelName(defaults.values)
      : '正在读取…'
  const typeEffort = defaults?.error
    ? '读取失败'
    : defaults?.values
      ? (defaults.values.reasoning_effort ?? '由原生 CLI 选择')
      : '正在读取…'

  useEffect(() => {
    if (!showTypeDefaults) return
    const controller = new AbortController()
    const provider = value.provider
    void agentConfigService
      .typeDefaults(provider, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]))
      .then(
        (values) => {
          if (!controller.signal.aborted) setTypeDefaults({ provider, values })
        },
        (failure) => {
          if (!controller.signal.aborted) setTypeDefaults({ provider, error: String(failure) })
        },
      )
    return () => controller.abort()
  }, [showTypeDefaults, value.provider])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const reveal = () => {
      if (nav.scrollWidth > nav.clientWidth)
        nav.querySelector('.Mui-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(nav)
    reveal()
    return () => observer.disconnect()
  }, [category])

  function update(patch: Partial<AgentConfiguration>) {
    setValue((previous) => ({ ...previous, ...patch }))
    setDirty(true)
    setDiscarding(false)
    setError('')
  }
  async function save() {
    setSaving(true)
    setError('')
    try {
      const configuration = {
        ...value,
        name: value.name.trim(),
        model: value.model?.trim() || null,
      }
      if (configuration.a2a)
        Object.assign(configuration, {
          directory: null,
          executable: null,
          native_config: null,
          model: null,
          prepare: null,
          permissions: null,
          reasoning_effort: null,
          skill_directories: [],
          skill_source: 'rein',
          disabled_skills: [],
        })
      const saved = await reinService.saveAgent(configuration, agent?.id)
      setValue(agentConfigService.get(saved))
      setDirty(false)
      onSaved(saved)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  function close() {
    if (saving || installing) return
    if (dirty) setDiscarding(true)
    else onClose()
  }
  async function refreshSkills(install = false) {
    if (!agent) return
    setSkillError('')
    if (install) setInstalling(true)
    else setLoadingSkills(true)
    try {
      setSkills(
        await (install ? localService.installReinSpec(agent.id) : localService.skills(agent.id)),
      )
    } catch (err) {
      setSkillError((err as Error).message)
    } finally {
      setLoadingSkills(false)
      setInstalling(false)
    }
  }
  function input(
    key: 'name' | 'model' | 'directory' | 'executable',
    label: string,
    placeholder?: string,
  ) {
    return (
      <TextField
        fullWidth
        value={value[key] ?? ''}
        placeholder={placeholder}
        disabled={saving || (key === 'name' && !creating)}
        onChange={(e) => update({ [key]: e.target.value || (key === 'name' ? '' : null) })}
        slotProps={{ htmlInput: { 'aria-label': label, maxLength: 2000 } }}
      />
    )
  }
  function select(
    label: string,
    current: string,
    options: string[][],
    change: (next: string) => void,
  ) {
    return (
      <Select
        native
        fullWidth
        value={current}
        disabled={saving}
        inputProps={{ 'aria-label': label }}
        onChange={(e) => change(e.target.value)}
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </Select>
    )
  }

  return (
    <Dialog
      open
      onClose={close}
      maxWidth={false}
      className="settings-dialog agent-config-dialog"
      aria-labelledby="agent-settings-title"
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
      <DialogTitle className="settings-title" id="agent-settings-title">
        <span>{creating ? '新建 Agent' : `Agent 设置 · ${agent.name}`}</span>
        <Action
          label={creating ? '关闭新建 Agent' : '关闭 Agent 设置'}
          icon="close"
          onClick={close}
        />
      </DialogTitle>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Agent 配置分类" ref={navRef}>
          {categories.map((item, i) => (
            <ListItemButton
              component="button"
              key={item.name}
              selected={category === i}
              aria-current={category === i ? 'true' : undefined}
              onClick={() => setCategory(i)}
            >
              <Icon name={item.icon} />
              {item.name}
            </ListItemButton>
          ))}
          <span className="spacer" />
          <small>
            {creating ? '新建 Agent' : agent.name} · {value.provider === 'codex' ? 'Codex' : 'Pi'}
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
          <div className="settings-fields">
            {category === 0 && (
              <>
                <Row
                  label="名称"
                  description={
                    creating
                      ? '1–64 个字母、数字、短横线或下划线。'
                      : '名称关联对话与任务历史，创建后保持不变。'
                  }
                >
                  {input('name', '名称')}
                </Row>
                <Row label="Agent 类型" description="选择此 Agent 使用的运行工具。">
                  {select(
                    'Agent 类型',
                    value.provider,
                    [
                      ['codex', 'Codex'],
                      ['pi', 'Pi'],
                    ],
                    (provider) =>
                      update({
                        provider: provider as Agent['provider'],
                        permissions: null,
                        reasoning_effort: null,
                      }),
                  )}
                </Row>
              </>
            )}
            {[1, 2, 3, 4].includes(category) && remote ? (
              <Alert severity="info">此 Agent 通过 A2A 运行，权限、技能和模型由远端配置。</Alert>
            ) : (
              <>
                {category === 1 && (
                  <>
                    {value.provider === 'codex' && defaults?.error && (
                      <Alert severity="error">{defaults.error}</Alert>
                    )}
                    <Row
                      label="访问级别"
                      description={
                        value.provider === 'codex'
                          ? `类型默认值 · ${defaultPermissionsLabel}`
                          : '继承 Pi 的默认权限，由启动账户和运行环境决定。'
                      }
                    >
                      {value.provider === 'pi' ? (
                        <span className="agent-setting-value">原生完全访问</span>
                      ) : (
                        select(
                          '访问级别',
                          value.permissions ?? '',
                          [['', '继承类型默认权限'], ...Object.entries(permissionLabels)],
                          (permissions) =>
                            update({
                              permissions: (permissions || null) as AgentPermissions | null,
                            }),
                        )
                      )}
                    </Row>
                    {value.provider === 'codex' && effectivePermissions && (
                      <Alert
                        severity={effectivePermissions === 'full_access' ? 'warning' : 'info'}
                        className="agent-config-error"
                      >
                        {effectivePermissions === 'full_access'
                          ? '完全访问关闭 Codex 沙箱和审批，Agent 可在启动账户的权限范围内操作。'
                          : effectivePermissions === 'read_only'
                            ? '使用 Codex 只读沙箱，超出权限的操作需要审批。'
                            : '使用 Codex 项目写入沙箱，超出权限的操作需要审批。'}
                      </Alert>
                    )}
                  </>
                )}
                {category === 2 && (
                  <>
                    {defaults?.error && <Alert severity="error">{defaults.error}</Alert>}
                    <Row label="模型" description={`类型默认值 · ${typeModel}`}>
                      <div className="agent-setting-override">
                        {input('model', '模型覆盖', '留空继承')}
                        {value.model?.trim() && (
                          <span className="agent-setting-source">此 Agent 独立设置</span>
                        )}
                      </div>
                    </Row>
                    <Row label="思考强度" description={`类型默认值 · ${typeEffort}`}>
                      <div className="agent-setting-override">
                        {select(
                          '思考强度',
                          value.reasoning_effort ?? '',
                          [
                            ['', '继承类型默认值'],
                            ...(value.provider === 'pi'
                              ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
                              : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
                            ).map((level) => [level, level]),
                          ],
                          (reasoning_effort) =>
                            update({ reasoning_effort: reasoning_effort || null }),
                        )}
                        {value.reasoning_effort && (
                          <span className="agent-setting-source">此 Agent 独立设置</span>
                        )}
                      </div>
                    </Row>
                    <p className="settings-description agent-settings-note">
                      类型默认值来自系统配置的「Agent 配置」。可用的思考强度取决于模型。
                    </p>
                  </>
                )}
                {category === 3 && (
                  <>
                    <section className="agent-skill-group" aria-label="默认技能来源">
                      <Row
                        label="默认技能来源"
                        description="默认只加载 Rein 技能目录和附加目录；原生目录兼容模式用于不支持指定目录的 CLI。"
                      >
                        {select(
                          '默认技能来源',
                          value.skill_source ?? 'rein',
                          [
                            ['rein', 'Rein 技能目录（默认）'],
                            ['native', '原生技能目录（兼容）'],
                          ],
                          (skill_source) =>
                            update({ skill_source: skill_source as 'rein' | 'native' }),
                        )}
                      </Row>
                      <div className="agent-skill-children">
                        <Row
                          label="默认技能目录"
                          description={
                            value.skill_source === 'native'
                              ? '使用原生 Agent 的用户级和项目技能目录。'
                              : '由 Rein 管理，不自动加载原生用户或项目技能目录。'
                          }
                        >
                          <code className="skill-default-path">
                            {(value.skill_source === 'native'
                              ? skills?.install_path
                              : skills?.source_path
                            )?.replace(/\/rein-spec$/, '') ?? '创建 Agent 后显示实际目录'}
                          </code>
                        </Row>
                      </div>
                    </section>
                    <Row
                      label="附加技能目录"
                      description="默认留空。每行一个绝对目录，保存后扫描其中的 SKILL.md；清空可移除附加目录。"
                    >
                      <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        maxRows={5}
                        value={directories}
                        disabled={saving}
                        placeholder="/absolute/path/to/skills"
                        slotProps={{ htmlInput: { 'aria-label': '技能目录' } }}
                        onChange={(e) => {
                          setDirectories(e.target.value)
                          update({
                            skill_directories: e.target.value
                              .split('\n')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }}
                      />
                    </Row>
                    <section className="agent-skill-group" aria-label="已发现的技能">
                      <Row
                        label="已发现的技能"
                        description="扫描所选来源及已保存的附加目录。启停仅对本 Agent 生效，来源或目录更改后先保存再刷新。"
                      >
                        <Button
                          variant="outlined"
                          disabled={creating || loadingSkills || installing || dirty}
                          onClick={() => void refreshSkills()}
                        >
                          {loadingSkills ? '正在刷新…' : '刷新技能'}
                        </Button>
                      </Row>
                      <div className="agent-skill-children agent-skill-list">
                        {creating ? (
                          <p className="settings-description">
                            创建 Agent 后可查看并管理已发现的技能。
                          </p>
                        ) : (
                          <>
                            {(skillError || skills?.error) && (
                              <Alert severity="error" className="agent-config-error">
                                {skillError || skills?.error}
                              </Alert>
                            )}
                            {!skills?.entries?.length && !skills?.error && (
                              <p className="settings-description">
                                尚未发现技能。可以添加技能目录，或安装下方的 rein-spec。
                              </p>
                            )}
                            {skills?.entries?.map((skill) => (
                              <Row key={skill.path} label={skill.name} description={skill.path}>
                                <ButtonBase
                                  role="switch"
                                  aria-label={`启用技能 ${skill.name}`}
                                  aria-checked={!value.disabled_skills?.includes(skill.path)}
                                  className="setting-switch"
                                  disabled={saving}
                                  onClick={() =>
                                    update({
                                      disabled_skills: value.disabled_skills?.includes(skill.path)
                                        ? value.disabled_skills.filter(
                                            (path) => path !== skill.path,
                                          )
                                        : [...(value.disabled_skills ?? []), skill.path],
                                    })
                                  }
                                >
                                  <img
                                    src={`/icons/switch-MuiSwitchSmall${value.disabled_skills?.includes(skill.path) ? 'Off' : 'On'}.svg`}
                                    alt=""
                                  />
                                </ButtonBase>
                              </Row>
                            ))}
                          </>
                        )}
                      </div>
                    </section>
                    {!creating && (
                      <>
                        <Row
                          label="原生目录备用安装"
                          description={
                            skills?.rein_spec_installed
                              ? '已安装在原生用户技能目录；兼容模式可使用，已有文件不会被覆盖。'
                              : '安装到原生用户技能目录，同一配置目录的其他 Agent 也可发现；不覆盖已有文件。'
                          }
                        >
                          <Button
                            variant="outlined"
                            disabled={
                              installing || loadingSkills || dirty || skills?.rein_spec_installed
                            }
                            onClick={() => void refreshSkills(true)}
                          >
                            {installing
                              ? '正在安装…'
                              : skills?.rein_spec_installed
                                ? '已安装'
                                : '安装 rein-spec'}
                          </Button>
                        </Row>
                        {value.provider === 'pi' && (
                          <p className="settings-description">
                            Pi
                            的技能筛选覆盖此处发现的文件技能；包和扩展提供的技能请通过原生配置管理。
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
                {category === 4 && (
                  <>
                    <Row
                      label="工作目录"
                      description="独立对话留空使用 Agent 类型目录。项目内的任务和对话使用项目的首选工作目录。"
                    >
                      {input('directory', '工作目录', `<REIND_HOME>/agents/${value.provider}/`)}
                    </Row>
                    <Row
                      label="可执行文件"
                      description="留空使用 PATH 中的原生 CLI，或指定可执行文件绝对路径。"
                    >
                      {input('executable', '可执行文件', value.provider)}
                    </Row>
                    <Row
                      label="原生配置"
                      description="同类型 Agent 共用原生配置，可在系统配置的「Agent 配置」中编辑。"
                    >
                      <code className="skill-default-path">
                        {`<REIND_HOME>/agents/${value.provider}/`}
                      </code>
                    </Row>
                  </>
                )}
              </>
            )}
            {category === 5 && (
              <>
                <Row label="远程 Agent" description="通过 A2A 连接远端；开启后本地执行配置不适用。">
                  <ButtonBase
                    role="switch"
                    aria-label="远程 Agent"
                    aria-checked={remote}
                    className="setting-switch"
                    disabled={saving}
                    onClick={() =>
                      update({ a2a: remote ? null : { url: 'http://127.0.0.1:8080/a2a' } })
                    }
                  >
                    <img src={`/icons/switch-MuiSwitchSmall${remote ? 'On' : 'Off'}.svg`} alt="" />
                  </ButtonBase>
                </Row>
                {remote && (
                  <Row label="服务地址" description="远端 Agent 的完整 HTTP 或 HTTPS 地址。">
                    <TextField
                      fullWidth
                      value={value.a2a!.url}
                      disabled={saving}
                      slotProps={{ htmlInput: { 'aria-label': '服务地址' } }}
                      onChange={(e) => update({ a2a: { ...value.a2a!, url: e.target.value } })}
                    />
                  </Row>
                )}
              </>
            )}
          </div>
          {discarding && (
            <Alert
              severity="warning"
              className="agent-config-error"
              action={<Button onClick={onClose}>放弃更改</Button>}
            >
              有尚未保存的更改。可以保存，或放弃后关闭。
            </Alert>
          )}
          <div className="settings-status" role="status">
            <span>
              {creating
                ? '创建后使用 rein agent up 上线'
                : dirty
                  ? '更改待保存 · 下次运行时读取配置'
                  : '配置保存到本机 · 下次运行时读取配置'}
            </span>
            <Button
              variant="contained"
              disabled={saving || installing || !value.name.trim() || (!creating && !dirty)}
              onClick={() => void save()}
            >
              {saving ? '正在保存…' : creating ? '创建 Agent' : '保存配置'}
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  )
}
