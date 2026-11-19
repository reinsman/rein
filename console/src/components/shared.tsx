import { Avatar, Button, IconButton, Tooltip } from '@mui/material'
import { Blocks, Waypoints, FilePlus2, Files, HandHelping, type LucideIcon } from 'lucide-react'
import type { Agent, ExecutionState } from '../types'
import { createElement, type ReactNode } from 'react'
import { steerShortcut } from './chatDraft'

const paths: Record<string, string> = {
  people: 'main-Group',
  plus: 'main-MaterialPlus',
  more: 'main-MaterialMore',
  doc: 'main-MaterialDoc',
  detailDoc: 'detail-MaterialDoc1',
  spinner: 'main-MuiCircularProgressActive1',
  waiting: 'main-MaterialHelp1',
  chatWaiting: 'main-MaterialHelp',
  chatSpinner: 'main-MuiCircularProgressActive',
  at: 'main-MaterialAt',
  attach: 'main-MaterialAttach',
  send: 'main-MaterialSend',
  layers: 'main-MaterialLayers',
  down: 'main-MaterialDown',
  collapse: 'main-Group1',
  search: 'main-MaterialSearch',
  chat: 'main-MaterialChat',
  cube: 'main-Group3',
  agents: 'main-Group2',
  checklist: 'main-Group4',
  flow: 'main-MaterialFlow',
  filter: 'main-MaterialFilter',
  clock: 'main-MaterialClock',
  check: 'main-MaterialCheck',
  drag: 'main-MaterialDrag',
  expand: 'detail-MaterialExpand',
  close: 'detail-MaterialClose',
  keyboard: 'detail-MaterialKeyboard',
  info: 'detail-MaterialInfo',
  stop: 'detail-MaterialStop',
  open: 'detail-MaterialOpen',
  person: 'account-MaterialPerson',
  settings: 'account-MaterialSettings',
  help: 'account-MaterialHelp2',
  logout: 'account-MaterialLogout',
  eye: 'login-MaterialEye',
  code: 'login-MaterialCode',
  lock: 'login-MaterialLock',
  tune: 'settings-MaterialTune',
  computer: 'settings-MaterialComputer',
  notify: 'settings-MaterialNotify',
  shield: 'settings-MaterialShield',
  brand: 'login-MaterialLayers',
  save: 'settings-MaterialCheck',
  edit: 'material-edit',
  requirement: 'material-requirement',
}
const outlineIcons = new Map<string, LucideIcon>([
  ['specAdd', FilePlus2],
  ['spec', Waypoints],
  ['project', Blocks],
  ['artifacts', Files],
  ['handoff', HandHelping],
])

export function Icon({
  name,
  size = 16,
  spin = false,
  className = '',
}: {
  name: string | LucideIcon
  size?: number
  spin?: boolean
  className?: string
}) {
  const Glyph = typeof name === 'string' ? outlineIcons.get(name) : name
  const asset = typeof name === 'string' ? (paths[name] ?? paths.doc) : paths.doc
  return (
    <span
      className={`icon ${spin ? 'spin' : ''} ${name === 'logout' ? 'logout-icon' : ''} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {Glyph ? (
        createElement(Glyph, {
          size,
          strokeWidth: 1.75,
          color: name === 'project' ? '#202632' : undefined,
        })
      ) : (
        <img src={`/icons/${asset}.svg`} alt="" />
      )}
      {name === 'logout' && (
        <span className="logout-glyph">
          <img src="/icons/account-Group5.svg" alt="" />
        </span>
      )}
    </span>
  )
}
export function Action({
  label,
  icon,
  onClick,
  children,
  className = '',
}: {
  label: string
  icon?: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children?: ReactNode
  className?: string
}) {
  return (
    <Tooltip title={label}>
      <IconButton aria-label={label} onClick={onClick} className={className}>
        {children ?? <Icon name={icon ?? 'more'} />}
      </IconButton>
    </Tooltip>
  )
}
export function ChatSendButton({
  label,
  sendMode,
  disabled,
  active = false,
  canGuide = false,
  className,
}: {
  label: string
  sendMode: string
  disabled: boolean
  active?: boolean
  canGuide?: boolean
  className?: string
}) {
  let hint = sendMode === 'Enter 发送' ? 'Enter 发送' : `${steerShortcut} 发送`
  if (active) {
    hint = canGuide
      ? `Enter 排队 · ${steerShortcut} 立即指导（Steer）`
      : 'Enter 排队，结束后发送'
  }
  return (
    <Tooltip title={hint} describeChild>
      <span style={{ display: 'inline-flex' }}>
        <Button
          type="submit"
          variant="contained"
          aria-label={label}
          aria-description={hint}
          disabled={disabled}
          className={className}
        >
          <Icon name="send" />
        </Button>
      </span>
    </Tooltip>
  )
}
export function AgentAvatar({
  agent,
  size = 22,
  runtime = false,
}: {
  agent?: Agent
  size?: number
  runtime?: boolean
}) {
  const avatar = (
    <Avatar
      src={agent ? `/providers/${agent.provider}.svg` : undefined}
      alt={agent ? `${agent.cli}头像` : undefined}
      sx={{
        width: size,
        height: size,
        bgcolor: agent ? 'transparent' : '#0866ff',
        fontSize: size < 20 ? 10 : 12,
        '& img': { objectFit: 'contain', padding: '2px' },
      }}
    >
      {agent?.name[0] ?? 'H'}
    </Avatar>
  )
  return runtime ? (
    <span className="runtime-message-avatar">
      {avatar}
      <span className="runtime-message-badge" role="img" aria-label="系统消息">
        <Icon name="settings" size={10} />
      </span>
    </span>
  ) : (
    avatar
  )
}
export function StateIcon({ state }: { state: ExecutionState }) {
  return (
    <Icon
      size={12}
      name={
        state === 'executing'
          ? 'spinner'
          : state === 'waiting'
            ? 'waiting'
            : state === 'completed'
              ? 'check'
              : 'clock'
      }
      spin={state === 'executing'}
    />
  )
}
export function StatusDot({
  status,
  online,
}: {
  status?: 'todo' | 'running' | 'done'
  online?: boolean
}) {
  const asset = status
    ? { todo: 'StatusDot', running: 'StatusDot1', done: 'MaterialCheck' }[status]
    : online
      ? 'StatusDot4'
      : 'StatusDot3'
  return (
    <span className="icon" aria-hidden="true">
      <img src={`/icons/main-${asset}.svg`} alt="" />
    </span>
  )
}
