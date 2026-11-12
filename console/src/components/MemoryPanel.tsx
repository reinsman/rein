import type { Agent } from '../types'
import { Icon } from './shared'

const nodes = [
  { id: 'agent', x: 260, y: 205, label: '', main: true },
  { id: 'project', x: 405, y: 105, label: '项目' },
  { id: 'requirement', x: 422, y: 296, label: '需求' },
  { id: 'session', x: 112, y: 302, label: '会话' },
  { id: 'knowledge', x: 270, y: 385, label: '知识' },
]
const edges = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [3, 4],
]
export function MemoryPanel({ agent }: { agent: Agent }) {
  return (
    <section className="memory-panel" aria-label="Memory 栏">
      <header className="panel-header">
        <Icon name="flow" size={20} />
        <h2>Memory</h2>
        <span className="spacer" />
        <span className="memory-planning">规划中</span>
      </header>
      <div className="memory-body">
        <div className="memory-intro">
          <h3>{agent.name} 的 Memory</h3>
          <p>知识图谱示意</p>
        </div>
        <svg
          className="memory-graph"
          viewBox="0 0 520 470"
          role="img"
          aria-label={`${agent.name} 的知识图谱占位示意，非真实记忆数据`}
        >
          <title>Memory 知识图谱示意</title>
          {edges.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={nodes[a].x}
              y1={nodes[a].y}
              x2={nodes[b].x}
              y2={nodes[b].y}
              stroke="#d9e0eb"
              strokeWidth="1"
            />
          ))}
          {nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.x},${node.y})`}>
              {node.main ? (
                <>
                  <circle r="34" fill="#eaf2ff" stroke="#c8dcff" />
                  <text textAnchor="middle" dominantBaseline="central" fill="#0866ff" fontSize="13">
                    {agent.name}
                  </text>
                </>
              ) : (
                <>
                  <rect
                    x="-44"
                    y="-17"
                    width="88"
                    height="34"
                    rx="6"
                    fill="#f7f8fa"
                    stroke="#e5e8ef"
                  />
                  <text textAnchor="middle" dominantBaseline="central" fill="#7a8190" fontSize="12">
                    {node.label}
                  </text>
                </>
              )}
            </g>
          ))}
        </svg>
        <p className="memory-placeholder-note">Memory 的内容与结构尚在规划，图谱仅作界面占位。</p>
      </div>
    </section>
  )
}
