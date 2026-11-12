import { useState } from 'react'
import { Button, Dialog, DialogContent, DialogTitle } from '@mui/material'
import {
  ArrowUpRight,
  ChevronRight,
  CircleCheck,
  CodeXml,
  FileText,
  GitBranch,
  GitCommitHorizontal,
} from 'lucide-react'
import type { Task, TaskStatus } from '../types'
import { Action } from './shared'

export function TaskResults({
  task,
  onStatus,
}: {
  task: Task
  onStatus: (task: Task, status: TaskStatus) => void
}) {
  const [document, setDocument] = useState<'requirements' | 'design' | 'pr'>('requirements')
  const [documentOpen, setDocumentOpen] = useState(false)
  function openDocument(value: 'requirements' | 'design' | 'pr') {
    setDocument(value)
    setDocumentOpen(true)
  }
  const complete = task.status === 'done'
  const gateway = task.requirementId === 'gateway'
  const criteria = gateway
    ? [
        '异常请求后连接可正确回收。',
        '并发压力下无持续连接泄漏。',
        '超时与重试路径正确释放连接。',
        '异常日志包含请求与连接追踪信息。',
        '端到端回归测试通过，正常请求无行为回退。',
      ]
    : [
        '功能满足已确认的需求范围。',
        '主要流程通过验收。',
        '异常路径可恢复且有清晰日志。',
        '边界条件验证通过。',
        '现有功能无回归。',
      ]
  if (!complete)
    return (
      <div className="result-pending">
        <h3>暂无最终结果</h3>
        <p>任务完成后将在此展示执行总结、文档、代码变更和测试结果。</p>
        <Button
          variant="outlined"
          onClick={() => onStatus(task, task.status === 'todo' ? 'running' : 'done')}
        >
          {task.status === 'todo' ? '模拟开始任务' : '模拟完成任务'}
        </Button>
      </div>
    )
  return (
    <>
      <section className="task-results" aria-label="任务执行结果">
        <div className="result-heading">
          <div>
            <h3>
              #{task.displayId ?? task.id} {task.title}
            </h3>
            <p>结果 · 示意数据</p>
          </div>
          <span className="result-complete-badge">已完成</span>
        </div>
        <div className="result-summary">
          <div className="result-summary-title">
            <h3>执行总结</h3>
            <CircleCheck size={18} className="result-success" aria-label="执行完成" />
          </div>
          <p>
            {gateway
              ? '已完成网关连接管理相关修复，并补充异常路径的日志与回归测试。全部 5 项验收条件已通过。'
              : `已完成「${task.title}」，并验证主要流程与异常路径。全部 5 项验收条件已通过。`}
          </p>
          <p className="result-demo-note">以下是模拟的最终成果，非真实任务执行结果。</p>
        </div>
        <details className="result-section" open>
          <summary>
            <FileText size={18} />
            <div>
              <strong>需求与验收标准</strong>
              <small>requirements.md · 5 项验收条件</small>
            </div>
            <ChevronRight size={18} className="result-chevron" />
          </summary>
          <div className="result-section-body">
            <p>需求：{gateway ? '消除异常情况下连接未释放的问题。' : task.description}</p>
            {criteria.slice(0, 2).map((text, i) => (
              <p key={text}>
                AC-0{i + 1}：{text}
              </p>
            ))}
            <Button
              variant="outlined"
              fullWidth
              endIcon={<ArrowUpRight size={14} />}
              onClick={() => openDocument('requirements')}
            >
              查看完整文档方案
            </Button>
          </div>
        </details>
        <details className="result-section">
          <summary>
            <CodeXml size={18} />
            <div>
              <strong>技术设计</strong>
              <small>design.md · v2</small>
            </div>
            <ChevronRight size={18} className="result-chevron" />
          </summary>
          <div className="result-section-body">
            <p>统一管理连接生命周期，在异常、超时和重试路径释放连接，并补充可追踪的结构化日志。</p>
            <Button
              variant="outlined"
              fullWidth
              endIcon={<ArrowUpRight size={14} />}
              onClick={() => openDocument('design')}
            >
              查看完整技术设计
            </Button>
          </div>
        </details>
        <details className="result-section">
          <summary>
            <GitBranch size={18} />
            <div>
              <strong>代码变更</strong>
              <small>3 commits · 1 PR</small>
            </div>
            <ChevronRight size={18} className="result-chevron" />
          </summary>
          <div className="result-section-body">
            <p className="result-code-row">
              <GitCommitHorizontal size={16} />
              {gateway ? 'fix: release connections on error' : `feat: ${task.title}`}
            </p>
            <p className="result-code-row">
              <GitCommitHorizontal size={16} />
              fix: add structured error logs
            </p>
            <p className="result-code-row">
              <GitCommitHorizontal size={16} />
              test: cover timeout and retry paths
            </p>
            <button className="result-pr-link" onClick={() => openDocument('pr')}>
              <GitBranch size={16} />
              PR #128 · {gateway ? 'Fix gateway connection cleanup' : task.title}
              <ArrowUpRight size={14} />
            </button>
            <p className="result-demo-note">
              当前 PR 为示意数据。接入真实仓库后可跳转到 GitHub / GitLab。
            </p>
          </div>
        </details>
        <details className="result-section">
          <summary>
            <CircleCheck size={18} />
            <div>
              <strong>测试结果</strong>
              <small>18 passed · 0 failed</small>
            </div>
            <ChevronRight size={18} className="result-chevron" />
          </summary>
          <div className="result-section-body">
            <p className="result-test-pass">
              <CircleCheck size={14} />
              单元测试 · 12 passed
            </p>
            <p className="result-test-pass">
              <CircleCheck size={14} />
              集成测试 · 5 passed
            </p>
            <p className="result-test-pass">
              <CircleCheck size={14} />
              端到端验收 · 1 passed
            </p>
            <p className="result-demo-note">以上为示意测试报告。</p>
          </div>
        </details>
      </section>
      <Dialog open={documentOpen} onClose={() => setDocumentOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle className="dialog-title">
          {document === 'requirements'
            ? 'requirements.md'
            : document === 'design'
              ? 'design.md · v2'
              : 'PR #128 · 示例变更'}
          <Action label="关闭结果文档" icon="close" onClick={() => setDocumentOpen(false)} />
        </DialogTitle>
        <DialogContent className="result-document">
          <p className="result-demo-note">任务 {task.displayId ?? task.id} · 示意数据</p>
          {document === 'requirements' ? (
            <>
              <h3>需求与验收标准</h3>
              <p>{task.description}</p>
              {criteria.map((text, i) => (
                <p key={text}>
                  AC-0{i + 1}：{text}
                </p>
              ))}
            </>
          ) : document === 'design' ? (
            <>
              <h3>连接生命周期管理</h3>
              <p>使用统一的连接释放入口，覆盖成功、异常、取消与超时分支。</p>
              <h3>日志与验证</h3>
              <p>
                记录请求标识、连接状态与重试次数。通过并发压力、超时和异常恢复测试验证资源回收。
              </p>
            </>
          ) : (
            <>
              <h3>{task.title}</h3>
              <p>此处展示的是示例 PR，尚未关联真实仓库链接。</p>
              <p>变更范围：连接释放、结构化日志、超时与重试回归测试。</p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
