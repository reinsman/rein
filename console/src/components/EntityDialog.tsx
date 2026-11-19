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
  ListItemButton,
} from '@mui/material'
import type { Project, Requirement } from '../types'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'
import { workflowService } from '../services/workflow'
import type { SpecKind } from '../services/workflow'
import { Sparkles, Wrench } from 'lucide-react'

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
  const [specKind, setSpecKind] = useState<SpecKind>('feature')
  const [category, setCategory] = useState(0)
  const fieldId = useId()
  const project = editor.kind === 'project'
  const editing = editor.kind !== 'spec' && !!(editor.project || editor.requirement)
  const title = `${editing ? '编辑' : '新建'}${project ? '项目' : editor.kind === 'spec' ? 'Spec' : '需求'}`
  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth={project ? false : editor.kind === 'spec' ? 'sm' : 'xs'}
      className={
        project
          ? 'settings-dialog project-config-dialog'
          : `entity-dialog ${editor.kind === 'spec' ? 'spec-builder-dialog' : ''}`
      }
      slotProps={
        project
          ? {
              paper: {
                sx: {
                  width: 1040,
                  maxWidth: 'calc(100vw - 32px)',
                  height: 720,
                  maxHeight: 'calc(100dvh - 32px)',
                  margin: 2,
                },
              },
            }
          : undefined
      }
      aria-labelledby={`${fieldId}-title`}
    >
      <form
        className={project ? 'project-config-form' : undefined}
        noValidate={project}
        onSubmit={async (e) => {
          e.preventDefault()
          if (project && directories.some((directory) => !directory.trim())) {
            setCategory(1)
            setError('请填写工作目录，或移除空白目录。')
            return
          }
          setSaving(true)
          setError('')
          try {
            if (editor.kind === 'spec') {
              const { spec } = await workflowService.createSpec(
                editor.requirement!.id,
                name,
                description,
                specKind,
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
        <DialogTitle
          className={project ? 'settings-title' : 'dialog-title'}
          id={`${fieldId}-heading`}
        >
          <span id={`${fieldId}-title`}>{title}</span>
          <Action label={`关闭${title}`} icon="close" onClick={onClose} />
        </DialogTitle>
        <div className={project ? 'settings-body' : undefined}>
          {project && (
            <nav className="settings-nav" aria-label="项目配置分类">
              {[
                ['基本设置', 'settings'],
                ['工作目录', 'computer'],
              ].map(([label, icon], index) => (
                <ListItemButton
                  key={label}
                  component="button"
                  type="button"
                  selected={category === index}
                  aria-current={category === index ? 'true' : undefined}
                  onClick={() => setCategory(index)}
                >
                  <Icon name={icon} />
                  {label}
                </ListItemButton>
              ))}
              <span className="spacer" />
              <small>{editor.project?.name ?? '新建项目'}</small>
            </nav>
          )}
          <DialogContent className={project ? 'settings-content' : 'entity-fields'}>
            {project && (
              <>
                <h2>{category === 0 ? '基本设置' : '工作目录'}</h2>
                <p className="settings-description">
                  {category === 0
                    ? '设置项目名称与目标，需求和任务归属于此项目。'
                    : '管理项目可用的本机目录，并指定任务执行时优先使用的目录。'}
                </p>
              </>
            )}
            {editor.kind === 'spec' && (
              <p className="spec-builder-intro">
                描述你想做的事，与主 Agent 一起确认需求、设计和任务计划。
              </p>
            )}
            <div
              hidden={project && category !== 0}
              className={project ? 'settings-fields' : 'entity-basic-fields'}
            >
              <div className={project ? 'setting-row' : 'entity-field'}>
                <div>
                  <label htmlFor={`${fieldId}-name`}>
                    {project ? '项目名称' : editor.kind === 'spec' ? 'Spec 名称' : '需求名称'}
                  </label>
                  {project && <p>用于侧栏导航，可随时修改。</p>}
                </div>
                <div className={project ? 'setting-control' : undefined}>
                  <TextField
                    id={`${fieldId}-name`}
                    placeholder={
                      project
                        ? '输入项目名称'
                        : editor.kind === 'spec'
                          ? '为这个 Spec 起个名字'
                          : '输入需求名称'
                    }
                    autoFocus
                    required
                    fullWidth
                    value={name}
                    disabled={saving}
                    onChange={(e) => setName(e.target.value)}
                    slotProps={{ htmlInput: { maxLength: 80 } }}
                  />
                </div>
              </div>
              <div className={project ? 'setting-row' : 'entity-field'}>
                <div>
                  <label htmlFor={`${fieldId}-description`}>
                    {editor.kind === 'spec' ? '你想做什么？' : '描述'}
                  </label>
                  {project && <p>简要说明项目目标，帮助明确需求范围。</p>}
                </div>
                <div className={project ? 'setting-control' : undefined}>
                  <TextField
                    id={`${fieldId}-description`}
                    placeholder={
                      project
                        ? '简要描述项目目标…'
                        : editor.kind === 'spec'
                          ? '例如：添加 Google 登录，或修复导出大文件时崩溃的问题。'
                          : '简要描述需求目标…'
                    }
                    multiline
                    minRows={editor.kind === 'spec' ? 4 : 3}
                    required={editor.kind === 'spec'}
                    disabled={saving}
                    fullWidth
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    slotProps={{ htmlInput: { maxLength: editor.kind === 'spec' ? 12000 : 1000 } }}
                  />
                </div>
              </div>
            </div>
            {editor.kind === 'spec' && (
              <fieldset className="spec-kind-options" disabled={saving}>
                <legend>这属于哪类工作？</legend>
                {(
                  [
                    ['feature', '构建新东西', '梳理需求，设计方案，拆分任务。', Sparkles],
                    ['bugfix', '修复 bug', '复现问题，分析根因，规划修复。', Wrench],
                  ] as const
                ).map(([kind, label, detail, Glyph]) => (
                  <label key={kind} className={specKind === kind ? 'selected' : ''}>
                    <input
                      type="radio"
                      name={`${fieldId}-kind`}
                      value={kind}
                      checked={specKind === kind}
                      aria-label={label}
                      onChange={() => setSpecKind(kind)}
                    />
                    <span>
                      <strong>
                        <Glyph size={17} aria-hidden="true" />
                        {label}
                      </strong>
                      <span>{detail}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {project && (
              <div className="entity-field" hidden={category !== 1}>
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
        </div>
        <DialogActions
          className={project ? 'settings-status project-config-actions' : 'entity-actions'}
        >
          {project && <span>配置保存在本机 · 工作目录用于任务执行</span>}
          <Button variant="outlined" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving || !name.trim() || (editor.kind === 'spec' && !description.trim())}
          >
            {saving
              ? editor.kind === 'spec'
                ? '正在开始…'
                : '正在保存…'
              : editor.kind === 'spec'
                ? '开始对话'
                : editing
                  ? '保存'
                  : '创建'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
