/**
 * Looping SVG animations for the model and effort pickers' info panes (the
 * mode picker has its own: `agent-mode-illustration`). Drawn in
 * `currentColor`; pure CSS keyframes so `prefers-reduced-motion` freezes them.
 */

// Keyframe names are global once the <style> mounts — all prefixed `apx-`.
const STYLE = `
.apx * { transform-box: fill-box; transform-origin: center; }
@keyframes apx-draw { 0% { stroke-dashoffset: 1 } 40%, 85% { stroke-dashoffset: 0; opacity: 1 } 100% { stroke-dashoffset: 0; opacity: 0 } }
@keyframes apx-node { 0%, 20% { transform: scale(0); opacity: 0 } 40%, 85% { transform: scale(1); opacity: 1 } 100% { transform: scale(1); opacity: 0 } }
@keyframes apx-core { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.25) } }
@keyframes apx-fill { 0% { fill-opacity: .12 } 25%, 85% { fill-opacity: .9 } 100% { fill-opacity: .12 } }
@media (prefers-reduced-motion: reduce) { .apx * { animation: none !important } }
`

const anim = (name: string, dur: number, delay = 0, easing = 'ease-in-out') => ({
  animation: `${name} ${dur}s ${easing} ${delay}s infinite`
})

/**
 * How capable (and heavy) a model is, 0..1 — drives the network size and
 * pace. Claude's aliases are known; other providers' models get the middle.
 */
const MODEL_COMPLEXITY: Record<string, number> = { opus: 1, sonnet: 0.6, haiku: 0.2 }

/**
 * A network that grows from a core: more nodes, drawn more slowly, for a more
 * capable model; a small, quick one for a fast model.
 */
export function AgentModelIllustration({
  model,
  className
}: {
  model: string
  className?: string
}) {
  const complexity = MODEL_COMPLEXITY[model] ?? 0.6
  const count = 3 + Math.round(complexity * 6)
  const dur = 1.6 + complexity * 2.4
  const step = (dur * 0.35) / count
  const nodes = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? 1 : 0.7
    return { x: 120 + Math.cos(a) * 70 * r, y: 36 + Math.sin(a) * 28 * r }
  })
  return (
    <svg
      viewBox="0 0 240 72"
      className={['apx', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <style>{STYLE}</style>
      {nodes.map((n, i) => (
        <line
          key={`l${n.x},${n.y}`}
          x1={120}
          y1={36}
          x2={n.x}
          y2={n.y}
          pathLength={1}
          strokeDasharray="1"
          stroke="currentColor"
          strokeOpacity={0.5}
          style={anim('apx-draw', dur, i * step)}
        />
      ))}
      {nodes.map((n, i) => (
        <circle
          key={`n${n.x},${n.y}`}
          cx={n.x}
          cy={n.y}
          r={3.5}
          fill="currentColor"
          style={anim('apx-node', dur, i * step)}
        />
      ))}
      <circle
        cx={120}
        cy={36}
        r={6}
        fill="currentColor"
        fillOpacity={0.25}
        stroke="currentColor"
        style={anim('apx-core', dur / 2)}
      />
    </svg>
  )
}

/**
 * Reasoning depth: a thought line that runs further, and a meter that fills
 * higher, the more effort the level spends. `index` is the level's place in
 * the model's `count` levels.
 */
export function AgentEffortIllustration({
  index,
  count,
  className
}: {
  index: number
  count: number
  className?: string
}) {
  const n = Math.max(count, 1)
  const level = Math.min(Math.max(index, 0), n - 1)
  const gap = 4
  const segW = (180 - gap * (n - 1)) / n
  const dur = 1.4 + n * 0.35
  const step = (dur * 0.5) / n
  // A wave of whole bumps (9 at the top level), alternating up and down.
  const bumps = Math.max(1, Math.round((9 * (level + 1)) / n))
  let d = 'M30 24'
  for (let b = 0; b < bumps; b++) d += ` q10 ${b % 2 === 0 ? -12 : 12} 20 0`
  return (
    <svg
      viewBox="0 0 240 72"
      className={['apx', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <style>{STYLE}</style>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1"
        style={anim('apx-draw', dur, 0, 'linear')}
      />
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={i}
          x={30 + i * (segW + gap)}
          y={46}
          width={segW}
          height={10}
          rx={2}
          fill="currentColor"
          fillOpacity={0.12}
          style={i <= level ? anim('apx-fill', dur, i * step) : undefined}
        />
      ))}
    </svg>
  )
}
