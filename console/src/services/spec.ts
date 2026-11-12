import type { SpecPhase, TaskStatus } from '../types'

export function createSpecPhases(title: string, status: TaskStatus): SpecPhase[] {
  const phases: [SpecPhase['name'], [string, string][]][] = [
    [
      'Requirements',
      [
        ['分析故障场景与目标', 'PM Agent'],
        ['定义验收标准 AC-01 ~ AC-05', 'PM Agent'],
      ],
    ],
    [
      'Design',
      [
        ['设计连接释放与超时策略', 'Architect'],
        ['设计重试路径与异常处理', 'Architect'],
        ['评审技术方案', 'Reviewer'],
      ],
    ],
    ['Planning', [['拆解开发任务与依赖', 'Planner']]],
    [
      'Execution',
      [
        ['实现连接释放修复', 'Backend'],
        ['完善错误日志与健康检查', 'Backend'],
        ['补充回归测试', 'Developer'],
      ],
    ],
    ['Verification', [['执行端到端验收', 'QA']]],
  ]
  // Gateway is the detailed sample; other tasks retain their own subject.
  if (title !== '修复网关间歇 503') {
    phases[0][1][0][0] = `明确「${title}」的目标与范围`
    phases[1][1][0][0] = `设计「${title}」的实现方案`
    phases[1][1][1][0] = '设计接口、边界与异常处理'
    phases[3][1][0][0] = `实现「${title}」`
    phases[3][1][1][0] = '处理边界情况与异常路径'
  }
  return phases.map(([name, steps], phaseIndex) => ({
    name,
    steps: steps.map(([stepTitle, owner], index) => ({
      id: `${name}-${index}`,
      title: stepTitle,
      owner,
      completed: status === 'done' || (status === 'running' && phaseIndex === 0),
    })),
  }))
}
