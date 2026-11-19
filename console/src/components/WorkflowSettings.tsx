import { useEffect, useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material'
import type { Agent } from '../types'
import type { AgentSkills } from '../localTypes'
import { workflowService, type WorkflowSettings as Configuration } from '../services/workflow'
import { reinService } from '../services/reinService'
import { localService } from '../services/localService'
import { AgentLabels } from './AgentLabels'

export function WorkflowSettings({ notify }: { notify: (message: string) => void }) {
  const [value, setValue] = useState<Configuration>()
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [skillCheck, setSkillCheck] = useState<{ agent: string; status?: AgentSkills }>()
  const [confirmInstall, setConfirmInstall] = useState(false)
  useEffect(() => {
    return reinService.subscribe((data) => {
      setValue((current) => current ?? data.workflow?.settings)
      setAgents(data.agents)
      setConnectionError(data.workflowError ?? data.agentError ?? '')
    })
  }, [])
  const mainAgent = agents.find((agent) => agent.id === value?.main_agent)
  const skillStatus = skillCheck?.agent === value?.main_agent ? skillCheck?.status : undefined
  const checking = Boolean(value?.main_agent && skillCheck?.agent !== value.main_agent)
  useEffect(() => {
    let active = true
    const agent = value?.main_agent
    if (!agent) return
    localService
      .skills(agent)
      .then((status) => {
        if (!active) return
        setSkillCheck({ agent, status })
        setConfirmInstall(
          !status.error &&
            mainAgent?.skill_source === 'native' &&
            !status.rein_spec_installed &&
            !status.entries.some((skill) => skill.name === 'rein-spec' && skill.enabled),
        )
      })
      .catch((failure: unknown) => {
        if (active) {
          setSkillCheck({ agent })
          setError(failure instanceof Error ? failure.message : '技能检查失败，请重新选择主 Agent')
        }
      })
    return () => {
      active = false
    }
  }, [value?.main_agent, mainAgent?.skill_source])
  async function install() {
    if (!value?.main_agent) return
    setInstalling(true)
    setError('')
    try {
      const status = await localService.installReinSpec(value.main_agent)
      setSkillCheck({ agent: value.main_agent, status })
      if (status.error || !status.rein_spec_installed)
        throw new Error(status.error || '安装未完成，请重试')
      await reinService.refreshAgents()
      setConfirmInstall(false)
      notify('rein-spec 已安装，共用技能目录的 Agent 可在下次执行时发现')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '安装失败，请重试')
    } finally {
      setInstalling(false)
    }
  }
  const busy = saving || checking || installing
  async function save() {
    if (!value) return
    setSaving(true)
    setError('')
    try {
      await workflowService.settings(value)
      await reinService.refreshWorkflow()
      notify('主 Agent 和任务角色已保存')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="workflow-settings">
      {(error || connectionError) && <Alert severity="error">{error || connectionError}</Alert>}
      {value ? (
        <>
          <label>
            主 Agent
            <select
              aria-label="主 Agent"
              value={value.main_agent ?? ''}
              disabled={busy}
              onChange={(event) => {
                setError('')
                setConfirmInstall(false)
                setValue({ ...value, main_agent: event.target.value || null })
              }}
            >
              <option value="">未配置</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.disabled ? '（已下线）' : ''}
                </option>
              ))}
            </select>
          </label>
          {checking && <p role="status">正在检查主 Agent 的 rein-spec 技能…</p>}
          {skillStatus?.error && <Alert severity="warning">{skillStatus.error}</Alert>}
          {skillStatus &&
            !skillStatus.error &&
            !skillStatus.entries.some((skill) => skill.name === 'rein-spec' && skill.enabled) && (
              <Alert
                severity="warning"
                action={
                  mainAgent?.skill_source === 'native' && !skillStatus.rein_spec_installed ? (
                    <Button onClick={() => setConfirmInstall(true)}>安装 rein-spec</Button>
                  ) : undefined
                }
              >
                主 Agent 当前未启用 rein-spec，请在 Agent 设置的 SKILL 配置中检查技能来源和开关。
              </Alert>
            )}
          <p className="muted">
            Spec 使用主 Agent 规划；任务按角色由空闲 Agent 领取。同一 Agent 可兼任主 Agent、Coding
            和 Review，执行仍然串行。
          </p>
          <div className="workflow-role-list">
            {agents.map((agent) => (
              <div className="workflow-agent-row" key={agent.id}>
                <div className="workflow-agent-identity">
                  <span>
                    {agent.name}
                    {agent.disabled ? ' · 已下线' : ''}
                  </span>
                  <div className="workflow-agent-label-row">
                    <span className="muted">角色</span>
                    <AgentLabels agent={agent} settings={value} />
                    {value.main_agent !== agent.id &&
                      !value.coding_agents.includes(agent.id) &&
                      !value.review_agents.includes(agent.id) && (
                        <span className="muted">未分配</span>
                      )}
                  </div>
                  <div className="workflow-agent-label-row">
                    <span className="muted">技能</span>
                    <span className="agent-labels" role="group" aria-label={`${agent.name}技能`}>
                      {agent.skills?.names.map((skill) => (
                        <span
                          className="agent-label"
                          key={skill}
                          title={`所选目录中的技能：${skill}`}
                        >
                          {skill}
                        </span>
                      ))}
                      {agent.skills?.error ? (
                        <span className="muted">{agent.skills.error}</span>
                      ) : (
                        !agent.skills?.names.length && (
                          <span className="muted">所选目录中未发现技能</span>
                        )
                      )}
                    </span>
                  </div>
                </div>
                <div className="workflow-role-controls">
                  {(['coding_agents', 'review_agents'] as const).map((role) => (
                    <label key={role}>
                      <input
                        type="checkbox"
                        aria-label={`${agent.name} ${role === 'coding_agents' ? 'Coding' : 'Review'}角色`}
                        disabled={busy}
                        checked={value[role].includes(agent.id)}
                        onChange={(event) =>
                          setValue({
                            ...value,
                            [role]: event.target.checked
                              ? [...value[role], agent.id]
                              : value[role].filter((id) => id !== agent.id),
                          })
                        }
                      />
                      {role === 'coding_agents' ? 'Coding' : 'Review'}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="workflow-auto">
            <input
              type="checkbox"
              checked={value.automatic}
              disabled={busy}
              onChange={(event) => setValue({ ...value, automatic: event.target.checked })}
            />
            空闲 Agent 自动领取待开始任务
          </label>
          <p className="muted">
            关闭自动领取后仍可手动开始任务。每个 Spec 顺序执行；同一工作目录只运行一个
            Agent，全局最多 4 个执行。
          </p>
          <Button variant="contained" disabled={busy} onClick={() => void save()}>
            保存编排配置
          </Button>
        </>
      ) : (
        <p>正在读取执行配置…</p>
      )}
      <Dialog
        className="skill-install-dialog"
        open={confirmInstall}
        onClose={() => {
          if (!installing) setConfirmInstall(false)
        }}
        aria-labelledby="install-rein-spec-title"
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id="install-rein-spec-title">
          为 {mainAgent?.name} 安装 rein-spec？
        </DialogTitle>
        <DialogContent>
          <p>rein-spec 帮助主 Agent 编写需求、设计和任务计划，并等待你逐阶段确认。</p>
          <p>技能来源：</p>
          <code className="skill-install-path">{skillStatus?.source_path}</code>
          <p>将安装到 reind 运行用户的技能目录：</p>
          <code className="skill-install-path">{skillStatus?.install_path}</code>
          <p>
            共用此目录的 Agent 和手工启动的 CLI 也能发现该技能。已有文件不会被覆盖，下次执行时加载。
          </p>
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={installing} onClick={() => setConfirmInstall(false)}>
            暂不安装
          </Button>
          <Button variant="contained" disabled={installing} onClick={() => void install()}>
            {installing ? '正在安装…' : '允许安装'}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
