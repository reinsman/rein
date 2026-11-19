import { useEffect, useState } from 'react'
import { Alert, AlertTitle, Button, Select, Stack, TextField } from '@mui/material'
import type { AgentPermissions } from '../localTypes'
import { request } from '../services/localService'
import {
  agentConfigService,
  permissionLabels,
  type TypeDefaults,
} from '../services/agentConfigService'
import { Row } from './Settings'

type Provider = 'codex' | 'pi'
type ConfigFile = { name: string; path: string; content: string }

export function AgentTypeSettings({
  notify,
  onDirty,
}: {
  notify: (message: string) => void
  onDirty: (dirty: boolean) => void
}) {
  const [provider, setProvider] = useState<Provider>('codex')
  const [files, setFiles] = useState<ConfigFile[]>([])
  const [defaults, setDefaults] = useState<TypeDefaults | null>(null)
  const [index, setIndex] = useState(0)
  const [draft, setDraft] = useState('')
  const [permissionsDraft, setPermissionsDraft] = useState<AgentPermissions | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const file = files[index]
  const dirty = !!file && draft !== file.content
  const permissionsDirty = permissionsDraft !== null && permissionsDraft !== defaults?.permissions
  const endpoint = `/api/agent-types/${provider}`
  const codexHome =
    provider === 'codex' && file?.name === 'config.toml'
      ? file.path.slice(0, -file.name.length - 1)
      : null
  function beginLoad() {
    setLoading(true)
    setError('')
    setFiles([])
    setDefaults(null)
    setPermissionsDraft(null)
    setIndex(0)
  }
  useEffect(() => {
    const controller = new AbortController()
    void request<{ files: ConfigFile[]; defaults: TypeDefaults | null }>(endpoint, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    })
      .then(({ files, defaults }) => {
        if (controller.signal.aborted) return
        setFiles(files)
        setDefaults(defaults)
        setDraft(files[0]?.content ?? '')
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(String(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [endpoint, reload])
  async function save() {
    if (!file || !dirty || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await request<{ defaults: TypeDefaults | null }>(
        `${endpoint}/${encodeURIComponent(file.name)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ previous: file.content, content: draft }),
        },
      )
      setFiles((current) =>
        current.map((entry) => (entry === file ? { ...entry, content: draft } : entry)),
      )
      setDefaults(result.defaults)
      if (permissionsDraft === result.defaults?.permissions) setPermissionsDraft(null)
      onDirty(permissionsDraft !== null && permissionsDraft !== result.defaults?.permissions)
      notify('类型配置已保存')
    } catch (failure) {
      setError(String(failure))
    } finally {
      setSaving(false)
    }
  }
  async function savePermissions() {
    if (!defaults || !permissionsDraft || !permissionsDirty || saving) return
    setSaving(true)
    setError('')
    try {
      const { permissions } = await request<{ permissions: AgentPermissions }>(
        `${endpoint}/permissions`,
        { method: 'PUT', body: JSON.stringify({ permissions: permissionsDraft }) },
      )
      setDefaults({ ...defaults, permissions })
      setPermissionsDraft(null)
      onDirty(dirty)
      notify('默认权限已保存')
    } catch (failure) {
      setError(String(failure))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="agent-type-editor">
      <Row label="Agent 类型" description="此类型的本地 Agent 共用这些配置文件。">
        <Select
          native
          className="setting-select"
          value={provider}
          disabled={dirty || permissionsDirty || saving}
          inputProps={{ 'aria-label': 'Agent 类型' }}
          onChange={(event) => {
            beginLoad()
            setProvider(event.target.value as Provider)
          }}
        >
          <option value="codex">Codex</option>
          <option value="pi">Pi</option>
        </Select>
      </Row>
      {provider === 'codex' && (
        <Alert severity="warning" role="note" aria-label="Codex 登录说明">
          <AlertTitle>首次使用需单独登录</AlertTitle>
          <p>
            Rein 的 Codex 使用独立配置目录。个人 Codex 的登录状态不会同步，使用此目录的 Agent
            共用一次登录。
          </p>
          {codexHome && (
            <code className="skill-install-path">
              {`env CODEX_HOME='${codexHome.replaceAll("'", "'\\''")}' codex login`}
            </code>
          )}
        </Alert>
      )}
      {loading && <p className="settings-description">正在读取配置…</p>}
      {error && <Alert severity="error">{error}</Alert>}
      {file && (
        <section className="agent-type-defaults" aria-label="类型默认值">
          <h3>类型默认值</h3>
          <dl>
            <div>
              <dt>模型</dt>
              <dd>{defaults ? agentConfigService.modelName(defaults) : '读取失败'}</dd>
            </div>
            <div>
              <dt>思考强度</dt>
              <dd>{defaults ? (defaults.reasoning_effort ?? '由原生 CLI 选择') : '读取失败'}</dd>
            </div>
          </dl>
        </section>
      )}
      {file && (
        <Row
          label="默认权限"
          description={
            provider === 'codex'
              ? '同类型的 Agent 默认继承。Full access（YOLO）关闭沙箱和审批。'
              : 'Pi 按启动账户和运行环境的权限执行。'
          }
        >
          {provider === 'pi' ? (
            <span className="agent-setting-value">原生完全访问</span>
          ) : defaults ? (
            <Select
              native
              className="setting-select"
              value={permissionsDraft ?? defaults.permissions}
              disabled={saving}
              inputProps={{ 'aria-label': '默认权限' }}
              onChange={(event) => {
                const permissions = event.target.value as AgentPermissions
                const changed = permissions !== defaults.permissions
                setPermissionsDraft(changed ? permissions : null)
                setError('')
                onDirty(dirty || changed)
              }}
            >
              {Object.entries(permissionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          ) : (
            <span className="agent-setting-value">读取失败</span>
          )}
        </Row>
      )}
      {permissionsDirty && (
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button
            disabled={saving}
            onClick={() => {
              setPermissionsDraft(null)
              setError('')
              onDirty(dirty)
            }}
          >
            放弃权限修改
          </Button>
          <Button variant="contained" disabled={saving} onClick={() => void savePermissions()}>
            保存默认权限
          </Button>
        </Stack>
      )}
      <details className="agent-type-editor-disclosure">
        <summary>配置文件</summary>
        {file && (
          <>
            <div className="agent-type-file">
              {files.length > 1 && (
                <Select
                  native
                  className="setting-select"
                  value={String(index)}
                  disabled={dirty || saving}
                  inputProps={{ 'aria-label': '配置文件' }}
                  onChange={(event) => {
                    const selected = Number(event.target.value)
                    setIndex(selected)
                    setDraft(files[selected].content)
                    setError('')
                  }}
                >
                  {files.map((entry, fileIndex) => (
                    <option key={entry.name} value={fileIndex}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              )}
              <code className="skill-default-path">{file.path}</code>
            </div>
            <TextField
              fullWidth
              multiline
              rows={13}
              value={draft}
              disabled={saving}
              slotProps={{ htmlInput: { 'aria-label': file.name, spellCheck: false } }}
              onChange={(event) => {
                setDraft(event.target.value)
                onDirty(event.target.value !== file.content || permissionsDirty)
              }}
            />
          </>
        )}
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          {dirty ? (
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(file.content)
                setError('')
                onDirty(permissionsDirty)
              }}
            >
              放弃修改
            </Button>
          ) : (
            <Button
              disabled={loading || permissionsDirty || saving}
              onClick={() => {
                beginLoad()
                setReload(reload + 1)
              }}
            >
              重新读取
            </Button>
          )}
          <Button variant="contained" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? '正在保存…' : '保存配置'}
          </Button>
        </Stack>
      </details>
    </div>
  )
}
