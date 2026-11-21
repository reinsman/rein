import { useId, useState, type ReactNode } from 'react'
import { Divider, IconButton, ListItemButton, OutlinedInput, Tooltip } from '@mui/material'
import type { Agent, AppData, ChatScope, Project, Requirement } from '../types'
import { Action, AgentAvatar, Icon, StatusDot } from './shared'
import { AgentLabels } from './AgentLabels'
import { NodeMention, NodeStatus } from './NodeStatus'

import { reinService } from '../services/reinService'

interface Props {
  data: AppData
  scope: ChatScope
  currentProjectId: string
  currentRequirementId?: string
  onScope: (scope: ChatScope) => void
  onHide: () => void
  onAccount: (el: HTMLElement) => void
  onProject: (project?: Project) => void
  onRequirement: (projectId: string, requirement?: Requirement) => void
  onSpec: (requirement: Requirement) => void
  onAgentSettings: (agent: Agent) => void
  onCreateAgent: () => void
  notify: (text: string) => void
  userName: string
}

const connections = [
  { title: 'GitHub', icon: '/icons/connector-github.svg' },
  { title: 'ONES', icon: '/icons/connector-ones.png' },
]

function SidebarRoster({
  title,
  addLabel,
  onAdd,
  children,
}: {
  title: string
  addLabel: string
  onAdd: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const listId = useId()
  return (
    <section className="sidebar-roster" aria-label={title}>
      <div className="roster-header">
        <button
          className="roster-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          <span className={`tree-chevron ${open ? 'expanded' : ''}`}>
            <Icon name="down" />
          </span>
          {title}
        </button>
        <Action label={addLabel} icon="plus" className="quiet-action" onClick={onAdd} />
      </div>
      <div id={listId} className="sidebar-roster-list" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

export function Sidebar({
  data,
  scope,
  currentProjectId,
  onScope,
  onHide,
  onAccount,
  onProject,
  onRequirement,
  onSpec,
  onAgentSettings,
  onCreateAgent,
  notify,
  userName,
}: Props) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ gatewaykit: true })
  const [visibleCount, setVisibleCount] = useState(5)
  const matches = (text: string) => text.toLowerCase().includes(search.trim().toLowerCase())
  const projects = data.projects.filter(
    (project) =>
      matches(project.name) ||
      data.requirements.some((r) => r.projectId === project.id && matches(r.title)),
  )
  const visibleProjects = search
    ? projects
    : projects.filter((project, index) => index < visibleCount || project.id === currentProjectId)
  const showConnectionNotice = () => notify('正在设计')
  return (
    <aside className="sidebar" aria-label="项目导航">
      <div className="workspace-header">
        <div className="workspace-select">
          <Icon name="layers" size={20} />
          <span>Rein</span>
        </div>
        <Action label="收起侧栏" icon="collapse" className="sidebar-toggle" onClick={onHide} />
      </div>
      <div className="sidebar-scroll">
        <OutlinedInput
          className="sidebar-search"
          fullWidth
          placeholder="搜索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          startAdornment={<Icon name="search" />}
          endAdornment={<span className="shortcut">⌘ K</span>}
          inputProps={{ 'aria-label': '搜索项目和需求' }}
        />
        <nav className="navigation" aria-label="项目与对话">
          <section className="project-section" aria-label="项目">
            <div className="nav-label">
              <span>项目</span>
              <Action
                label="新建项目"
                icon="plus"
                className="quiet-action"
                onClick={() => onProject()}
              />
            </div>
            {data.projectError && (
              <p className="hub-roster-error" role="alert">
                无法读取项目：{data.projectError}
                <button onClick={() => void reinService.refreshProjects()}>重试</button>
              </p>
            )}
            <div className="project-list" role="region" aria-label="项目列表" tabIndex={0}>
              {visibleProjects.map((project) => {
                const requirements = data.requirements.filter((r) => r.projectId === project.id)
                const open = search
                  ? true
                  : (expanded[project.id] ?? project.id === currentProjectId)
                return (
                  <div className="project-tree" key={project.id} data-project-id={project.id}>
                    <div className="project-row">
                      <ListItemButton
                        component="button"
                        className="project-toggle"
                        aria-label={`${open ? '收起' : '展开'}项目 ${project.name}`}
                        aria-expanded={open}
                        onClick={() => setExpanded((prev) => ({ ...prev, [project.id]: !open }))}
                      >
                        <span className={`tree-chevron ${open ? 'expanded' : ''}`}>
                          <Icon name="down" />
                        </span>
                        <Icon name="project" />
                        <span className="nav-text">{project.name}</span>
                      </ListItemButton>
                      <Action
                        label={`编辑项目 ${project.name}`}
                        icon="edit"
                        className="project-edit quiet-action"
                        onClick={() => onProject(project)}
                      />
                    </div>
                    {open && (
                      <div className="project-children">
                        <div className="requirements-heading">
                          <span>需求</span>
                          <Action
                            label={`在${project.name}中新建需求`}
                            icon="plus"
                            className="quiet-action"
                            onClick={() => onRequirement(project.id)}
                          />
                        </div>
                        {requirements
                          .filter((r) => matches(r.title) || matches(project.name))
                          .map((requirement) => (
                            <div className="requirement-with-specs" key={requirement.id}>
                              <div className="requirement-row">
                                <ListItemButton
                                  component="button"
                                  className="tree-child"
                                  aria-label={requirement.title}
                                  selected={scope.id === requirement.id}
                                  onClick={() =>
                                    onScope({
                                      id: requirement.id,
                                      title: requirement.title,
                                      label: '当前需求',
                                      projectId: project.id,
                                      requirementId: requirement.id,
                                    })
                                  }
                                >
                                  <Icon name="requirement" />
                                  <span className="nav-text">{requirement.title}</span>
                                  <NodeStatus requirementId={requirement.id} />
                                  <NodeMention id={requirement.id} />
                                </ListItemButton>
                                <Action
                                  label={`编辑需求 ${requirement.title}`}
                                  icon="edit"
                                  className="requirement-edit quiet-action"
                                  onClick={() => onRequirement(project.id, requirement)}
                                />
                                <Action
                                  label={`新建 Spec ${requirement.title}`}
                                  icon="specAdd"
                                  className="requirement-new-spec quiet-action"
                                  onClick={() => onSpec(requirement)}
                                />
                              </div>
                              <div className="spec-tree">
                                {data.workflow?.specs
                                  .filter((spec) => spec.requirement_id === requirement.id)
                                  .map((spec) => (
                                    <ListItemButton
                                      component="button"
                                      key={spec.id}
                                      selected={scope.specId === spec.id}
                                      aria-label={`打开 Spec ${spec.title}`}
                                      onClick={() =>
                                        onScope({
                                          id: spec.id,
                                          title: `${requirement.title} - ${spec.title}`,
                                          label: 'Spec',
                                          projectId: project.id,
                                          requirementId: requirement.id,
                                          specId: spec.id,
                                        })
                                      }
                                    >
                                      <Icon name="spec" />
                                      <span className="nav-text">{spec.title}</span>
                                      <NodeStatus specId={spec.id} />
                                      <NodeMention id={spec.id} />
                                    </ListItemButton>
                                  ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {!search && projects.length > visibleCount && (
                <button
                  className="show-more-projects"
                  onClick={() => setVisibleCount((count) => count + 3)}
                >
                  展示更多
                  <Icon name="down" />
                </button>
              )}
              {projects.length === 0 && <p className="search-empty">没有匹配的项目或需求</p>}
            </div>
          </section>
        </nav>
        <div className="sidebar-rosters" hidden={!!search}>
          <SidebarRoster title="连接" addLabel="新建连接" onAdd={showConnectionNotice}>
            <ul className="connection-list" aria-label="连接器">
              {connections.map(({ title, icon }) => (
                <li className="connection-row" key={title}>
                  <img src={icon} alt="" width={16} height={16} />
                  <span className="nav-text">{title}</span>
                  <Action
                    label={`${title}设置`}
                    icon="settings"
                    className="connection-settings-action"
                    onClick={showConnectionNotice}
                  />
                </li>
              ))}
            </ul>
          </SidebarRoster>
          <SidebarRoster title="Agents" addLabel="新建 Agent" onAdd={onCreateAgent}>
            {data.agentError && (
              <p className="hub-roster-error" role="alert">
                无法读取 Agent：{data.agentError}
                <button
                  onClick={() => {
                    void reinService.refreshAgents()
                  }}
                >
                  重试连接
                </button>
              </p>
            )}
            {!data.agents.length && !data.agentError && (
              <p className="hub-roster-empty">
                {data.agentLoading
                  ? '正在读取 Agent…'
                  : '暂无 Agent。请使用 rein agent add 或新建 Agent。'}
              </p>
            )}
            {data.agents.map((agent) => (
              <div className="agent-roster-row" key={agent.id}>
                <ListItemButton
                  component="button"
                  key={agent.id}
                  aria-label={`与${agent.name}对话`}
                  aria-pressed={scope.agentId === agent.id}
                  selected={scope.agentId === agent.id}
                  onClick={() =>
                    onScope({
                      id: `agent-${agent.id}`,
                      title: agent.name,
                      label: 'Agent 对话',
                      agentId: agent.id,
                    })
                  }
                >
                  <AgentAvatar agent={agent} size={20} />
                  <StatusDot online={agent.online} />
                  <span className="agent-roster-identity">
                    <span className="nav-text">{agent.name}</span>
                    <AgentLabels agent={agent} settings={data.workflow?.settings} />
                  </span>
                </ListItemButton>
                <Action
                  label={`${agent.name}设置`}
                  icon="settings"
                  className="agent-settings-action quiet-action"
                  onClick={() => onAgentSettings(agent)}
                />
              </div>
            ))}
          </SidebarRoster>
        </div>
      </div>
      <div className="account-footer">
        <Divider />
        <button
          className="account-button"
          aria-label="个人菜单"
          onClick={(e) => onAccount(e.currentTarget)}
        >
          <AgentAvatar size={24} />
          <span>{userName}</span>
          <Icon name="more" />
        </button>
      </div>
    </aside>
  )
}

export function SidebarRail({
  data,
  scope,
  currentRequirementId,
  onScope,
  onHide,
  onAccount,
}: Props) {
  const requirement = data.requirements.find((r) => r.id === currentRequirementId)
  const actions = [
    {
      label: '当前需求对话',
      title: requirement?.title ?? '此项目暂无需求',
      icon: 'requirement',
      active: scope.id === requirement?.id,
      disabled: !requirement,
      action: () =>
        requirement &&
        onScope({
          id: requirement.id,
          title: requirement.title,
          label: '当前需求',
          projectId: requirement.projectId,
          requirementId: requirement.id,
        }),
    },
  ]
  return (
    <aside className="sidebar-rail" aria-label="窄侧栏">
      <Action label="展开侧栏" icon="collapse" className="sidebar-toggle" onClick={onHide} />
      <nav aria-label="快捷对话">
        {actions.map((item) => (
          <Tooltip key={item.label} title={`${item.label} · ${item.title}`} placement="right">
            <span>
              <IconButton
                aria-label={item.label}
                disabled={item.disabled}
                className={item.active ? 'rail-active' : ''}
                onClick={item.action}
              >
                <Icon name={item.icon} />
              </IconButton>
            </span>
          </Tooltip>
        ))}
      </nav>
      <button
        className="rail-account"
        aria-label="个人菜单"
        onClick={(e) => onAccount(e.currentTarget)}
      >
        <AgentAvatar size={24} />
      </button>
    </aside>
  )
}
