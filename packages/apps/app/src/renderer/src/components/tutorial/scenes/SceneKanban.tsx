import { useState, useEffect } from 'react'
import { motion, LayoutGroup } from 'framer-motion'
import { Home, Plus, X } from 'lucide-react'
import { cn, PriorityIcon } from '@slayzone/ui'

interface MockTask {
  id: string
  title: string
  priority: number
}

function PriorityBars({ priority }: { priority: number }): React.JSX.Element {
  return <PriorityIcon priority={priority} />
}

function MockCard({ task, highlighted }: { task: MockTask; highlighted?: boolean }): React.JSX.Element {
  return (
    <motion.div
      layoutId={task.id}
      layout
      className={cn(
        'bg-background border rounded-md px-2.5 py-2 flex items-start gap-2 cursor-grab hover:bg-muted/50 transition-colors',
        highlighted && 'ring-2 ring-primary shadow-sm shadow-primary/20'
      )}
      transition={{ type: 'spring', stiffness: 280, damping: 28 }}
    >
      <PriorityBars priority={task.priority} />
      <p className="text-[10px] font-medium leading-tight line-clamp-3 flex-1">{task.title}</p>
    </motion.div>
  )
}

function MockColumn({
  title,
  tasks,
  highlightedId,
  flash,
}: {
  title: string
  tasks: MockTask[]
  highlightedId?: string
  flash?: boolean
}): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-1.5 mb-1.5 select-none">
        <div className="flex items-center gap-2">
          <h3 className={cn('text-[10px] font-semibold text-muted-foreground transition-colors', flash && 'text-primary')}>
            {title}
          </h3>
          <motion.span
            key={tasks.length}
            className="text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
            animate={{ scale: [1, 1.25, 1] }}
            transition={{ duration: 0.3 }}
          >
            {tasks.length}
          </motion.span>
        </div>
        <div className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground/60">
          <Plus className="size-3" />
        </div>
      </div>
      <div className={cn(
        'flex-1 rounded-lg bg-muted/30 p-2 flex flex-col gap-2 overflow-hidden transition-colors duration-300',
        flash && 'bg-primary/5'
      )}>
        {tasks.map((task) => (
          <MockCard key={task.id} task={task} highlighted={highlightedId === task.id} />
        ))}
      </div>
    </div>
  )
}

const INITIAL_BACKLOG: MockTask[] = [
  { id: 'auth', title: 'Set up authentication', priority: 1 },
  { id: 'design', title: 'Design system tokens', priority: 3 },
  { id: 'tests', title: 'Write integration tests', priority: 5 },
]
const INITIAL_IN_PROGRESS: MockTask[] = [
  { id: 'kanban', title: 'Build kanban board', priority: 1 },
]
const DONE: MockTask[] = [
  { id: 'landing', title: 'Landing page', priority: 4 },
]

export function SceneKanban(): React.JSX.Element {
  const [moved, setMoved] = useState(false)
  const [highlighted, setHighlighted] = useState(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    const t1 = setTimeout(() => setHighlighted(true), 900)
    const t2 = setTimeout(() => {
      setMoved(true)
      setHighlighted(false)
      setFlash(true)
    }, 1900)
    const t3 = setTimeout(() => setFlash(false), 2600)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
    }
  }, [])

  const backlog = moved ? INITIAL_BACKLOG.filter((t) => t.id !== 'auth') : INITIAL_BACKLOG
  const inProgress = moved ? [INITIAL_BACKLOG[0], ...INITIAL_IN_PROGRESS] : INITIAL_IN_PROGRESS

  return (
    <div className="w-full h-full flex flex-col rounded-xl border bg-background shadow-xl overflow-hidden">
      {/* Tab bar — Home tab active (kanban is the home view) */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-neutral-100 dark:bg-neutral-900/80">
        <div className="h-6 px-2 rounded-md flex items-center gap-1 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 shrink-0">
          <Home className="size-3 text-neutral-600 dark:text-neutral-300" />
        </div>
        {['Set up auth', 'Build API'].map((title) => (
          <div key={title} className="h-6 px-2.5 rounded-md flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800/50 shrink-0">
            <span className="text-[9px]">{title}</span>
            <div className="h-3 w-3 rounded flex items-center justify-center shrink-0"><X className="size-2" /></div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="h-7 shrink-0 border-b flex items-center px-2 gap-1.5">
        <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">All priorities</div>
        <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">Sort: Priority</div>
        <div className="flex-1" />
        <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">Group: Status</div>
      </div>

      {/* Kanban columns */}
      <LayoutGroup>
        <div className="flex-1 flex gap-3 p-3 overflow-hidden">
          <MockColumn
            title="Backlog"
            tasks={backlog}
            highlightedId={highlighted ? 'auth' : undefined}
          />
          <MockColumn
            title="In Progress"
            tasks={inProgress}
            flash={flash}
          />
          <MockColumn
            title="Done"
            tasks={DONE}
          />
        </div>
      </LayoutGroup>
    </div>
  )
}
