import { useId, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Radio,
  IconButton,
} from '@mui/material'
import type { Project, Requirement } from '../types'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'
import { workflowService } from '../services/workflow'

export interface EntityEditor {
  kind: 'project' | 'requirement' | 'spec'
  project?: Project
  requirement?: Requirement
  projectId?: string
}
export function EntityDialog({
  editor,
  onClose,
  onSaved,
}: {
  editor: EntityEditor
  onClose: () => void
  onSaved: (result: {
    kind: 'project' | 'requirement' | 'spec'
    id: string
    projectId: string
    name: string
  }) => void
}) {
  const [name, setName] = useState(
    editor.kind === 'spec' ? '' : (editor.project?.name ?? editor.requirement?.title ?? ''),
  )
  const [description, setDescription] = useState(
    editor.kind === 'spec'
      ? ''
      : (editor.project?.description ?? editor.requirement?.description ?? ''),
  )
  const [directories, setDirectories] = useState(editor.project?.directories ?? [])
  const [preferred, setPreferred] = useState(() =>
    Math.max(
      0,
      editor.project?.directories?.indexOf(editor.project.preferred_directory ?? '') ?? 0,
    ),
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const fieldId = useId()
  const project = editor.kind === 'project'
  const editing = editor.kind !== 'spec' && !!(editor.project || editor.requirement)
  const title = `${editing ? '编辑' : '新建'}${project ? '项目' : editor.kind === 'spec' ? 'Spec' : '需求'}`
  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      className="entity-dialog"
      aria-labelledby={`${fieldId}-title`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setSaving(true)
          setError('')
          try {
            if (editor.kind === 'spec') {
              const { spec } = await workflowService.createSpec(
                editor.requirement!.id,
                name,
                description,
              )
              await reinService.refreshWorkflow()
              onSaved({ kind: 'spec', id: spec.id, projectId: editor.projectId!, name: spec.title })
            } else if (project) {
              const result = await reinService.saveProject({
                id: editor.project?.id,
                name,
                description,
                directories,
                preferred_directory: directories[preferred] ?? null,
              })
              onSaved({ kind: 'project', id: result.id, projectId: result.id, name: result.name })
            } else {
              const result = await reinService.saveRequirement(editor.projectId!, {
                id: editor.requirement?.id,
                name,
                description,
              })
              onSaved({
                kind: 'requirement',
                id: result.id,
                projectId: result.projectId,
                name: result.title,
              })
            }
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setSaving(false)
          }
        }}
      >
        <DialogTitle className="dialog-title" id={`${fieldId}-title`}>
          {title}
          <Action label={`关闭${title}`} icon="close" onClick={onClose} />
        </DialogTitle>
        <DialogContent className="entity-fields">
          <div className="entity-field">
            <label htmlFor={`${fieldId}-name`}>
              {project ? '项目名称' : editor.kind === 'spec' ? 'Spec 名称' : '需求名称'}
            </label>
            <TextField
              id={`${fieldId}-name`}
              placeholder={project ? '输入项目名称' : '输入需求名称'}
              autoFocus
              required
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 80 } }}
            />
          </div>
          <div className="entity-field">
            <label htmlFor={`${fieldId}-description`}>描述</label>
            <TextField
              id={`${fieldId}-description`}
              placeholder={project ? '简要描述项目目标…' : '简要描述需求目标…'}
              multiline
              minRows={3}
              fullWidth
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 1000 } }}
            />
          </div>
          {project && (
            <div className="entity-field">
              <div className="project-directory-heading">
                <label id={`${fieldId}-directories`}>工作目录</label>
                <Button
                  disabled={saving}
                  startIcon={<Icon name="plus" />}
                  onClick={() => setDirectories((previous) => [...previous, ''])}
                >
                  添加工作目录
                </Button>
              </div>
              <p className="project-directory-note">
                填写本机绝对路径，第一个目录默认为首选，可点击圆点切换。
              </p>
              <div
                className="project-directory-list"
                role="radiogroup"
                aria-labelledby={`${fieldId}-directories`}
              >
                {directories.map((directory, index) => (
                  <div className="project-directory-row" key={index}>
                    <Radio
                      size="small"
                      name={`${fieldId}-preferred`}
                      checked={preferred === index}
                      onChange={() => setPreferred(index)}
                      disabled={saving}
                      slotProps={{ input: { 'aria-label': `首选工作目录 ${index + 1}` } }}
                    />
                    <TextField
                      required
                      fullWidth
                      disabled={saving}
                      placeholder="/Users/you/project"
                      value={directory}
                      onChange={(e) =>
                        setDirectories((previous) =>
                          previous.map((value, i) => (i === index ? e.target.value : value)),
                        )
                      }
                      slotProps={{ htmlInput: { 'aria-label': `工作目录 ${index + 1}` } }}
                    />
                    <IconButton
                      aria-label={`移除工作目录 ${index + 1}`}
                      disabled={saving}
                      onClick={() => {
                        setDirectories((previous) => previous.filter((_, i) => i !== index))
                        setPreferred((previous) =>
                          previous === index ? 0 : previous > index ? previous - 1 : previous,
                        )
                      }}
                    >
                      <Icon name="close" />
                    </IconButton>
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions className="entity-actions">
          <Button variant="outlined" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="contained" disabled={saving || !name.trim()}>
            {saving ? '正在保存…' : editing ? '保存' : '创建'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
