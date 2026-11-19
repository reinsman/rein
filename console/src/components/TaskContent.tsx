import { useState } from 'react'
import { Button, Checkbox, TextField } from '@mui/material'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Task } from '../types'
import type { VerificationCheck } from '../localTypes'
import type { TaskDraft } from '../services/sdd'
import { taskTypeInfo } from '../services/sdd'
import { Action, Icon } from './shared'

export function TaskContent({
  task,
  tasks,
  draft,
  onChange,
}: {
  task: Task
  tasks: Task[]
  draft: TaskDraft
  onChange: (patch: Partial<TaskDraft>) => void
}) {
  const [editing, setEditing] = useState(!draft.document.trim())
  const readOnly = task.status === 'done'
  const [editingDescription, setEditingDescription] = useState(!draft.description.trim())
  const descriptionReadOnly = readOnly || task.queue?.status === 'running'
  const spec = tasks.find(
    (value) => value.requirementId === task.requirementId && value.type === 'spec',
  )
  const criteria = spec?.criteria ?? []
  const documentType = task.type === 'spec' || task.type === 'design' ? task.type : undefined
  return (
    <div className="sdd-task-content">
      {!task.type && (
        <section className="task-description" aria-label="任务说明">
          <div className="sdd-document-toolbar">
            <h3>任务说明</h3>
            {!descriptionReadOnly && (
              <Button onClick={() => setEditingDescription(!editingDescription)}>
                {editingDescription ? '预览说明' : '编辑说明'}
              </Button>
            )}
          </div>
          {editingDescription && !descriptionReadOnly ? (
            <TextField
              multiline
              minRows={6}
              fullWidth
              placeholder="说明任务目标、范围与完成标准，支持 Markdown。"
              value={draft.description}
              onChange={(event) => onChange({ description: event.target.value })}
              slotProps={{ htmlInput: { 'aria-label': '任务说明', maxLength: 12000 } }}
            />
          ) : (
            <div className="sdd-document">
              {draft.description.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{draft.description}</Markdown>
              ) : (
                <p className="muted">尚未填写任务说明。</p>
              )}
            </div>
          )}
          {task.queue?.status === 'running' && (
            <p className="sdd-section-note">任务执行中，可在「Agent 会话」补充指导。</p>
          )}
        </section>
      )}
      {documentType && (
        <>
          <div className="sdd-document-toolbar">
            <span>
              <Icon name="doc" size={14} />
              {taskTypeInfo[documentType].file}
            </span>
            {!readOnly && (
              <div className="sdd-view-switch" aria-label="文档显示方式">
                <Button aria-pressed={editing} onClick={() => setEditing(true)}>
                  编辑
                </Button>
                <Button aria-pressed={!editing} onClick={() => setEditing(false)}>
                  预览
                </Button>
              </div>
            )}
          </div>
          {editing && !readOnly ? (
            <TextField
              fullWidth
              multiline
              minRows={9}
              label={documentType === 'spec' ? '需求规格' : '技术设计'}
              placeholder={
                documentType === 'spec'
                  ? '写下目标、范围、边界条件，支持 Markdown。'
                  : '写下实现边界、接口、数据结构与异常处理，支持 Markdown。'
              }
              value={draft.document}
              onChange={(event) => onChange({ document: event.target.value })}
              slotProps={{ htmlInput: { maxLength: 64000 } }}
            />
          ) : (
            <div className="sdd-document">
              {draft.document.trim() ? (
                <Markdown remarkPlugins={[remarkGfm]}>{draft.document}</Markdown>
              ) : (
                <p className="muted">暂无文档，切换到编辑开始填写。</p>
              )}
            </div>
          )}
        </>
      )}
      {task.type === 'spec' && (
        <section className="sdd-item-section" aria-label="验收标准">
          <div className="sdd-section-heading">
            <h3>验收标准</h3>
            <span>{draft.criteria.length} 条</span>
            <span className="spacer" />
            {!readOnly && (
              <Button
                startIcon={<Icon name="plus" />}
                onClick={() =>
                  onChange({ criteria: [...draft.criteria, { id: crypto.randomUUID(), text: '' }] })
                }
                disabled={draft.criteria.length >= 100}
              >
                添加验收标准
              </Button>
            )}
          </div>
          {!draft.criteria.length && <p className="muted">为预期行为定义可以验证的验收标准。</p>}
          {draft.criteria.map((criterion, index) => (
            <div className="sdd-criterion-row" key={criterion.id}>
              <span className="sdd-item-id">AC-{String(index + 1).padStart(2, '0')}</span>
              {readOnly ? (
                <p>{criterion.text}</p>
              ) : (
                <TextField
                  fullWidth
                  multiline
                  value={criterion.text}
                  placeholder="描述可验证的预期行为"
                  onChange={(event) =>
                    onChange({
                      criteria: draft.criteria.map((item) =>
                        item.id === criterion.id ? { ...item, text: event.target.value } : item,
                      ),
                    })
                  }
                  slotProps={{
                    htmlInput: { 'aria-label': `验收标准 ${index + 1}`, maxLength: 1000 },
                  }}
                />
              )}
              {!readOnly && (
                <Action
                  label={`删除验收标准 ${index + 1}`}
                  icon="close"
                  onClick={() =>
                    onChange({
                      criteria: draft.criteria.filter((item) => item.id !== criterion.id),
                    })
                  }
                />
              )}
            </div>
          ))}
        </section>
      )}
      {task.type === 'design' && (
        <section className="sdd-item-section" aria-label="关联验收标准">
          <div className="sdd-section-heading">
            <h3>关联验收</h3>
            <span>来自已确认的 Spec</span>
          </div>
          {criteria.length ? (
            criteria.map((criterion, index) => (
              <div className="sdd-criterion-row" key={criterion.id}>
                <span className="sdd-item-id">AC-{String(index + 1).padStart(2, '0')}</span>
                <p>{criterion.text}</p>
              </div>
            ))
          ) : (
            <p className="muted">Spec 确认后，在这里查看需要满足的验收标准。</p>
          )}
        </section>
      )}
      {task.type === 'tasks' && (
        <section className="sdd-item-section" aria-label="开发子任务">
          <div className="sdd-section-heading">
            <h3>开发子任务</h3>
            <span>
              {draft.subtasks.filter((item) => item.completed).length} / {draft.subtasks.length}
            </span>
            <span className="spacer" />
            {!readOnly && (
              <Button
                startIcon={<Icon name="plus" />}
                disabled={draft.subtasks.length >= 100}
                onClick={() =>
                  onChange({
                    subtasks: [
                      ...draft.subtasks,
                      { id: crypto.randomUUID(), title: '', completed: false },
                    ],
                  })
                }
              >
                添加子任务
              </Button>
            )}
          </div>
          <p className="sdd-section-note">在这里拆解和记录开发工作。开始任务后可勾选已完成项。</p>
          {!draft.subtasks.length && (
            <p className="muted">还没有开发子任务，先拆解本次需要实现的工作。</p>
          )}
          {draft.subtasks.map((item, index) => (
            <div className={`sdd-subtask-row${item.completed ? ' is-complete' : ''}`} key={item.id}>
              <Checkbox
                checked={item.completed}
                disabled={readOnly || task.status !== 'running' || !item.title.trim()}
                onChange={(event) =>
                  onChange({
                    subtasks: draft.subtasks.map((value) =>
                      value.id === item.id ? { ...value, completed: event.target.checked } : value,
                    ),
                  })
                }
                slotProps={{ input: { 'aria-label': `完成子任务 ${index + 1}` } }}
              />
              {readOnly ? (
                <p>{item.title}</p>
              ) : (
                <TextField
                  fullWidth
                  multiline
                  value={item.title}
                  onChange={(event) =>
                    onChange({
                      subtasks: draft.subtasks.map((value) =>
                        value.id === item.id ? { ...value, title: event.target.value } : value,
                      ),
                    })
                  }
                  placeholder="描述一个可执行的开发子任务"
                  slotProps={{
                    htmlInput: { 'aria-label': `开发子任务 ${index + 1}`, maxLength: 300 },
                  }}
                />
              )}
              {!readOnly && (
                <Action
                  label={`删除开发子任务 ${index + 1}`}
                  icon="close"
                  onClick={() =>
                    onChange({ subtasks: draft.subtasks.filter((value) => value.id !== item.id) })
                  }
                />
              )}
            </div>
          ))}
        </section>
      )}
      {task.type === 'verification' && (
        <section className="sdd-item-section" aria-label="验收验证结果">
          <div className="sdd-section-heading">
            <h3>逐项验收</h3>
            <span>
              {draft.checks.filter((item) => item.status === 'passed').length} / {criteria.length}{' '}
              通过
            </span>
          </div>
          <p className="sdd-section-note">
            记录实际验证结果，并填写测试输出、文件路径或人工检查说明作为证据。
          </p>
          {!criteria.length && <p className="muted">Spec 中的验收标准会在这里逐项展示。</p>}
          {criteria.map((criterion, index) => {
            const check = draft.checks.find((value) => value.criterion_id === criterion.id) ?? {
              criterion_id: criterion.id,
              status: 'pending' as const,
              evidence: '',
            }
            const update = (patch: Partial<VerificationCheck>) =>
              onChange({
                checks: criteria.map((item) =>
                  item.id === criterion.id
                    ? { ...check, ...patch }
                    : (draft.checks.find((value) => value.criterion_id === item.id) ?? {
                        criterion_id: item.id,
                        status: 'pending',
                        evidence: '',
                      }),
                ),
              })
            return (
              <div className="sdd-verification-row" key={criterion.id}>
                <div className="sdd-verification-heading">
                  <span className="sdd-item-id">AC-{String(index + 1).padStart(2, '0')}</span>
                  <p>{criterion.text}</p>
                  <select
                    aria-label={`验收结果 AC-${String(index + 1).padStart(2, '0')}`}
                    value={check.status}
                    disabled={readOnly || task.status !== 'running'}
                    onChange={(event) =>
                      update({ status: event.target.value as VerificationCheck['status'] })
                    }
                    className={`sdd-check-status ${check.status}`}
                  >
                    <option value="pending">待验证</option>
                    <option value="passed">已通过</option>
                    <option value="failed">未通过</option>
                  </select>
                </div>
                {readOnly ? (
                  <p className="sdd-check-evidence">{check.evidence}</p>
                ) : (
                  <TextField
                    multiline
                    minRows={2}
                    fullWidth
                    label={`验证证据 AC-${String(index + 1).padStart(2, '0')}`}
                    placeholder="填写真实验证证据；任务执行结束不等于验收通过。"
                    value={check.evidence}
                    disabled={task.status !== 'running'}
                    onChange={(event) => update({ evidence: event.target.value })}
                    slotProps={{ htmlInput: { maxLength: 4000 } }}
                  />
                )}
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
