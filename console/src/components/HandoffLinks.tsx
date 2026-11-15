import { useState } from 'react'
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

function taskHandoffs(task: QueueTask, workflow?: WorkflowSnapshot): Handoff[] {
  if (task.role !== 'coding' || !task.spec_id) return task.handoffs
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
  return [...task.handoffs, ...reviews.flatMap((t) => t.handoffs)]
}
export function HandoffLinks({ task, workflow }: { task: QueueTask; workflow?: WorkflowSnapshot }) {
  const [opened, setOpened] = useState<string>()
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const handoffs = taskHandoffs(task, workflow)
  if (!handoffs.length) return null
  async function open(handoff: Handoff) {
    setOpened(handoff.file)
    setContent('')
    setError('')
    try {
      setContent((await workflowService.file(task.spec_id ?? task.id, handoff.file)).content)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取交接文件')
    }
  }
  return (
    <>
      <ul className="handoff-links" aria-label="任务交接文件">
        {handoffs.map((handoff) => (
          <li key={handoff.file}>
            <button
              onClick={(event) => {
                event.stopPropagation()
                void open(handoff)
              }}
            >
              <Icon
                name={
                  handoff.kind === 'review' ? 'shield' : handoff.kind === 'repair' ? 'edit' : 'code'
                }
                size={13}
              />
              <span>
                {handoff.kind === 'review'
                  ? 'Review'
                  : handoff.kind === 'repair'
                    ? '返修'
                    : 'Coding'}{' '}
                Handoff · {handoff.agent_id || '系统'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!opened} onClose={() => setOpened(undefined)} fullWidth maxWidth="md">
        <DialogTitle className="dialog-title">
          Task Handoff
          <Action label="关闭交接文件" icon="close" onClick={() => setOpened(undefined)} />
        </DialogTitle>
        <DialogContent>
          <p className="muted handoff-filename">{opened}</p>
          {error ? (
            <Alert severity="error">{error}</Alert>
          ) : content ? (
            <div className="sdd-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            </div>
          ) : (
            <p>正在读取…</p>
          )}
          <Button onClick={() => setOpened(undefined)}>关闭</Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
