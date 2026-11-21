import { useId, useRef, useState } from 'react'
import { Alert, Button, Dialog, DialogContent, DialogTitle } from '@mui/material'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Action, Icon } from './shared'
import {
  workflowService,
  type Handoff,
  type QueueTask,
  type WorkflowSnapshot,
} from '../services/workflow'

type TaskHandoff = Handoff & { title: string }

function ownHandoffs(task: QueueTask): TaskHandoff[] {
  return task.handoffs.map((handoff) => ({ ...handoff, title: task.title }))
}

function taskHandoffs(task: QueueTask, workflow?: WorkflowSnapshot, file?: string): TaskHandoff[] {
  if (file) return ownHandoffs(task).filter((handoff) => handoff.file === file)
  if (task.role !== 'coding' || !task.spec_id) return ownHandoffs(task)
  const spec = workflow?.specs.find((s) => s.id === task.spec_id)
  const criteria = spec?.plan.tasks.find((t) => t.id === task.plan_id)?.acceptance_ids ?? []
  const reviews =
    workflow?.tasks.filter(
      (t) =>
        t.spec_id === task.spec_id &&
        t.role === 'review' &&
        (t.result?.responsible_task_id === task.id ||
          (task.criterion_id && t.criterion_id === task.criterion_id) ||
          (t.criterion_id && criteria.includes(t.criterion_id))),
    ) ?? []
  return [...ownHandoffs(task), ...reviews.flatMap(ownHandoffs)]
}
export function HandoffLinks({
  task,
  workflow,
  empty,
  file,
  report,
  inline = false,
}: {
  task: QueueTask
  workflow?: WorkflowSnapshot
  empty?: string
  file?: string
  report?: string
  inline?: boolean
}) {
  const [opened, setOpened] = useState<TaskHandoff>()
  const [content, setContent] = useState<string>()
  const [error, setError] = useState('')
  const readerId = useId()
  const requestId = useRef(0)
  const handoffs = taskHandoffs(task, workflow, file)
  if (!handoffs.length) return empty ? <p className="muted">{empty}</p> : null
  function close() {
    requestId.current++
    setOpened(undefined)
  }
  async function open(handoff: TaskHandoff) {
    const request = ++requestId.current
    setOpened(handoff)
    setContent(undefined)
    setError('')
    try {
      const file = await workflowService.file(task.spec_id ?? task.id, handoff.file)
      if (request === requestId.current) setContent(file.content)
    } catch (failure) {
      if (request === requestId.current)
        setError(failure instanceof Error ? failure.message : '无法读取交接文件')
    }
  }
  const body = (
    <>
      <p className="muted handoff-filename">{opened?.file}</p>
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : content === undefined ? (
        <p role="status">正在读取…</p>
      ) : content.trim() ? (
        <div className="sdd-markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      ) : (
        <p className="muted">交接文件为空。</p>
      )}
    </>
  )
  return (
    <>
      <ul className="handoff-links" aria-label="任务交接文件">
        {handoffs.map((handoff, index) => (
          <li key={handoff.file}>
            <button
              type="button"
              aria-haspopup={inline ? undefined : 'dialog'}
              aria-expanded={inline ? opened?.file === handoff.file : undefined}
              aria-controls={inline ? `${readerId}-${index}` : undefined}
              onClick={(event) => {
                event.stopPropagation()
                if (inline && opened?.file === handoff.file) close()
                else void open(handoff)
              }}
            >
              <Icon name="handoff" size={14} />
              {file ? (
                <span>Handoff</span>
              ) : (
                <span>
                  {handoff.kind === 'review'
                    ? 'Review'
                    : handoff.kind === 'repair'
                      ? '返修'
                      : 'Coding'}{' '}
                  Handoff · {handoff.agent_id || '系统'}
                </span>
              )}
              {inline && (
                <span className="hub-activity-chevron">
                  <Icon name="down" size={13} />
                </span>
              )}
            </button>
            {inline && (
              <div
                className="handoff-inline-reader"
                id={`${readerId}-${index}`}
                hidden={opened?.file !== handoff.file}
              >
                {opened?.file === handoff.file && body}
              </div>
            )}
          </li>
        ))}
      </ul>
      {!inline && (
        <Dialog open={!!opened} onClose={close} fullWidth maxWidth="md">
          <DialogTitle className="dialog-title">
            <span className="handoff-dialog-title">
              <Icon name="handoff" size={16} />
              <span>Task Handoff · {opened?.title}</span>
            </span>
            <Action label="关闭交接文件" icon="close" onClick={close} />
          </DialogTitle>
          <DialogContent>
            {body}
            {report && (
              <details className="handoff-full-report">
                <summary>查看完整任务报告</summary>
                <p>{report}</p>
              </details>
            )}
            <Button onClick={close}>关闭</Button>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
