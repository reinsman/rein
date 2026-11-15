import { Avatar, IconButton, Tooltip } from '@mui/material'
import { Blocks, Waypoints, FilePlus2 } from 'lucide-react'
import type { Agent, ExecutionState } from '../types'
import type { ReactNode } from 'react'

const paths: Record<string, string> = {
  people: 'main-Group',
  plus: 'main-MaterialPlus',
  more: 'main-MaterialMore',
  doc: 'main-MaterialDoc',
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
export function Icon({
  name,
  size = 16,
  spin = false,
}: {
  name: string
  size?: number
  spin?: boolean
}) {
  return (
    <span
      className={`icon ${spin ? 'spin' : ''} ${name === 'logout' ? 'logout-icon' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {name === 'specAdd' ? (
        <FilePlus2 size={size} strokeWidth={1.75} />
      ) : name === 'spec' ? (
        <Waypoints size={size} strokeWidth={1.75} />
      ) : name === 'project' ? (
        <Blocks size={size} strokeWidth={1.75} color="#202632" />
      ) : (
        <img
          src={`/icons/${name === 'detailDoc' ? 'detail-MaterialDoc1' : (paths[name] ?? paths.doc)}.svg`}
          alt=""
        />
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
export function AgentAvatar({ agent, size = 22 }: { agent?: Agent; size?: number }) {
  return (
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
    ? { todo: 'StatusDot', running: 'StatusDot1', done: 'StatusDot2' }[status]
    : online
      ? 'StatusDot4'
      : 'StatusDot3'
  return (
    <span className="icon" aria-hidden="true">
      <img src={`/icons/main-${asset}.svg`} alt="" />
    </span>
  )
}
