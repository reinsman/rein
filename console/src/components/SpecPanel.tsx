import { useEffect, useRef, useState } from 'react'
import { Alert, Button, TextField } from '@mui/material'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppData } from '../types'
import { phaseLabels, workflowService, type Spec } from '../services/workflow'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'
import { HandoffLinks } from './HandoffLinks'

const files = ['requirements.md', 'design.md', 'tasks.md']
export function SpecPanel({
  spec,
  data,
  onTask,
  onSettings,
  notify,
  onDirtyChange,
}: {
  spec: Spec
  data: AppData
  onTask: (id: string) => void
  onSettings: () => void
  notify: (message: string) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [tab, setTab] = useState(0)
  const [document, setDocument] = useState('')
  const [plan, setPlan] = useState(spec.plan)
  const [editing, setEditing] = useState(false)
  const [taskDocument, setTaskDocument] = useState(false)
  const [dirty, setDirty] = useState(false)
  const baseline = useRef({ document: '', plan: '' })
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const planning = ['requirements', 'design', 'tasks'].includes(spec.phase)
  const editable = planning && ['requirements', 'design', 'tasks'][tab] === spec.phase
  const queue = data.workflow?.tasks.filter((task) => task.spec_id === spec.id) ?? []
  const coding = queue.filter((task) => task.role === 'coding')
  const reviews = queue.filter((task) => task.role === 'review' && task.round === spec.round)
  useEffect(() => {
    let disposed = false
    let first = true
    async function load() {
      if (dirty || saving || tab === 3) return
      if (first) setLoading(true)
      try {
        const [file, manifest] = await Promise.all([
          workflowService.file(spec.id, files[tab]),
          workflowService.file(spec.id, 'plan.json'),
        ])
        if (disposed) return
        const parsed = JSON.parse(manifest.content) as Spec['plan']
        if (!Array.isArray(parsed.criteria) || !Array.isArray(parsed.tasks))
          throw new Error('Spec 任务清单格式无效，请让主 Agent 修正 plan.json。')
        setDocument(file.content)
        setPlan(parsed)
        baseline.current = { document: file.content, plan: manifest.content }
        setError('')
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : '读取文档失败')
      } finally {
        first = false
        if (!disposed) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 2500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [spec.id, tab, dirty, saving])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  async function save() {
    setSaving(true)
    setError('')
    try {
      await workflowService.saveFile(spec.id, files[tab], document, baseline.current.document)
      await workflowService.saveFile(
        spec.id,
        'plan.json',
        JSON.stringify(plan, null, 2),
        baseline.current.plan,
      )
      setDirty(false)
      notify('Spec 草稿已保存')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }
  async function action(value: string) {
    setSaving(true)
    setError('')
    try {
      await workflowService.specAction(spec.id, value)
      await reinService.refreshWorkflow()
      notify(
        value === 'build'
          ? '已开始顺序构建，首个任务进入待开始'
          : value === 'submit_verification'
            ? '已提交顺序验收'
            : '工作流状态已更新',
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败')
    } finally {
      setSaving(false)
    }
  }
  function chooseTab(next: number) {
    if (dirty && !window.confirm('当前文档尚未保存，放弃更改并切换？')) return
    setDirty(false)
    setEditing(false)
    setTaskDocument(false)
    setTab(next)
  }
  const primary: Partial<Record<Spec['phase'], [string, string]>> = {
    requirements: ['approve_requirements', '确认需求，继续设计'],
    design: ['approve_design', '确认设计，拆分任务'],
    tasks: ['build', '开始构建'],
    ready_verification: ['submit_verification', '提交验证'],
    ready_complete: ['complete', '完成验证'],
  }
  const next = primary[spec.phase]
  const rows = [
    ...(planning ? plan.tasks : spec.plan.tasks).map((item) => ({
      id: item.id,
      title: item.title,
      task: coding.find((task) => task.plan_id === item.id),
    })),
    ...coding
      .filter((task) => !task.plan_id)
      .map((task) => ({ id: task.id, title: task.title, task })),
  ]
  return (
    <section className="task-panel spec-panel" aria-label="Spec 工作区">
      <header className="panel-header">
        <Icon name="spec" size={20} />
        <h2>Spec</h2>
        <span className="spacer" />
        <span className="spec-phase-status">
          {phaseLabels[spec.phase]}
          {spec.paused ? ' · 已暂停' : ''}
        </span>
        <Action label="Spec 工作流配置" icon="settings" onClick={onSettings} />
      </header>
      <div className="spec-stage-tabs" role="tablist" aria-label="Spec 阶段">
        {['需求', '设计', '任务', '验证'].map((label, index) => (
          <button
            key={label}
            role="tab"
            aria-selected={tab === index}
            onClick={() => chooseTab(index)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="spec-document-toolbar">
        <span>{tab === 3 ? '验收记录' : files[tab]}</span>
        <span className="spacer" />
        {tab === 2 ? (
          <>
            <Button
              size="small"
              variant={!taskDocument ? 'contained' : 'text'}
              onClick={() => setTaskDocument(false)}
            >
              任务进度
            </Button>
            <Button
              size="small"
              variant={taskDocument ? 'contained' : 'text'}
              onClick={() => setTaskDocument(true)}
            >
              tasks.md
            </Button>
            {taskDocument && editable && (
              <Button size="small" onClick={() => setEditing(!editing)}>
                {editing ? '预览' : '编辑'}
              </Button>
            )}
          </>
        ) : tab < 2 ? (
          <>
            <Button size="small" disabled={!editable} onClick={() => setEditing(true)}>
              编辑
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>
              预览
            </Button>
          </>
        ) : null}
      </div>
      <div className="spec-panel-body">
        {spec.phase === 'building' && !data.workflow?.settings.coding_agents.length && (
          <Alert severity="info" action={<Button onClick={onSettings}>配置</Button>}>
            首个任务已排入 Todo。请配置 Coding Agent 后执行。
          </Alert>
        )}
        {spec.phase === 'verifying' && !data.workflow?.settings.review_agents.length && (
          <Alert severity="info" action={<Button onClick={onSettings}>配置</Button>}>
            验收任务等待 Review Agent，请先配置对应角色。
          </Alert>
        )}
        {(error || spec.error || data.workflowError) && (
          <Alert severity="error">{error || spec.error || data.workflowError}</Alert>
        )}
        {data.workflow && !data.workflow.settings.main_agent && (
          <Alert severity="info" action={<Button onClick={onSettings}>配置</Button>}>
            请配置主 Agent；Coding 和 Review Agent 分别领取对应任务。
          </Alert>
        )}
        {tab < 3 && (tab !== 2 || taskDocument) ? (
          <>
            {loading ? (
              <p className="muted">正在读取文档…</p>
            ) : editing && editable ? (
              <TextField
                aria-label="Spec 文档"
                multiline
                minRows={12}
                fullWidth
                value={document}
                disabled={saving}
                onChange={(event) => {
                  setDocument(event.target.value)
                  setDirty(true)
                }}
              />
            ) : document ? (
              <div className="sdd-markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{document}</Markdown>
              </div>
            ) : (
              <div className="spec-empty">
                <Icon name="spec" size={28} />
                <p>在对话中与主 Agent 编写{['需求', '设计', '任务'][tab]}文档</p>
                <span>使用 rein-spec skill，或描述目标与预期行为。</span>
              </div>
            )}
            {editable && editing && tab === 0 && (
              <div className="spec-plan-editor">
                <h3>验收标准</h3>
                {plan.criteria.map((criterion, index) => (
                  <TextField
                    key={criterion.id}
                    label={criterion.id}
                    value={criterion.text}
                    fullWidth
                    multiline
                    onChange={(event) => {
                      setPlan({
                        ...plan,
                        criteria: plan.criteria.map((c, i) =>
                          i === index ? { ...c, text: event.target.value } : c,
                        ),
                      })
                      setDirty(true)
                    }}
                  />
                ))}
                <Button
                  onClick={() => {
                    setPlan({
                      ...plan,
                      criteria: [
                        ...plan.criteria,
                        { id: `AC-${crypto.randomUUID().slice(0, 8)}`, text: '' },
                      ],
                    })
                    setDirty(true)
                  }}
                >
                  添加验收标准
                </Button>
              </div>
            )}
            {editable && editing && tab === 2 && (
              <div className="spec-plan-editor">
                <h3>顺序开发任务</h3>
                {plan.tasks.map((task, index) => (
                  <TextField
                    key={task.id}
                    label={`任务 ${index + 1}`}
                    value={task.title}
                    fullWidth
                    onChange={(event) => {
                      setPlan({
                        ...plan,
                        tasks: plan.tasks.map((t, i) =>
                          i === index ? { ...t, title: event.target.value } : t,
                        ),
                      })
                      setDirty(true)
                    }}
                  />
                ))}
                <Button
                  onClick={() => {
                    setPlan({
                      ...plan,
                      tasks: [
                        ...plan.tasks,
                        {
                          id: `T-${crypto.randomUUID().slice(0, 8)}`,
                          title: '',
                          description: '',
                          acceptance_ids: plan.criteria.map((c) => c.id),
                        },
                      ],
                    })
                    setDirty(true)
                  }}
                >
                  添加任务
                </Button>
              </div>
            )}
          </>
        ) : tab === 2 ? (
          <>
            <div className="spec-progress-heading">
              <strong>
                开发任务 {coding.filter((task) => task.status === 'done').length} / {rows.length}{' '}
                已完成
              </strong>
              <span>顺序执行</span>
            </div>
            <progress
              max={Math.max(rows.length, 1)}
              value={coding.filter((task) => task.status === 'done').length}
            />
            {rows.map(({ id, title, task }, index) => (
              <div className="spec-task-item" key={id}>
                <div className="spec-task-main">
                  <span>{index + 1}.</span>
                  <button disabled={!task} onClick={() => task && onTask(task.id)}>
                    {title}
                  </button>
                  <span className="spec-task-label">
                    {task?.status === 'done'
                      ? '已完成'
                      : task?.status === 'running'
                        ? '进行中'
                        : task?.paused
                          ? '已暂停'
                          : task
                            ? '待开始'
                            : '待前项完成'}
                  </span>
                </div>
                {task && (
                  <>
                    <div className="spec-task-controls">
                      <Button
                        size="small"
                        disabled={saving || task.status === 'done'}
                        onClick={() =>
                          void workflowService
                            .taskAction(task.id, task.status === 'running' ? 'stop' : 'start')
                            .then(() => reinService.refreshWorkflow())
                            .catch((failure) => setError(String(failure)))
                        }
                      >
                        {task.status === 'running' ? '停止' : '开始'}
                      </Button>
                      {task.error && <span className="error-text">{task.error}</span>}
                    </div>
                    <HandoffLinks task={task} workflow={data.workflow} />
                  </>
                )}
              </div>
            ))}
            {!rows.length && <p className="muted">任务清单尚未生成。</p>}
          </>
        ) : (
          <>
            <h3>逐项验收</h3>
            <p className="muted">Review Agent 逐项验证；失败后先返修，再开始新一轮验收。</p>
            {spec.plan.criteria.map((criterion) => {
              const task = reviews.find((task) => task.criterion_id === criterion.id)
              return (
                <div className="spec-task-item" key={criterion.id}>
                  <div className="spec-task-main">
                    <span>{criterion.id}</span>
                    <button disabled={!task} onClick={() => task && onTask(task.id)}>
                      {criterion.text}
                    </button>
                    <span className="spec-task-label">
                      {task?.result?.outcome === 'passed'
                        ? '通过'
                        : task?.result?.outcome === 'failed'
                          ? '未通过'
                          : task?.status === 'running'
                            ? '验证中'
                            : task
                              ? '待开始'
                              : '未提交'}
                    </span>
                  </div>
                  {task?.result && <p>{task.result.evidence}</p>}
                  {task && <HandoffLinks task={task} workflow={data.workflow} />}
                </div>
              )
            })}
          </>
        )}
      </div>
      <footer className="detail-footer spec-footer">
        <span className="muted" title={`Spec 产物目录：${spec.directory}`}>
          {dirty
            ? '有未保存的更改'
            : spec.phase === 'tasks'
              ? '首个任务进入 Todo，完成后再提交下一项'
              : spec.phase === 'complete'
                ? '验收已完成'
                : spec.phase === 'repairing'
                  ? '返修完成后重新验收'
                  : spec.phase === 'verifying'
                    ? 'Review Agent 正在逐项验收'
                    : spec.phase === 'building'
                      ? '按顺序提交至需求 Todo'
                      : '文档保存在本机 Spec 目录'}
        </span>
        <div className="detail-controls">
          {dirty && (
            <Button disabled={saving} onClick={() => void save()}>
              保存草稿
            </Button>
          )}
          {!planning && spec.phase !== 'complete' && (
            <Button disabled={saving} onClick={() => void action(spec.paused ? 'resume' : 'pause')}>
              {spec.paused ? '继续自动执行' : '暂停流程'}
            </Button>
          )}
          {next && (
            <Button
              variant="contained"
              disabled={saving || dirty}
              onClick={() => void action(next[0])}
            >
              {next[1]}
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
