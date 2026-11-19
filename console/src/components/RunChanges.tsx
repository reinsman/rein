import { useId, useMemo, useState } from 'react'
import { Button } from '@mui/material'
import {
  File,
  FileArchive,
  FileBracesCorner,
  FileChartColumn,
  FileCode,
  FileCog,
  FileHeadphone,
  FileImage,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileTypeCorner,
  FileVideoCamera,
  type LucideIcon,
} from 'lucide-react'
import { decodeJson, type AgentEvent, type RunUpdate } from '../services/localService'
import { Icon } from './shared'

type Tool = NonNullable<AgentEvent['tool']>
type Format = 'unified' | 'pi' | 'add' | 'delete' | 'write'
type Change = { path: string; label: string; text: string; format: Format }
type DiffLine = { text: string; old?: number; next?: number; kind?: 'add' | 'delete' | 'hunk' }

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const fileIcons = new Map<string, LucideIcon>()
for (const [glyph, extensions] of [
  [
    FileCode,
    'c cc cpp cs css dart go h hpp html java js jsx kt lua php py rb rs scss sql svelte swift ts tsx vue',
  ],
  [FileText, 'doc docx log md mdx odt rst rtf txt'],
  [FileBracesCorner, 'json jsonc xml yaml yml'],
  [FileCog, 'cfg conf env ini lock toml'],
  [FileTerminal, 'bat bash fish ps1 sh zsh'],
  [FileTypeCorner, 'pdf'],
  [FileSpreadsheet, 'csv ods tsv xls xlsx'],
  [FileChartColumn, 'odp ppt pptx'],
  [FileImage, 'avif bmp gif heic ico jpeg jpg png svg tif tiff webp'],
  [FileHeadphone, 'aac flac m4a mp3 ogg wav'],
  [FileVideoCamera, 'avi m4v mkv mov mp4 webm'],
  [FileArchive, '7z bz2 gz rar tar tgz xz zip'],
] as const) {
  for (const extension of extensions.split(' ')) fileIcons.set(extension, glyph)
}

function fileIcon(path: string) {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const extension = name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? ''
  return fileIcons.get(extension) ?? File
}

function relativePath(path: string, directory?: string) {
  const prefix = directory && directory.replace(/\/+$/, '') + '/'
  if (prefix && path.startsWith(prefix)) {
    const relative = path.slice(prefix.length)
    if (!relative.split('/').includes('..')) return relative
  }
  return path.replace(/^(\.\/)+/, '')
}

function toolChanges(tool: Tool, directory?: string): Change[] {
  // shortcut: only tool-reported changes; workspace snapshots are needed to include shell edits.
  if (!tool.complete || tool.isError) return []
  if (!['fileChange', 'edit', 'write'].includes(tool.name)) return []
  const input = decodeJson(tool.inputJson)
  if (tool.name === 'fileChange' && Array.isArray(input?.changes)) {
    return input.changes.flatMap((change: unknown) => {
      if (!change || typeof change !== 'object') return []
      const { path, diff, kind } = change as Record<string, unknown>
      if (typeof path !== 'string' || typeof diff !== 'string') return []
      const type = typeof kind === 'object' && kind ? (kind as { type?: string }).type : kind
      const destination =
        typeof kind === 'object' && kind ? (kind as { move_path?: unknown }).move_path : null
      return [
        {
          path,
          label:
            typeof destination === 'string'
              ? `重命名 → ${relativePath(destination, directory)}`
              : type === 'add'
                ? '新增'
                : type === 'delete'
                  ? '删除'
                  : '修改',
          text: diff,
          format: type === 'add' || type === 'delete' ? type : 'unified',
        },
      ]
    })
  }
  if (typeof input?.path !== 'string') return []
  if (tool.name === 'edit') {
    const details = decodeJson<{ details?: { diff?: unknown; patch?: unknown } } | null>(
      tool.outputJson,
    )?.details
    if (typeof details?.patch === 'string' && /^@@ /m.test(details.patch))
      return [{ path: input.path, label: '修改', text: details.patch, format: 'unified' }]
    if (typeof details?.diff === 'string')
      return [
        {
          path: input.path,
          label: '修改',
          text: details.diff,
          format: /^@@ /m.test(details.diff) ? 'unified' : 'pi',
        },
      ]
  }
  if (tool.name === 'write' && typeof input.content === 'string')
    return [
      {
        path: input.path,
        label: '写入内容（未记录原内容）',
        text: input.content,
        format: 'write',
      },
    ]
  return []
}

function diffLines({ text, format }: Change): DiffLine[] {
  if (!text) return []
  let old = 0
  let next = 0
  let oldEnd = 0
  let nextEnd = 0
  let piOffset = 0
  return text
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((line, index) => {
      if (format === 'write') return { text: line, next: index + 1 }
      if (format === 'add') return { text: `+${line}`, next: index + 1, kind: 'add' }
      if (format === 'delete') return { text: `-${line}`, old: index + 1, kind: 'delete' }
      if (format === 'pi') {
        const match = /^([+ -])\s*(\d+) (.*)$/.exec(line)
        if (!match) return { text: line }
        const [, sign, number, content] = match
        const lineNumber = Number(number)
        if (sign === '+') {
          piOffset++
          return { text: `+${content}`, next: lineNumber, kind: 'add' }
        }
        if (sign === '-') {
          piOffset--
          return { text: `-${content}`, old: lineNumber, kind: 'delete' }
        }
        return { text: ` ${content}`, old: lineNumber, next: lineNumber + piOffset }
      }
      const hunk = hunkHeader.exec(line)
      if (hunk) {
        old = Number(hunk[1])
        next = Number(hunk[3])
        oldEnd = old + Number(hunk[2] ?? 1)
        nextEnd = next + Number(hunk[4] ?? 1)
        return { text: line, kind: 'hunk' }
      }
      if (line.startsWith('+') && next < nextEnd) return { text: line, next: next++, kind: 'add' }
      if (line.startsWith('-') && old < oldEnd) return { text: line, old: old++, kind: 'delete' }
      if (line.startsWith(' ') && old < oldEnd && next < nextEnd)
        return { text: line, old: old++, next: next++ }
      return { text: line }
    })
}

function collectChanges(records: RunUpdate[], directory?: string) {
  const files = new Map<
    string,
    {
      path: string
      added: number
      deleted: number
      known: boolean
      changes: (Change & { lines: DiffLine[] })[]
    }
  >()
  for (const record of records) {
    const workspace = record.run.workingDirectory ?? directory
    const tools = new Map<string, Tool>()
    for (const { tool } of record.events) {
      if (!tool) continue
      const previous = tools.get(tool.callId)
      tools.set(tool.callId, {
        ...tool,
        inputJson: tool.inputJson || previous?.inputJson || '',
        outputJson: tool.outputJson || previous?.outputJson || '',
      })
    }
    for (const tool of tools.values()) {
      for (const change of toolChanges(tool, workspace)) {
        const path = relativePath(change.path, workspace)
        const file = files.get(path) ?? {
          path: change.path,
          added: 0,
          deleted: 0,
          known: false,
          changes: [],
        }
        const lines = diffLines(change)
        file.known ||=
          change.format !== 'write' && (!!lines.length || change.label.startsWith('重命名'))
        for (const line of lines) {
          if (line.kind === 'add') file.added++
          if (line.kind === 'delete') file.deleted++
        }
        file.changes.push({ ...change, lines })
        files.set(path, file)
      }
    }
  }
  return files
}

export function RunChanges({
  records,
  directory,
  empty,
}: {
  records: RunUpdate[]
  directory?: string
  empty?: string
}) {
  const files = useMemo(() => collectChanges(records, directory), [records, directory])
  const [showAll, setShowAll] = useState(false)
  const extraId = useId()
  if (!files.size) return empty ? <p className="muted">{empty}</p> : null
  const entries = [...files]
  function fileRows(rows: typeof entries) {
    return rows.map(([path, file]) => (
      <details className="hub-file-change" key={path}>
        <summary className="hub-activity-summary">
          <Icon name={fileIcon(path)} size={14} />
          <span className="hub-file-path" title={file.path}>
            {path}
          </span>
          {file.known ? (
            <span
              className="hub-change-count"
              aria-label={`增加 ${file.added} 行，删除 ${file.deleted} 行`}
            >
              <span className="hub-count-add">+{file.added}</span>
              <span className="hub-count-delete">-{file.deleted}</span>
            </span>
          ) : (
            <span className="hub-change-count muted" title="未记录可统计的差异">
              —
            </span>
          )}
          <span className="hub-activity-chevron">
            <Icon name="down" size={12} />
          </span>
        </summary>
        {file.changes.map((change, index) => (
          <div key={index}>
            <p className="hub-change-label">{change.label}</p>
            {!change.lines.length && <p className="hub-change-label">未返回文本差异。</p>}
            {!!change.lines.length && (
              <pre
                className="hub-diff"
                tabIndex={0}
                aria-label={`${path} ${change.format === 'write' ? '写入内容' : 'diff（原行号、新行号）'}`}
              >
                <code>
                  {change.lines.map((line, lineIndex) => (
                    <span
                      key={lineIndex}
                      className={`hub-diff-line${line.kind ? ` hub-diff-${line.kind}` : ''}`}
                    >
                      <span className="hub-line-number" title="原行号">
                        {line.old}
                      </span>
                      <span className="hub-line-number" title="新行号">
                        {line.next}
                      </span>
                      <span className="hub-line-text">{line.text}</span>
                    </span>
                  ))}
                </code>
              </pre>
            )}
          </div>
        ))}
      </details>
    ))
  }
  return (
    <section className="hub-changes" aria-label="文件变更">
      <h3>文件变更 · {files.size} 个文件</h3>
      {fileRows(entries.slice(0, 5))}
      {files.size > 5 && (
        <>
          <div id={extraId} hidden={!showAll}>
            {showAll && fileRows(entries.slice(5))}
          </div>
          <Button
            size="small"
            aria-expanded={showAll}
            aria-controls={extraId}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? '收起' : `显示剩余 ${files.size - 5} 个`}
          </Button>
        </>
      )}
    </section>
  )
}
