import { useEffect, useRef, useState } from 'react'
import { ButtonBase, InputBase, Menu, MenuItem, Paper, Tooltip } from '@mui/material'
import type { AppData, ChatScope, Message } from '../types'
import { reinService } from '../services/reinService'
import { AgentChat } from './AgentChat'
import { useChatDraft } from './chatDraft'
import { taskMessagePreview, workflowService, type Conversation } from '../services/workflow'
import { HandoffLinks } from './HandoffLinks'
import { ChatText } from './ChatContent'
import { taskMentionKey } from './chatMentions'

import { Action, AgentAvatar, ChatSendButton, Icon } from './shared'

interface Props {
  data: AppData
  scope: ChatScope
  onTask: (id: string) => void
  onMembers: () => void
  notify: (message: string) => void
  sendMode: string
  userName: string
  onSettings: () => void
  canSplitChat: boolean
  onForkVisibilityChange: (open: boolean) => void
}
export function Chat({
  data,
  scope,
  onTask,
  onMembers,
  notify,
  sendMode,
  userName,
  onSettings,
  canSplitChat,
  onForkVisibilityChange,
}: Props) {
  const mainAgent = data.agents.find((agent) => agent.id === data.workflow?.settings.main_agent)
  const mainAgentId = mainAgent?.id
  const [conversation, setConversation] = useState<Conversation>()
  const [conversationError, setConversationError] = useState('')
  useEffect(() => {
    let disposed = false
    if (scope.requirementId && mainAgentId)
      void workflowService
        .conversation(scope.requirementId)
        .then((value) => {
          if (!disposed) {
            setConversation(value)
            setConversationError('')
          }
        })
        .catch((error) => {
          if (!disposed) setConversationError(String(error))
        })
    return () => {
      disposed = true
    }
  }, [scope.requirementId, mainAgentId])
  const { draft, setDraft, sending, setSending, finishSend } = useChatDraft(`scope:${scope.id}`)
  const [memberAnchor, setMemberAnchor] = useState<HTMLElement | null>(null)
  const messages: (Message & {
    preview?: ReturnType<typeof taskMessagePreview>['preview']
    kind?: string
  })[] = [
    ...data.messages.filter((m) => m.scopeId === scope.id),
    ...(data.workflow?.messages ?? [])
      .filter((message) => message.requirement_id === scope.requirementId)
      .map((message) => {
        const { content, preview } = taskMessagePreview(message, data.workflow)
        return {
          id: message.id,
          scopeId: scope.id,
          authorId: message.agent_id,
          time: new Date(message.created_at).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          content,
          preview,
          kind: message.kind,
          taskIds: [message.task_id],
          execution: message.kind === 'waiting' ? ('waiting' as const) : undefined,
        }
      }),
  ]
  const selectedAgent = data.agents.find((agent) => agent.id === scope.agentId)
  const canChat = !!selectedAgent || !!scope.requirementId
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attachment, setAttachment] = useState('')
  function mention(name: string) {
    const input = inputRef.current
    const start = input?.selectionStart ?? draft.length
    const end = input?.selectionEnd ?? start
    const before = draft.slice(0, start)
    const after = draft.slice(end)
    const token = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `
    setDraft(before + token + after)
    setMemberAnchor(null)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, scope.id])
  async function send() {
    if (!canChat || (!draft.trim() && !attachment) || sending) return
    setSending(true)
    try {
      await reinService.sendMessage(
        scope.id,
        `${draft}${attachment ? `\n[附件：${attachment}，仅本地演示]` : ''}`,
      )
      finishSend()
      setAttachment('')
    } catch (error) {
      notify(error instanceof Error ? error.message : '发送失败，请重试。')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }
  if (selectedAgent?.hubManaged)
    return (
      <AgentChat
        key={selectedAgent.id}
        agent={selectedAgent}
        userName={userName}
        sendMode={sendMode}
        canSplitChat={canSplitChat}
        onForkVisibilityChange={onForkVisibilityChange}
      />
    )
  if (scope.requirementId && mainAgent)
    return conversation?.requirement_id === scope.requirementId &&
      conversation.agent_id === mainAgent.id ? (
      <AgentChat
        key={`${conversation.id}-${mainAgent.id}`}
        conversation={conversation}
        title={scope.title}
        messages={data.workflow?.messages?.filter(
          (message) => message.requirement_id === scope.requirementId,
        )}
        members={data.agents}
        workflow={data.workflow}
        onTask={onTask}
        agent={mainAgent}
        userName={userName}
        sendMode={sendMode}
        canSplitChat={canSplitChat}
        onForkVisibilityChange={onForkVisibilityChange}
        onSettings={onSettings}
      />
    ) : (
      <section className="chat-panel">
        <header className="panel-header">
          <h1>{scope.title}</h1>
        </header>
        <p className="muted">{conversationError || '正在读取需求讨论…'}</p>
      </section>
    )
  return (
    <section className="chat-panel" aria-label="群聊">
      <header className="panel-header chat-header">
        {selectedAgent ? (
          <AgentAvatar agent={selectedAgent} size={24} />
        ) : (
          <Icon name="people" size={24} />
        )}
        <div className="chat-heading">
          <h1>{scope.title}</h1>
          <span>
            {selectedAgent
              ? `Agent · ${selectedAgent.role}`
              : scope.requirementId
                ? '群聊'
                : '请选择需求或 Agent'}
          </span>
        </div>
        {!selectedAgent && scope.requirementId && (
          <div className="header-members">
            {data.agents.map((agent) => (
              <Tooltip title={agent.name} key={agent.id}>
                <ButtonBase
                  className="header-member"
                  aria-label={`提及 ${agent.name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => mention(agent.name)}
                >
                  <AgentAvatar agent={agent} />
                </ButtonBase>
              </Tooltip>
            ))}
          </div>
        )}
        {!selectedAgent && scope.requirementId && (
          <Action label="查看群聊成员" icon="plus" onClick={onMembers} />
        )}
        <Action label="聊天设置" icon="settings" onClick={() => notify('聊天设置功能待确定。')} />
      </header>
      <div
        className="messages"
        ref={scrollRef}
        role="log"
        aria-label={`${scope.title}的聊天记录`}
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="empty-message">
            <Icon name="chat" />
            <p>{canChat ? `在${scope.title}中开始对话` : '选择一个需求或 Agent'}</p>
            <span>消息仅对当前范围可见。</span>
          </div>
        )}
        {messages.map((message) => {
          const own = message.authorId === 'me'
          const agent = data.agents.find((a) => a.id === message.authorId)
          return (
            <article
              className={`message ${own ? 'own' : 'agent-message'} ${message.taskIds ? 'with-tasks' : ''}`}
              key={message.id}
              data-task-message={message.kind}
            >
              <AgentAvatar agent={own ? undefined : agent} runtime={message.kind !== undefined} />
              <div className="message-content">
                <div className="message-author">
                  {own ? (
                    <>
                      <strong>{userName}</strong>
                      <time>{message.time}</time>
                    </>
                  ) : (
                    <>
                      <strong>
                        <ButtonBase
                          className="author-mention"
                          aria-label={`提及 ${agent?.name}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => agent && mention(agent.name)}
                        >
                          {agent?.name} · {agent?.role}
                        </ButtonBase>
                      </strong>
                      <time>{message.time}</time>
                    </>
                  )}
                </div>
                <div className="message-bubble-row">
                  <Paper
                    elevation={0}
                    className={`message-bubble${message.execution ? ' with-execution' : ''}`}
                  >
                    <span>
                      <ChatText
                        text={message.content}
                        receipt={message.kind ? taskMentionKey(message.id) : undefined}
                      />
                    </span>
                    {message.execution === 'waiting' && (
                      <ButtonBase
                        className="message-state waiting"
                        aria-label={`回复 ${agent?.name}`}
                        onClick={() => agent && mention(agent.name)}
                      >
                        <Icon name="chatWaiting" size={14} />
                        需要你回复
                      </ButtonBase>
                    )}
                    {message.execution === 'executing' && (
                      <span className="message-state executing" aria-label="Agent 正在执行">
                        <Icon name="chatSpinner" size={12} spin />
                      </span>
                    )}
                  </Paper>
                </div>
                {message.preview && <HandoffLinks {...message.preview} />}
                {message.taskIds && (
                  <Paper variant="outlined" className="message-task-table">
                    {message.taskIds.map((id) => {
                      const task = data.tasks.find((t) => t.id === id)
                      return (
                        task && (
                          <button className="assignment-row" key={id} onClick={() => onTask(id)}>
                            <Icon name="doc" />
                            <span>{task.id === 'T-24' ? '修复间歇 503' : task.title}</span>
                            <small>
                              {data.agents.find((a) => a.id === task.agentId)?.name}
                              {task.reviewerId
                                ? ` / ${data.agents.find((a) => a.id === task.reviewerId)?.name ?? '待分配'}`
                                : ''}
                            </small>
                          </button>
                        )
                      )
                    })}
                  </Paper>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <div className="composer-dock">
        <Paper
          component="form"
          variant="outlined"
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <InputBase
            inputRef={inputRef}
            multiline
            maxRows={5}
            fullWidth
            placeholder={canChat ? '发送消息，@成员或分派任务…' : '从左侧选择需求或 Agent'}
            disabled={!canChat}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputProps={{ 'aria-label': '发送消息' }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                !e.shiftKey &&
                (sendMode === 'Enter 发送' || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {attachment && (
            <div className="attachment-chip">
              {attachment}
              <Action label="移除附件" icon="close" onClick={() => setAttachment('')} />
            </div>
          )}
          <div className="composer-actions">
            <Action label="提及成员" icon="at" onClick={(e) => setMemberAnchor(e.currentTarget)} />
            <Action
              label="添加本地演示附件"
              icon="attach"
              onClick={() => fileRef.current?.click()}
            />
            <span className="spacer" />
            <ChatSendButton
              label="发送消息按钮"
              sendMode={sendMode}
              disabled={!canChat || sending || (!draft.trim() && !attachment)}
              className="send-button"
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              setAttachment(e.target.files?.[0]?.name ?? '')
              e.target.value = ''
            }}
          />
        </Paper>
      </div>
      <Menu anchorEl={memberAnchor} open={!!memberAnchor} onClose={() => setMemberAnchor(null)}>
        {data.agents.map((agent) => (
          <MenuItem
            key={agent.id}
            onClick={() => {
              mention(agent.name)
            }}
          >
            <AgentAvatar agent={agent} size={18} />
            {agent.name} · {agent.role}
          </MenuItem>
        ))}
      </Menu>
    </section>
  )
}
