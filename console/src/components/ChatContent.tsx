import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from 'react'
import { Alert, Button, Dialog, DialogContent, DialogTitle } from '@mui/material'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root } from 'hast'
import { request, type AgentRun } from '../services/localService'
import { ChatMentionContext, mentionsIn, mentionsUser } from './chatMentions'

type FileReference = { path: string; line?: number }
const fileToken =
  /(?<![\p{L}\p{N}@/.:\\])(?:file:\/\/|\/(?!\/)|\.{1,2}\/|[\p{L}\p{N}_.-]+\/)[^\s<>()[\]"'“”‘’，。；！？、]+/gu

function fileReference(input: string, workspace?: string): FileReference | null | undefined {
  const target = input.replace(/(?::(\d+)(?::\d+)?|#L(\d+))$/, '')
  const suffix = input.slice(target.length).match(/\d+/)
  if (!target || /^(?:#|\?|\/\/)/.test(target)) return undefined
  const fileUrl = /^file:/i.test(target)
  if (!fileUrl && /^[a-z][a-z\d+.-]*:/i.test(target)) return undefined
  if (!fileUrl && !target.includes('/') && !/\.[\p{L}\p{N}]+$/u.test(target)) return undefined
  if (!workspace) return null
  let path: string
  try {
    path = decodeURIComponent(fileUrl ? target.replace(/^file:\/\/(?=\/)/i, '') : target)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\') || (fileUrl && !path.startsWith('/'))) return null
  const prefix = workspace.replace(/\/+$/, '') + '/'
  if (path.startsWith('/')) {
    if (!path.startsWith(prefix)) return null
    path = path.slice(prefix.length)
  }
  const parts = path.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  const line = suffix ? Number(suffix[0]) : 0
  return { path: parts.join('/'), line: Number.isSafeInteger(line) && line > 0 ? line : undefined }
}

function mentionParts(text: string, identity: ContextType<typeof ChatMentionContext>) {
  const parts: { text: string; mention?: string }[] = []
  let start = 0
  for (const match of mentionsIn(text)) {
    const name = match[1]
    if (!identity || (!mentionsUser(name, identity.userName) && !identity.agents.has(name)))
      continue
    if (match.index > start) parts.push({ text: text.slice(start, match.index) })
    parts.push({ text: '@' + (name === '用户' ? identity.userName : name), mention: name })
    start = match.index + match[0].length
  }
  if (start < text.length) parts.push({ text: text.slice(start) })
  return parts
}

function MentionChip({
  name,
  receipt,
  children,
}: {
  name: string
  receipt?: string
  children: ReactNode
}) {
  const context = useContext(ChatMentionContext)
  const own = !!context && mentionsUser(name, context.userName)
  const markRead = context?.markRead
  const seen = !!receipt && context?.seen.has(receipt)
  const chip = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = chip.current
    if (!element || !own || !receipt || !markRead || seen) return
    let visible = false
    function read() {
      if (!element || !visible || document.hidden || !receipt) return
      const rect = element.getBoundingClientRect()
      if (
        element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        )
      )
        markRead?.(receipt)
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.intersectionRatio >= 0.5
        read()
      },
      { threshold: 0.5 },
    )
    observer.observe(element)
    document.addEventListener('visibilitychange', read)
    document.addEventListener('focusin', read)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', read)
      document.removeEventListener('focusin', read)
    }
  }, [markRead, own, receipt, seen])
  return (
    <span ref={chip} className={own ? 'chat-mention chat-mention-user' : 'chat-mention'}>
      {children}
    </span>
  )
}

export function ChatText({ text, receipt }: { text: string; receipt?: string }) {
  const identity = useContext(ChatMentionContext)
  return mentionParts(text, identity).map((part, index) =>
    part.mention ? (
      <MentionChip key={index} name={part.mention} receipt={receipt}>
        {part.text}
      </MentionChip>
    ) : (
      part.text
    ),
  )
}

export function ChatMarkdown({
  text,
  run,
  receipt,
}: {
  text: string
  run: AgentRun
  receipt?: string
}) {
  const identity = useContext(ChatMentionContext)
  const workspace = run.canPreviewFiles ? run.workingDirectory : undefined
  const [selected, setSelected] = useState<FileReference>()
  const [result, setResult] = useState<{ content: string } | { error: string }>()
  const selection = useRef<AbortController>(null)
  useEffect(() => () => selection.current?.abort(), [])
  function close() {
    selection.current?.abort()
    setSelected(undefined)
  }
  const open = useCallback(
    async (file: FileReference) => {
      selection.current?.abort()
      const controller = new AbortController()
      selection.current = controller
      setSelected(file)
      setResult(undefined)
      try {
        const response = await request<{ content: string }>(
          `/api/runs/${encodeURIComponent(run.id)}/file`,
          {
            method: 'POST',
            body: JSON.stringify({ path: file.path }),
            signal: controller.signal,
          },
        )
        if (!controller.signal.aborted) setResult(response)
      } catch (failure) {
        if (!controller.signal.aborted)
          setResult({ error: failure instanceof Error ? failure.message : '无法预览文件' })
      }
    },
    [run.id],
  )
  function mentionNodes(value: string): ElementContent[] {
    return mentionParts(value, identity).map((part) =>
      part.mention
        ? {
            type: 'element',
            tagName: 'span',
            properties: { dataChatMention: part.mention },
            children: [{ type: 'text', value: part.text }],
          }
        : { type: 'text', value: part.text },
    )
  }
  function fileNode(file: FileReference, children?: ElementContent[]): Element {
    const label = file.path + (file.line ? `:${file.line}` : '')
    return {
      type: 'element',
      tagName: 'button',
      properties: { dataChatPath: file.path, dataChatLine: file.line },
      children: children ?? [{ type: 'text', value: label }],
    }
  }
  function transform() {
    function visit(parent: Root | Element) {
      for (let index = parent.children.length - 1; index >= 0; index--) {
        const child = parent.children[index]
        if (child.type === 'element') {
          if (child.tagName === 'a' || child.tagName === 'code') {
            const target =
              child.tagName === 'a'
                ? child.properties.href
                : child.children[0]?.type === 'text'
                  ? child.children[0].value
                  : undefined
            if (typeof target !== 'string') continue
            const file = fileReference(target, workspace)
            if (file) {
              parent.children.splice(
                index,
                1,
                fileNode(file, child.tagName === 'a' ? child.children : undefined),
              )
            } else if (file === null && child.tagName === 'a') {
              child.tagName = 'code'
              child.properties = { title: target }
            }
          } else if (child.tagName !== 'pre') visit(child)
        } else if (child.type === 'text') {
          const nodes: ElementContent[] = []
          let start = 0
          for (const match of child.value.matchAll(fileToken)) {
            const token = match[0].replace(/[.,;!?]+$/, '')
            const file = fileReference(token, workspace)
            if (!file) continue
            nodes.push(...mentionNodes(child.value.slice(start, match.index)), fileNode(file))
            start = match.index + token.length
          }
          nodes.push(...mentionNodes(child.value.slice(start)))
          parent.children.splice(index, 1, ...nodes)
        }
      }
    }
    return visit
  }
  const components = useMemo<Components>(
    () => ({
      span({ node, children, ...props }) {
        const name = node?.properties.dataChatMention
        return typeof name === 'string' ? (
          <MentionChip name={name} receipt={receipt}>
            {children}
          </MentionChip>
        ) : (
          <span {...props}>{children}</span>
        )
      },
      button({ node, children }) {
        const path = node?.properties.dataChatPath
        if (typeof path !== 'string') return <span>{children}</span>
        const line = node?.properties.dataChatLine
        return (
          <button
            type="button"
            className="chat-file-link"
            title={workspace + (workspace?.endsWith('/') ? '' : '/') + path}
            aria-haspopup="dialog"
            onClick={() => void open({ path, line: typeof line === 'number' ? line : undefined })}
          >
            {children}
          </button>
        )
      },
    }),
    [open, receipt, workspace],
  )
  return (
    <>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[transform]} components={components}>
        {text}
      </Markdown>
      <Dialog open={!!selected} onClose={close} fullWidth maxWidth="md">
        <DialogTitle>
          {selected?.path}
          {selected?.line ? `:${selected.line}` : ''}
          <Button onClick={close}>关闭</Button>
        </DialogTitle>
        <DialogContent>
          {!result ? (
            <p role="status">正在读取…</p>
          ) : 'error' in result ? (
            <Alert severity="error">{result.error}</Alert>
          ) : (
            <FileText content={result.content} line={selected?.line} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function FileText({ content, line }: { content: string; line?: number }) {
  const rows = line ? content.split('\n') : []
  const target = line && line <= rows.length ? line - 1 : -1
  const marker = useRef<HTMLElement>(null)
  useEffect(() => {
    void marker.current?.scrollIntoView({ block: 'center' })
  }, [target])
  return (
    <pre className="chat-file-preview">
      {target < 0 ? (
        content
      ) : (
        <>
          {target > 0 && rows.slice(0, target).join('\n') + '\n'}
          <mark ref={marker}>{rows[target] || ' '}</mark>
          {rows
            .slice(target + 1)
            .map((row) => '\n' + row)
            .join('')}
        </>
      )}
    </pre>
  )
}
