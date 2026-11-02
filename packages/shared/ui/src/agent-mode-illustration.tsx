/**
 * Small looping SVG animation per permission/runtime mode, shown in the mode
 * picker's info pane. Drawn in `currentColor` (the caller sets the mode's text
 * color); pure CSS keyframes so `prefers-reduced-motion` freezes them.
 */

// Keyframe names are global once the <style> mounts — all prefixed `ami-`.
const STYLE = `
.ami * { transform-box: fill-box; }
.ami .grow { transform-origin: left center; }
.ami .pop { transform-origin: center; }
@keyframes ami-scan { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(40px) } }
@keyframes ami-fade-in { 0%, 15% { opacity: 0 } 30%, 85% { opacity: 1 } 100% { opacity: 0 } }
@keyframes ami-ask-dot {
  0% { transform: translateX(0); opacity: 0 }
  8% { opacity: 1 }
  35%, 65% { transform: translateX(70px) }
  92% { opacity: 1 }
  100% { transform: translateX(170px); opacity: 0 }
}
@keyframes ami-ask-badge { 0%, 30%, 70%, 100% { transform: scale(1) } 40%, 60% { transform: scale(1.35) } }
@keyframes ami-ask-gate { 0%, 60% { opacity: 1 } 68%, 95% { opacity: .15 } 100% { opacity: 1 } }
@keyframes ami-grow { 0% { transform: scaleX(0) } 30%, 85% { transform: scaleX(1); opacity: 1 } 100% { transform: scaleX(1); opacity: 0 } }
@keyframes ami-pop { 0%, 60% { transform: scale(0); opacity: 0 } 75%, 90% { transform: scale(1); opacity: 1 } 100% { transform: scale(1); opacity: 0 } }
@keyframes ami-pass { 0% { transform: translateX(0); opacity: 0 } 10%, 85% { opacity: 1 } 100% { transform: translateX(190px); opacity: 0 } }
@keyframes ami-block {
  0% { transform: translateX(0); opacity: 0 }
  10% { opacity: 1 }
  45% { transform: translateX(78px) }
  100% { transform: translateX(0); opacity: 0 }
}
@keyframes ami-shield { 0%, 35%, 60%, 100% { transform: scale(1) } 45% { transform: scale(1.15) } }
@keyframes ami-bounce { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(78px) } }
@keyframes ami-out-r { 0% { transform: translate(0, 0); opacity: 0 } 15% { opacity: 1 } 100% { transform: translate(110px, -10px); opacity: 0 } }
@keyframes ami-out-l { 0% { transform: translate(0, 0); opacity: 0 } 15% { opacity: 1 } 100% { transform: translate(-110px, 10px); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .ami * { animation: none !important } }
`

const anim = (name: string, dur: number, delay = 0, easing = 'ease-in-out') => ({
  animation: `${name} ${dur}s ${easing} ${delay}s infinite`
})

function Doc({ x }: { x: number }) {
  return (
    <rect
      x={x}
      y={8}
      width={64}
      height={56}
      rx={5}
      fill="none"
      stroke="currentColor"
      strokeOpacity={0.6}
    />
  )
}

function Lines({ x, grow }: { x: number; grow?: boolean }) {
  const widths = [44, 34, 44, 24]
  return (
    <>
      {widths.map((w, i) => (
        <rect
          key={w + i * 100}
          className={grow ? 'grow' : undefined}
          x={x + 10}
          y={19 + i * 11}
          width={w}
          height={3}
          rx={1.5}
          fill="currentColor"
          fillOpacity={grow ? 0.7 : 0.3}
          style={grow ? anim('ami-grow', 3.2, i * 0.35, 'ease-out') : undefined}
        />
      ))}
    </>
  )
}

function Track() {
  return (
    <line
      x1={16}
      y1={36}
      x2={224}
      y2={36}
      stroke="currentColor"
      strokeOpacity={0.2}
      strokeDasharray="3 4"
    />
  )
}

function Scene({ mode }: { mode: string }) {
  switch (mode) {
    case 'plan':
      // Reads the code (scan bar), then writes the plan (checklist).
      return (
        <>
          <Doc x={60} />
          <Lines x={60} />
          <rect
            x={63}
            y={13}
            width={58}
            height={6}
            rx={2}
            fill="currentColor"
            fillOpacity={0.25}
            style={anim('ami-scan', 2.6)}
          />
          {[0, 1, 2].map((i) => (
            <g key={i} style={anim('ami-fade-in', 3.6, i * 0.4)}>
              <path
                d={`M150 ${22 + i * 14} l3 3 l5 -6`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect
                x={163}
                y={20 + i * 14}
                width={i === 1 ? 22 : 30}
                height={3}
                rx={1.5}
                fill="currentColor"
                fillOpacity={0.5}
              />
            </g>
          ))}
        </>
      )
    case 'ask':
      // Each action stops at the gate until you approve it.
      return (
        <>
          <Track />
          <line
            x1={120}
            y1={22}
            x2={120}
            y2={54}
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            style={anim('ami-ask-gate', 4)}
          />
          <g className="pop" style={anim('ami-ask-badge', 4)}>
            <circle
              cx={120}
              cy={13}
              r={7}
              fill="currentColor"
              fillOpacity={0.15}
              stroke="currentColor"
            />
            <text
              x={120}
              y={16.5}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="currentColor"
            >
              ?
            </text>
          </g>
          <circle cx={36} cy={36} r={5} fill="currentColor" style={anim('ami-ask-dot', 4)} />
        </>
      )
    case 'auto-accept':
    case 'auto-accept-edits':
      // Edits land on their own; for Codex, inside the project folder only.
      return (
        <>
          {mode === 'auto-accept-edits' && (
            <rect
              x={44}
              y={4}
              width={152}
              height={64}
              rx={8}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeDasharray="4 4"
            />
          )}
          <Doc x={70} />
          <Lines x={70} grow />
          <g className="pop" style={anim('ami-pop', 3.2)}>
            <circle
              cx={164}
              cy={36}
              r={11}
              fill="currentColor"
              fillOpacity={0.15}
              stroke="currentColor"
            />
            <path
              d="M159 36 l3.5 3.5 l6.5 -7"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </>
      )
    case 'auto':
      // A classifier lets safe actions through and turns risky ones back.
      return (
        <>
          <Track />
          <g className="pop" style={anim('ami-shield', 3)}>
            <path
              d="M120 18 l14 5 v10 c0 9 -6 15 -14 18 c-8 -3 -14 -9 -14 -18 v-10 z"
              fill="currentColor"
              fillOpacity={0.15}
              stroke="currentColor"
              strokeLinejoin="round"
            />
          </g>
          <circle
            cx={26}
            cy={36}
            r={4.5}
            fill="currentColor"
            style={anim('ami-pass', 3, 0, 'linear')}
          />
          <circle
            cx={26}
            cy={36}
            r={4.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            style={anim('ami-block', 3, 1)}
          />
          <circle
            cx={26}
            cy={36}
            r={4.5}
            fill="currentColor"
            style={anim('ami-pass', 3, 2, 'linear')}
          />
        </>
      )
    case 'bypass':
      // No gate at all: everything streams straight through.
      return (
        <>
          <Track />
          <line
            x1={120}
            y1={22}
            x2={120}
            y2={30}
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <line
            x1={120}
            y1={42}
            x2={120}
            y2={50}
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={2}
            strokeLinecap="round"
          />
          {[0, 0.4, 0.8, 1.2].map((d) => (
            <circle
              key={d}
              cx={26}
              cy={36}
              r={4}
              fill="currentColor"
              style={anim('ami-pass', 1.6, d, 'linear')}
            />
          ))}
        </>
      )
    case 'approval-required':
      // Read-only sandbox: anything more waits at the wall for approval.
      return (
        <>
          <rect
            x={50}
            y={12}
            width={140}
            height={48}
            rx={8}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.6}
          />
          <g transform="translate(112 1)">
            <rect x={3} y={8} width={10} height={8} rx={1.5} fill="currentColor" />
            <path
              d="M5 8 v-2.5 a3 3 0 0 1 6 0 v2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            />
          </g>
          <g className="pop" style={anim('ami-ask-badge', 3)}>
            <circle
              cx={190}
              cy={36}
              r={7}
              fill="currentColor"
              fillOpacity={0.15}
              stroke="currentColor"
            />
            <text
              x={190}
              y={39.5}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="currentColor"
            >
              ?
            </text>
          </g>
          <circle cx={92} cy={36} r={5} fill="currentColor" style={anim('ami-bounce', 3)} />
        </>
      )
    case 'full-access':
      // No sandbox: actions leave the project freely.
      return (
        <>
          <rect
            x={80}
            y={12}
            width={80}
            height={48}
            rx={8}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeDasharray="3 5"
          />
          {[0, 0.8, 1.6].map((d) => (
            <circle
              key={`r${d}`}
              cx={120}
              cy={36}
              r={4}
              fill="currentColor"
              style={anim('ami-out-r', 2.4, d, 'ease-out')}
            />
          ))}
          {[0.4, 1.2, 2].map((d) => (
            <circle
              key={`l${d}`}
              cx={120}
              cy={36}
              r={4}
              fill="currentColor"
              style={anim('ami-out-l', 2.4, d, 'ease-out')}
            />
          ))}
        </>
      )
    default:
      return null
  }
}

export function AgentModeIllustration({ mode, className }: { mode: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 240 72"
      className={['ami', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <style>{STYLE}</style>
      <Scene mode={mode} />
    </svg>
  )
}
