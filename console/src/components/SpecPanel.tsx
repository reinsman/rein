import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material'
import { Check, LoaderCircle } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppData } from '../types'
import {
  phaseLabels,
  planningConfirmations,
  workflowService,
  type Spec,
} from '../services/workflow'
import { reinService } from '../services/reinService'
import { preferencesService } from '../services/preferences'
import { request } from '../services/localService'
import { Action, Icon } from './shared'
import { HandoffLinks } from './HandoffLinks'
import { NodeStatus } from './NodeStatus'

const files = ['requirements.md', 'design.md', 'tasks.md']
const phaseTab = (phase: Spec['phase']) =>
  phase === 'requirements'
    ? 0
    : phase === 'design'
      ? 1
      : ['tasks', 'building', 'ready_verification', 'repairing'].includes(phase)
        ? 2
        : 3
export function SpecPanel({
  spec,
  agentRunning,
  data,
  onTask,
  onSettings,
  notify,
  onDirtyChange,
}: {
  spec: Spec
  agentRunning: boolean
  data: AppData
  onTask: (id: string) => void
  onSettings: () => void
  notify: (message: string) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [progress, setProgress] = useState<{
    phase: Spec['phase']
    decisions: unknown[]
    blocking: string | null
    context: { template: Spec['kind'] }
  }>()
  const phase =
    progress && ['requirements', 'design', 'tasks'].includes(progress.phase)
      ? progress.phase
      : spec.phase
  const [savedView] = useState(() => preferencesService.specView(spec.id))
  const [selection, setSelection] = useState({
    phase: savedView?.phase ?? phase,
    tab: savedView?.tab ?? phaseTab(phase),
  })
  const [document, setDocument] = useState('')
  const [plan, setPlan] = useState(spec.plan)
  const [documents, setDocuments] = useState(
    files.map(() => ({ generated: false, confirmed: false })),
  )
  const [transition, setTransition] = useState<{ action: string; name: string } | null>(null)
  const pendingReview = useRef<{ name: string; id: string } | null>(null)
  const [reviewRun, setReviewRun] = useState<{ id?: string } | null>(null)
  const reviewFailed = useRef(false)
  const reviewPending = !!reviewRun
  const [editMode, setEditMode] = useState({ phase: phase, active: false })
  const [dirty, setDirty] = useState(false)
  const editing = editMode.active && (editMode.phase === phase || dirty)
  function setEditing(active: boolean) {
    setEditMode({ phase: phase, active })
  }
  const [taskView, setTaskView] = useState({
    phase: savedView?.phase ?? phase,
    document: false,
  })
  const tab = dirty || selection.phase === phase ? selection.tab : phaseTab(phase)
  const taskDocument = taskView.phase === phase && taskView.document
  useEffect(() => {
    preferencesService.setSpecView(spec.id, { phase: phase, tab })
  }, [spec.id, phase, tab])
  function setTaskDocument(document: boolean) {
    setTaskView({ phase: phase, document })
  }
  const actionRequest = useRef<{ action: string; id: string } | null>(null)
  const baseline = useRef('')
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const planning = ['requirements', 'design', 'tasks'].includes(phase)
  const reviewRequested =
    progress?.phase === phase && progress.blocking === `User review of ${files[phaseTab(phase)]}`
  const currentDocumentReady = documents[phaseTab(phase)]?.generated
  const awaitingReview = reviewRequested && currentDocumentReady && !spec.error && !reviewPending
  const planningStatus = spec.error
    ? spec.error.startsWith('主 Agent 执行')
      ? '已中断'
      : '需要处理'
    : agentRunning || reviewPending
      ? '处理中'
      : progress?.phase !== phase
        ? '读取状态中'
        : reviewRequested && !currentDocumentReady
          ? '文档未就绪'
          : awaitingReview
            ? '待确认'
            : progress.blocking
              ? '等待补充信息'
              : '编写中'
  const editable = tab < 3 && (!planning || tab <= phaseTab(phase))
  const queue = data.workflow?.tasks.filter((task) => task.spec_id === spec.id) ?? []
  const coding = queue.filter((task) => task.role === 'coding')
  const reviews = queue.filter((task) => task.role === 'review' && task.round === spec.round)
  useEffect(() => {
    let disposed = false
    let first = true
    async function load() {
      if (dirty || saving) return
      if (first) setLoading(true)
      try {
        const [loaded, parsed, progress, review] = await Promise.allSettled([
          Promise.all(
            files.map((name) =>
              workflowService
                .file(spec.id, name)
                .catch((error) => ({ content: '', confirmed: false, error: String(error) })),
            ),
          ),
          workflowService.plan(spec.id),
          workflowService.file(spec.id, '.spec-state.json'),
          reviewRun?.id
            ? request<{ run: { state: string; error?: string } }>(`/api/runs/${reviewRun.id}`)
            : Promise.resolve(null),
        ])
        if (disposed) return
        if (review.status === 'fulfilled' && review.value?.run.state === 'completed') {
          setReviewRun(null)
          pendingReview.current = null
          reviewFailed.current = false
        } else if (
          review.status === 'fulfilled' &&
          ['failed', 'cancelled'].includes(review.value?.run.state ?? '')
        ) {
          reviewFailed.current = true
          setError(
            `文档已保存，审阅未完成：${review.value?.run.error || review.value?.run.state}，请重试。`,
          )
        }
        const failures: string[] = []
        if (loaded.status === 'fulfilled') {
          setDocuments(
            loaded.value.map((file) => ({
              generated: !!file.content.trim(),
              confirmed: file.confirmed,
            })),
          )
          if (tab < 3) {
            setDocument(loaded.value[tab].content)
            baseline.current = loaded.value[tab].content
            const selected = loaded.value[tab]
            if ('error' in selected) failures.push(selected.error)
          }
        } else {
          setDocument('')
          failures.push(String(loaded.reason))
        }
        if (parsed.status === 'fulfilled') setPlan(parsed.value)
        else {
          setPlan({ criteria: [], tasks: [] })
          if (tab === 2) failures.push(String(parsed.reason))
        }
        setProgress(undefined)
        if (progress.status === 'rejected') throw progress.reason
        const status = JSON.parse(progress.value.content)
        if (
          !status ||
          typeof status.phase !== 'string' ||
          !Array.isArray(status.decisions) ||
          !['feature', 'bugfix'].includes(status.context?.template) ||
          (status.blocking != null && typeof status.blocking !== 'string')
        )
          throw new Error('规划状态格式无效，请让主 Agent 修正后重试。')
        setProgress(status)
        setLoadError(failures.join('；'))
      } catch (failure) {
        if (!disposed) setLoadError(failure instanceof Error ? failure.message : '读取文档失败')
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
  }, [spec.id, phase, tab, dirty, saving, reviewRun?.id])
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
      await workflowService.saveFile(spec.id, files[tab], document, baseline.current)
      const changed = baseline.current !== document
      baseline.current = document
      setDirty(false)
      setEditing(false)
      if (changed) {
        pendingReview.current = { name: files[tab], id: crypto.randomUUID() }
        await reviewSavedDocument()
      }
      notify('文档已保存，主 Agent 将在对应阶段审阅')
    } catch (failure) {
      setError(
        `${pendingReview.current ? '文档已保存，但主 Agent 尚未完成审阅：' : ''}${failure instanceof Error ? failure.message : '保存失败'}`,
      )
    } finally {
      setSaving(false)
    }
  }
  async function reviewSavedDocument() {
    const request = pendingReview.current
    if (!request) return
    setReviewRun({})
    reviewFailed.current = false
    const response = await workflowService.chat(
      spec.id,
      `我手动修改并保存了 ${request.name}。请先读取改动，回到对应阶段审阅并澄清产品问题；没有问题后询问我是否进入下一阶段。不要把保存当作确认，不要覆盖我的修改或提前修改后续文档。`,
      request.id,
      { edited_document: request.name },
    )
    setReviewRun({ id: response.run.id })
    await reinService.refreshWorkflow()
  }
  async function action(value: string, choice?: 'modify' | 'keep') {
    setSaving(true)
    setError('')
    try {
      if (value === 'retry_planning' && pendingReview.current) {
        if (spec.error || reviewFailed.current) pendingReview.current.id = crypto.randomUUID()
        await reviewSavedDocument()
        return
      }
      const prompt =
        planningConfirmations[value] ||
        (value === 'retry_planning'
          ? '上一轮规划已中断或未通过校验。请读取当前文档和 .spec-state.json，恢复上一轮正在修改的阶段，完成审阅和澄清后询问是否进入下一阶段，不跳过确认。'
          : undefined)
      if (prompt) {
        const key = `${value}:${choice ?? ''}`
        if (actionRequest.current?.action !== key)
          actionRequest.current = { action: key, id: crypto.randomUUID() }
        await workflowService.chat(
          spec.id,
          prompt,
          actionRequest.current.id,
          choice ? { next_document: choice } : undefined,
        )
      } else await workflowService.specAction(spec.id, value)
      await reinService.refreshWorkflow()
      actionRequest.current = null
      setTransition(null)
      notify(
        prompt
          ? '已发送确认，等待主 Agent 更新文档和状态'
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
    setSelection({ phase: phase, tab: next })
  }
  const primary: Partial<Record<Spec['phase'], [string, string]>> = {
    requirements: ['approve_requirements', '确认需求，继续设计'],
    design: ['approve_design', '确认设计，拆分任务'],
    tasks: ['build', '开始构建'],
    ready_verification: ['submit_verification', '提交验证'],
    ready_complete: ['complete', '完成验证'],
  }
  const next = primary[phase]
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
        <NodeStatus specId={spec.id} source />
        <span className="spacer" />
        <span className="spec-phase-status">
          {phaseLabels[phase]}
          {planning ? ` · ${planningStatus}` : ''}
          {spec.paused ? ' · 已暂停' : ''}
        </span>
        <Action label="Spec 工作流配置" icon="settings" onClick={onSettings} />
      </header>
      <div className="spec-stage-tabs" role="tablist" aria-label="Spec 阶段">
        {['需求', '设计', '任务', '验证'].map((label, index) => {
          const current = phase !== 'complete' && index === phaseTab(phase)
          const state = current
            ? 'current'
            : documents[index]?.generated
              ? documents[index].confirmed
                ? 'confirmed'
                : 'generated'
              : undefined
          const status =
            state && { current: '进行中', confirmed: '已确认', generated: '已生成' }[state]
          return (
            <button
              key={label}
              role="tab"
              aria-label={label}
              aria-description={status}
              aria-current={current ? 'step' : undefined}
              aria-selected={tab === index}
              onClick={() => chooseTab(index)}
            >
              {state && (
                <span className={`spec-document-state ${state}`} title={status} aria-label={status}>
                  {current ? (
                    <LoaderCircle
                      size={13}
                      className={agentRunning ? 'spin' : undefined}
                      aria-hidden="true"
                    />
                  ) : state === 'confirmed' ? (
                    <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  ) : null}
                </span>
              )}
              {label}
            </button>
          )
        })}
      </div>
      <div className="spec-document-toolbar">
        <span>{tab === 3 ? '验收记录' : files[tab]}</span>
        <span className="spacer" />
        {tab === 2 && (
          <Button
            size="small"
            variant={!taskDocument ? 'contained' : 'text'}
            onClick={() => setTaskDocument(false)}
          >
            任务进度
          </Button>
        )}
        {editable && (
          <>
            <Button
              size="small"
              disabled={loading || saving || (dirty && agentRunning)}
              onClick={() => {
                if (tab === 2) setTaskDocument(true)
                if (dirty) void save()
                else setEditing(true)
              }}
            >
              {dirty ? '保存' : '编辑'}
            </Button>
            {dirty && (
              <Button
                size="small"
                disabled={saving}
                onClick={() => {
                  setDocument(baseline.current)
                  setDirty(false)
                  setEditing(false)
                }}
              >
                取消
              </Button>
            )}
          </>
        )}
        {tab < 3 && (
          <Button
            size="small"
            onClick={() => {
              if (tab === 2) setTaskDocument(true)
              setEditing(false)
            }}
          >
            预览
          </Button>
        )}
      </div>
      <div className="spec-panel-body">
        {planning && tab === phaseTab(phase) && progress?.phase === phase && (
          <p className="spec-planning-status" role="status">
            {awaitingReview
              ? '当前文档已就绪，可在对话中确认或提出修改，也可点击下方确认按钮。'
              : reviewRequested && !currentDocumentReady
                ? '当前阶段文档尚未生成，请在对话中让主 Agent 继续编写。'
                : progress.blocking || '在对话中补充信息，与主 Agent 完成当前阶段。'}
          </p>
        )}
        {phase === 'building' && !data.workflow?.settings.coding_agents.length && (
          <Alert severity="info" action={<Button onClick={onSettings}>配置</Button>}>
            首个任务已排入 Todo。请配置 Coding Agent 后执行。
          </Alert>
        )}
        {phase === 'verifying' && !data.workflow?.settings.review_agents.length && (
          <Alert severity="info" action={<Button onClick={onSettings}>配置</Button>}>
            验收任务等待 Review Agent，请先配置对应角色。
          </Alert>
        )}
        {(error || loadError || spec.error || data.workflowError) && (
          <Alert
            severity="error"
            action={
              (planning && spec.error) || (pendingReview.current && reviewPending) ? (
                <Button
                  sx={{ whiteSpace: 'nowrap' }}
                  disabled={saving || dirty || agentRunning}
                  onClick={() => void action('retry_planning')}
                >
                  继续当前阶段
                </Button>
              ) : undefined
            }
          >
            {error || loadError || spec.error || data.workflowError}
          </Alert>
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
            {rows.map(({ id, title, task }, index) => {
              const paused = task?.status === 'todo' && task.paused
              const control = task && (
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
                  {paused ? '重试任务' : task.status === 'running' ? '停止' : '开始'}
                </Button>
              )
              return (
                <div className="spec-task-item" key={id}>
                  <div className="spec-task-main">
                    <span>{index + 1}.</span>
                    <button disabled={!task} onClick={() => task && onTask(task.id)}>
                      {title}
                    </button>
                    {task && <NodeStatus taskId={task.id} source />}
                    <span className="spec-task-status">
                      <span className="spec-task-label">
                        {task?.status === 'done'
                          ? '已完成'
                          : task?.status === 'running'
                            ? '进行中'
                            : paused
                              ? '已暂停'
                              : task
                                ? '待开始'
                                : '未提交'}
                      </span>
                      {paused && control}
                    </span>
                  </div>
                  {!task && (
                    <Button
                      size="small"
                      disabled={saving || !['building', 'repairing'].includes(phase)}
                      onClick={() =>
                        void workflowService
                          .submitTask(spec.id, id)
                          .then(() => reinService.refreshWorkflow())
                          .catch((failure) => setError(String(failure)))
                      }
                    >
                      提交到 Todo
                    </Button>
                  )}
                  {task && (
                    <>
                      {(!paused || task.error) && (
                        <div className="spec-task-controls">
                          {!paused && control}
                          {task.error && <span className="error-text">{task.error}</span>}
                        </div>
                      )}
                      <HandoffLinks task={task} workflow={data.workflow} />
                    </>
                  )}
                </div>
              )
            })}
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
                    {task && <NodeStatus taskId={task.id} source />}
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
            : phase === 'tasks'
              ? '首个任务进入 Todo，完成后再提交下一项'
              : phase === 'complete'
                ? '验收已完成'
                : phase === 'repairing'
                  ? '返修完成后重新验收'
                  : phase === 'verifying'
                    ? 'Review Agent 正在逐项验收'
                    : phase === 'building'
                      ? '按顺序提交至需求 Todo'
                      : '文档保存在本机 Spec 目录'}
        </span>
        <div className="detail-controls">
          {!planning && phase !== 'complete' && (
            <Button disabled={saving} onClick={() => void action(spec.paused ? 'resume' : 'pause')}>
              {spec.paused ? '继续自动执行' : '暂停流程'}
            </Button>
          )}
          {next && (
            <Button
              variant="contained"
              disabled={saving || dirty || agentRunning || (planning && !awaitingReview)}
              onClick={() => {
                const index = phaseTab(phase)
                if (planning && index < 2 && documents[index + 1].generated)
                  setTransition({ action: next[0], name: files[index + 1] })
                else void action(next[0])
              }}
            >
              {next[1]}
            </Button>
          )}
        </div>
      </footer>
      <Dialog
        open={!!transition}
        onClose={() => !saving && setTransition(null)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="spec-transition-title"
      >
        <DialogTitle id="spec-transition-title">下一阶段文档已存在</DialogTitle>
        <DialogContent>
          {transition?.name} 已生成。是否让主 Agent
          根据当前阶段的修改更新它，再进入下一阶段？直接进入会保留该文档原样，不会自动修改更后面的产物或重跑作业。
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setTransition(null)}>
            取消
          </Button>
          <Button
            disabled={saving || agentRunning}
            onClick={() => transition && void action(transition.action, 'keep')}
          >
            不修改，直接进入
          </Button>
          <Button
            variant="contained"
            disabled={saving || agentRunning}
            onClick={() => transition && void action(transition.action, 'modify')}
          >
            修改后进入
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  )
}
