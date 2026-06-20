import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Sparkles, ChevronDown, Calendar } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

/* ── Kanban data (simplified) ─────────────────────────────────────────── */

interface MockTask {
  id: string
  title: string
}

const COLS = [
  {
    title: 'Backlog',
    tasks: [
      { id: 't1', title: 'Set up authentication' },
      { id: 't2', title: 'Design system tokens' }
    ]
  },
  { title: 'In Progress', tasks: [{ id: 't3', title: 'Build kanban board' }] },
  { title: 'Done', tasks: [{ id: 't4', title: 'Landing page' }] }
]

/* ── Terminal lines (static, no typing) ───────────────────────────────── */

/* ── Sub-components ───────────────────────────────────────────────────── */

function KanbanCard({
  task,
  delay,
  highlight
}: {
  task: MockTask
  delay: number
  highlight?: boolean
}): React.JSX.Element {
  return (
    <motion.div
      className={`bg-surface-1 border rounded-lg px-3 py-3 ${highlight ? 'ring-2 ring-primary' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.2 }}
    >
      <p className="text-[16px] font-medium leading-tight">{task.title}</p>
    </motion.div>
  )
}

function KanbanView(): React.JSX.Element {
  return (
    <div className="flex gap-4 p-4 flex-1 overflow-hidden">
      {COLS.map((col, ci) => (
        <div key={col.title} className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-2 mb-2">
            <div className="flex items-center gap-3">
              <span className="text-[16px] font-semibold text-muted-foreground">{col.title}</span>
              <span className="text-[14px] text-muted-foreground bg-muted px-2 py-1 rounded">
                {col.tasks.length}
              </span>
            </div>
            <Plus className="size-5 text-muted-foreground/60" />
          </div>
          <div className="flex-1 rounded-xl bg-muted/30 p-3 flex flex-col gap-3 overflow-hidden">
            {col.tasks.map((task, i) => (
              <KanbanCard
                key={task.id}
                task={task}
                delay={ci * 0.05 + i * 0.06}
                highlight={task.id === 't3'}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TaskView(): React.JSX.Element {
  return (
    <>
      <TaskHeader title="Build kanban board" panels={panelButtons('Terminal', 'Settings')} />
      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal */}
        <div className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-neutral-950">
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4 gap-3">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20 shrink-0">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        {/* Settings panel */}
        <motion.div
          className="w-1/4 shrink-0 rounded-xl border overflow-hidden flex flex-col bg-surface-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          <div className="flex-1 p-6 flex flex-col overflow-y-auto">
            <div className="relative rounded-lg border min-h-[96px] p-4 mb-4">
              <span className="text-[15px] text-muted-foreground/40">Add description...</span>
              <Sparkles className="size-5 text-muted-foreground/30 absolute bottom-3 right-3" />
            </div>

            <div className="flex-1" />

            <div className="space-y-3">
              {[
                { label: 'Project', value: 'SlayZone', dot: 'bg-blue-500' },
                { label: 'Status', value: 'In Progress' },
                { label: 'Priority', value: 'High' }
              ].map((field) => (
                <div key={field.label}>
                  <span className="text-[14px] text-muted-foreground/50">{field.label}</span>
                  <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center justify-between px-3">
                    <div className="flex items-center gap-2">
                      {field.dot && (
                        <span className={`w-3 h-3 rounded-full ${field.dot} shrink-0`} />
                      )}
                      <span className="text-[14px] font-medium">{field.value}</span>
                    </div>
                    <ChevronDown className="size-4 text-muted-foreground/40" />
                  </div>
                </div>
              ))}

              <div>
                <span className="text-[14px] text-muted-foreground/50">Due Date</span>
                <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center gap-2 px-3">
                  <Calendar className="size-4 text-muted-foreground/40" />
                  <span className="text-[14px] text-muted-foreground/40">No date</span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </>
  )
}

/* ── Main scene ───────────────────────────────────────────────────────── */

export function SceneOpenTask(): React.JSX.Element {
  const [phase, setPhase] = useState<'kanban' | 'task'>('kanban')

  useEffect(() => {
    const t = setTimeout(() => setPhase('task'), 2000)
    return () => clearTimeout(t)
  }, [])

  return (
    <SceneShell
      tabs={phase === 'task' ? [{ label: 'Build kanban', active: true, dot: true }] : undefined}
    >
      <AnimatePresence mode="wait">
        {phase === 'kanban' ? (
          <motion.div
            key="kanban"
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <KanbanView />
          </motion.div>
        ) : (
          <motion.div
            key="task"
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <TaskView />
          </motion.div>
        )}
      </AnimatePresence>
      {phase === 'kanban' && (
        <AnimatedCursor
          waypoints={[
            { x: '50%', y: '50%', delay: 0.5, click: false },
            { x: '42%', y: '16%', delay: 1.8 }
          ]}
        />
      )}
    </SceneShell>
  )
}
