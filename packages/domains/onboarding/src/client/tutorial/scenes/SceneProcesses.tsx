import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Copy, CornerDownLeft, MoreHorizontal } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

interface Process {
  name: string
  command: string
  status: 'running' | 'idle'
}

const PROCESSES: { scope: string; items: Process[] }[] = [
  {
    scope: 'Global',
    items: [
      { name: 'Dev Server', command: 'pnpm dev', status: 'running' },
      { name: 'Convex Dev', command: 'pnpx convex dev', status: 'idle' }
    ]
  },
  {
    scope: 'Set up auth',
    items: [
      { name: 'Type Check', command: 'pnpm typecheck --watch', status: 'running' },
      { name: 'Test Runner', command: 'pnpm test:unit --watch', status: 'running' }
    ]
  },
  {
    scope: 'Build kanban',
    items: [{ name: 'Storybook', command: 'pnpm storybook', status: 'idle' }]
  }
]

function ProcessRow({ process, delay }: { process: Process; delay: number }): React.JSX.Element {
  return (
    <motion.div
      className="flex items-center gap-3 px-4 py-3 border rounded-lg bg-surface-1"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.15 }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-semibold truncate">{process.name}</p>
        <p className="text-[12px] text-muted-foreground/50 font-mono truncate">{process.command}</p>
      </div>
      <div
        className={`h-6 px-2 rounded flex items-center gap-1.5 text-[11px] font-medium shrink-0 ${
          process.status === 'running'
            ? 'bg-green-500/10 text-green-500'
            : 'bg-muted text-muted-foreground/50'
        }`}
      >
        {process.status === 'running' && (
          <motion.span
            className="w-1.5 h-1.5 rounded-full bg-green-500"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.4, repeat: Infinity }}
          />
        )}
        {process.status === 'running' ? 'Running' : 'Idle'}
      </div>
      <div className="flex items-center gap-1 shrink-0 text-muted-foreground/30">
        <Play className="size-4" />
        <Copy className="size-4" />
        <CornerDownLeft className="size-4" />
        <MoreHorizontal className="size-4" />
      </div>
    </motion.div>
  )
}

function ProcessesPanel(): React.JSX.Element {
  let idx = 0

  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-surface-1"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="h-12 shrink-0 border-b flex items-center justify-between px-5">
        <span className="text-[16px] font-semibold">Processes</span>
        <span className="text-[13px] text-muted-foreground/50">+ New process</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {PROCESSES.map((group) => (
          <div key={group.scope}>
            <span className="text-[11px] font-semibold text-muted-foreground/40 uppercase tracking-wider px-1">
              {group.scope}
            </span>
            <div className="flex flex-col gap-2 mt-1.5">
              {group.items.map((p) => {
                const d = 0.1 + idx * 0.06
                idx++
                return <ProcessRow key={p.name} process={p} delay={d} />
              })}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

export function SceneProcesses(): React.JSX.Element {
  const [showProcesses, setShowProcesses] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShowProcesses(true), 2000)
    return () => clearTimeout(t)
  }, [])

  return (
    <SceneShell tabs={[{ label: 'Set up auth', active: true, dot: true }]}>
      <TaskHeader
        title="Set up authentication"
        panels={panelButtons('Terminal', ...(showProcesses ? (['Processes'] as const) : []))}
      />

      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal — full width initially, shrinks when processes opens */}
        <div
          className={`${showProcesses ? 'w-2/5' : 'flex-1'} shrink-0 rounded-xl border overflow-hidden flex flex-col bg-neutral-950 transition-all duration-300`}
        >
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        {/* Processes panel — appears after click */}
        <AnimatePresence>{showProcesses && <ProcessesPanel />}</AnimatePresence>
      </div>
      <AnimatedCursor
        waypoints={[
          { x: '50%', y: '50%', delay: 0.5, click: false },
          { x: '85%', y: '10%', delay: 1.8 }
        ]}
      />
    </SceneShell>
  )
}
