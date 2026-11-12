import { useState } from 'react'
import { Alert, Button, Divider, InputAdornment, TextField } from '@mui/material'
import { reinService } from '../services/reinService'
import { Action, Icon } from './shared'

export function Login({
  onLogin,
  notify,
}: {
  onLogin: () => void
  notify: (text: string) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  return (
    <main className="login-page">
      <div className="login-brand">
        <Icon name="brand" size={22} />
        <span>Rein</span>
      </div>
      <form
        className="login-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setLoading(true)
          try {
            await reinService.login(email, password)
            setPassword('')
            onLogin()
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setLoading(false)
          }
        }}
      >
        <h1>欢迎回来</h1>
        <p className="login-description">登录以管理项目与 Agent</p>
        <div className="login-fields">
          <label htmlFor="login-email">邮箱</label>
          <TextField
            id="login-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            fullWidth
            autoComplete="off"
          />
          <label htmlFor="login-password">密码</label>
          <TextField
            id="login-password"
            type={visible ? 'text' : 'password'}
            placeholder="请输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            fullWidth
            autoComplete="off"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Action
                      label={visible ? '隐藏密码' : '显示密码'}
                      icon="eye"
                      onClick={() => setVisible(!visible)}
                    />
                  </InputAdornment>
                ),
              },
            }}
          />
        </div>
        <Button
          className="forgot-password"
          onClick={() =>
            notify('当前为模拟登录，无真实账号；可使用任意演示邮箱及至少 4 位演示密码')
          }
        >
          忘记密码？
        </Button>
        {error && (
          <Alert severity="error" className="login-error">
            {error}
          </Alert>
        )}
        <Button variant="contained" type="submit" fullWidth disabled={loading}>
          {loading ? '正在登录…' : '登录'}
        </Button>
        <Divider className="login-divider">或</Divider>
        <Button variant="outlined" fullWidth startIcon={<Icon name="code" />} onClick={onLogin}>
          使用 GitHub 继续
        </Button>
        <Button variant="outlined" fullWidth startIcon={<Icon name="lock" />} onClick={onLogin}>
          使用企业账号登录
        </Button>
        <div className="register-text">
          还没有账号？
          <Button onClick={() => notify('本阶段为前端演示，注册服务尚未接入')}>注册</Button>
        </div>
        <p className="login-demo-note">演示模式 · 请使用虚构信息，密码不会保存</p>
      </form>
      <footer className="login-legal">
        <button onClick={() => notify('Rein 当前为本地前端演示，服务条款尚未发布')}>
          服务条款
        </button>
        <span>·</span>
        <button onClick={() => notify('仅界面偏好保存在本机，不保存密码或密钥')}>隐私政策</button>
      </footer>
    </main>
  )
}
