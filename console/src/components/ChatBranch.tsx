import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
} from '@mui/material'
import { GitFork, MoreHorizontal, Undo2 } from 'lucide-react'
import type { Agent, RunUpdate } from '../services/localService'
import { localService } from '../services/localService'
import { ChatMarkdown, ChatText } from './ChatContent'
import { Action, AgentAvatar } from './shared'

const titleLimit = 28

export function BranchHeader({
  id,
  title,
  onClose,
  onDelete,
}: {
  id: string | null
  title: string | null
  onClose: () => void
  onDelete: () => void
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const name = title ?? ''
  const chars = Array.from(name)
  const heading = chars.length > titleLimit ? `${chars.slice(0, titleLimit).join('')}…` : name
  async function remove() {
    if (!id) return
    setDeleting(true)
    setError('')
    try {
      await localService.deleteFork(id)
      onDelete()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '删除侧边对话失败')
      setDeleting(false)
    }
  }
  return (
    <header className="panel-header chat-header">
      <GitFork size={18} aria-hidden="true" />
      <div className="chat-heading">
        <h1 title={name || undefined}>{heading || '侧边对话'}</h1>
      </div>
      {id && (
        <Action label="侧边对话操作" onClick={(e) => setMenu(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </Action>
      )}
      <Action label="关闭侧边对话" icon="close" onClick={onClose} />
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setMenu(null)
            setError('')
            setConfirm(true)
          }}
        >
          删除侧边对话
        </MenuItem>
      </Menu>
      <Dialog
        open={confirm}
        onClose={() => {
          if (!deleting) setConfirm(false)
        }}
        aria-labelledby="delete-chat-fork-title"
      >
        <DialogTitle id="delete-chat-fork-title">删除侧边对话？</DialogTitle>
        <DialogContent>
          <p>删除侧边对话的消息后，可以从原消息重新创建。</p>
          {error && <Alert severity="error">{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={deleting} onClick={() => setConfirm(false)}>
            取消
          </Button>
          <Button color="error" disabled={deleting} onClick={() => void remove()}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </header>
  )
}

export function BranchHistory({
  source,
  agent,
  userName,
  prompt,
  onSource,
}: {
  source: string
  agent: Agent
  userName: string
  prompt: (text: string) => string
  onSource: () => void
}) {
  const [records, setRecords] = useState<RunUpdate[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const initial = useRef<HTMLDivElement>(null)
  const positioned = useRef(false)
  const load = useCallback(
    (before: number | null) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      return localService
        .forkContext(source, before, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) {
            setRecords((previous) => (before === null ? page.runs : [...page.runs, ...previous]))
            setNext(page.next)
          }
        })
        .catch((failure) => {
          if (!controller.signal.aborted)
            setError(failure instanceof Error ? failure.message : '读取继承的历史失败')
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    },
    [source],
  )
  function reload(before: number | null) {
    setLoading(true)
    setError('')
    void load(before)
  }
  useEffect(() => {
    void load(null)
    return () => request.current?.abort()
  }, [load])
  useEffect(() => {
    if (records.length && initial.current && !positioned.current) {
      positioned.current = true
      const log = initial.current.closest('.messages')
      if (log && log.scrollTop === 0 && records.length >= 3)
        log.scrollTop =
          initial.current.getBoundingClientRect().top - log.getBoundingClientRect().top
    }
  }, [records.length])
  return (
    <>
      <section className="branch-context" aria-label="继承的历史">
        {error && (
          <Alert severity="error" action={<Button onClick={() => reload(next)}>重试</Button>}>
            {error}
          </Alert>
        )}
        {loading && <span role="status">正在读取继承的历史…</span>}
        {next !== null && (
          <Button size="small" disabled={loading} onClick={() => reload(next)}>
            加载更早历史
          </Button>
        )}
        {records.map((record) => {
          const answer = record.events.findLast(
            (event) => event.text?.complete && !event.text.reasoning && event.text.text,
          )?.text?.text
          return (
            <div className="branch-context-turn" key={record.run.id}>
              <article className="message own">
                <AgentAvatar />
                <div className="message-content">
                  <div className="message-author">
                    <strong>{userName}</strong>
                  </div>
                  <div className="message-bubble-row">
                    <div className="message-bubble">
                      <span>
                        <ChatText text={prompt(record.prompt)} />
                      </span>
                    </div>
                  </div>
                </div>
              </article>
              {answer && (
                <article className="message">
                  <AgentAvatar agent={agent} />
                  <div className="message-content">
                    <div className="message-author">
                      <strong>{agent.name}</strong>
                    </div>
                    <div className="hub-message-text">
                      <ChatMarkdown text={answer} run={record.run} />
                    </div>
                  </div>
                </article>
              )}
            </div>
          )
        })}
      </section>
      <div ref={initial} className="branch-origin">
        <span>从这里继续</span>
        <Action label="定位原消息" onClick={onSource}>
          <Undo2 size={15} />
        </Action>
      </div>
    </>
  )
}
