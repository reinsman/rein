import { Alert, Button, Typography } from '@mui/material'
import type { QueuedFollowup } from './chatDraft'

export function FollowupStatus({
  followup,
  onWithdraw,
}: {
  followup: QueuedFollowup
  onWithdraw: () => void
}) {
  return (
    <Alert
      severity={followup.error ? 'error' : 'info'}
      variant="outlined"
      icon={false}
      role={followup.error ? 'alert' : 'status'}
      sx={{ mb: 1, py: 0, '& .MuiAlert-message': { minWidth: 0 } }}
      action={
        !followup.posting && (
          <Button size="small" color="inherit" onClick={onWithdraw}>
            {followup.error ? '恢复到输入框' : '撤回'}
          </Button>
        )
      }
    >
      <Typography variant="body2">
        {followup.error
          ? `排队消息发送失败：${followup.error}`
          : followup.posting
            ? '正在发送排队消息…'
            : '已排队，本轮执行结束后发送'}
      </Typography>
      <Typography variant="body2" noWrap title={followup.text} color="text.secondary">
        {followup.text}
      </Typography>
    </Alert>
  )
}
