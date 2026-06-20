import { motion } from 'framer-motion'
import { Home, Settings, HelpCircle, Map, Keyboard, Plus, X } from 'lucide-react'

const PROJECTS = [
  { abbr: 'SZ', color: '#3b82f6' },
  { abbr: 'BE', color: '#10b981' },
  { abbr: 'MB', color: '#8b5cf6' }
]

interface MockTask {
  title: string
  priority: number
}

interface MockColumn {
  id: string
  title: string
  tasks: MockTask[]
}

const COLUMNS: MockColumn[] = [
  {
    id: 'backlog',
    title: 'Backlog',
    tasks: [
      { title: 'Set up authentication', priority: 1 },
      { title: 'Design system tokens', priority: 3 },
      { title: 'Write integration tests', priority: 5 }
    ]
  },
  {
    id: 'in_progress',
    title: 'In Progress',
    tasks: [
      { title: 'Build kanban board', priority: 1 },
      { title: 'REST API routes', priority: 2 }
    ]
  },
  {
    id: 'done',
    title: 'Done',
    tasks: [{ title: 'Landing page', priority: 4 }]
  }
]

const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-orange-500',
  3: 'bg-yellow-500',
  4: 'bg-blue-400',
  5: 'bg-muted-foreground/30'
}

function PriorityBars({ priority }: { priority: number }): React.JSX.Element {
  const filled = 5 - priority
  const color = PRIORITY_COLORS[priority]
  return (
    <span className="flex items-end gap-[1px] shrink-0 mt-0.5">
      {[2, 3, 4, 5].map((h, i) => (
        <span
          key={i}
          className={`w-[1.5px] rounded-[0.5px] ${i < filled ? color : 'bg-muted-foreground/20'}`}
          style={{ height: h }}
        />
      ))}
    </span>
  )
}

function MockCard({ task, delay }: { task: MockTask; delay: number }): React.JSX.Element {
  return (
    <motion.div
      className="bg-surface-1 border rounded-md px-1.5 py-1.5 flex items-start gap-1.5 cursor-grab hover:bg-muted/50"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, type: 'spring', stiffness: 400, damping: 25 }}
    >
      <PriorityBars priority={task.priority} />
      <p className="text-[8px] font-medium leading-tight line-clamp-2 flex-1">{task.title}</p>
    </motion.div>
  )
}

function MockColumn({ col, colDelay }: { col: MockColumn; colDelay: number }): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 flex flex-col min-w-0"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: colDelay }}
    >
      <div className="flex items-center justify-between px-1 mb-1 select-none">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-semibold text-muted-foreground">{col.title}</span>
          <span className="text-[7px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
            {col.tasks.length}
          </span>
        </div>
        <div className="w-4 h-4 rounded flex items-center justify-center text-muted-foreground/60">
          <Plus className="size-2.5" />
        </div>
      </div>
      <div className="flex-1 rounded-lg bg-muted/30 p-1.5 flex flex-col gap-1.5 overflow-hidden">
        {col.tasks.map((task, i) => (
          <MockCard key={task.title} task={task} delay={colDelay + 0.08 + i * 0.06} />
        ))}
      </div>
    </motion.div>
  )
}

export function SceneOverview(): React.JSX.Element {
  return (
    <div className="w-full h-full flex rounded-xl border bg-surface-0 shadow-xl overflow-hidden">
      {/* Sidebar */}
      <motion.div
        className="w-10 shrink-0 border-r flex flex-col items-center py-2 gap-1.5"
        initial={{ x: -10, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.25 }}
      >
        {/* macOS drag region — matches tab bar height */}
        <div className="h-9 w-full" />

        {/* All projects */}
        <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-[7px] font-semibold ring-2 ring-primary ring-offset-1 ring-offset-background">
          All
        </div>

        {/* Project blobs */}
        {PROJECTS.map((p, i) => (
          <motion.div
            key={p.abbr}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[7px] font-semibold text-white"
            style={{ backgroundColor: p.color }}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + i * 0.07, type: 'spring', stiffness: 400, damping: 20 }}
          >
            {p.abbr}
          </motion.div>
        ))}

        {/* Add project */}
        <div className="w-7 h-7 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center text-muted-foreground/50 text-sm leading-none">
          +
        </div>

        <div className="flex-1" />

        {/* Footer icons */}
        {[Map, HelpCircle, Keyboard, Settings].map((Icon, i) => (
          <div
            key={i}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground/60"
          >
            <Icon className="size-3" />
          </div>
        ))}
      </motion.div>

      {/* Right column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <motion.div
          className="h-9 shrink-0 flex items-center gap-1 px-2 bg-neutral-100 dark:bg-neutral-900/80"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.2 }}
        >
          {/* Home tab - active */}
          <div className="h-6 px-2 rounded-md flex items-center gap-1 bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 shrink-0">
            <Home className="size-3 text-neutral-600 dark:text-neutral-300" />
          </div>

          {/* Task tabs */}
          {['Set up auth', 'Build kanban'].map((title) => (
            <div
              key={title}
              className="h-6 px-2 rounded-md flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400 max-w-[110px] shrink-0"
            >
              <span className="text-[8px] truncate">{title}</span>
              <div className="h-3 w-3 rounded flex items-center justify-center shrink-0 hover:bg-muted-foreground/20">
                <X className="size-2" />
              </div>
            </div>
          ))}
        </motion.div>

        {/* Filter bar */}
        <motion.div
          className="h-7 shrink-0 border-b flex items-center px-2 gap-1.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">
            All priorities
          </div>
          <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">
            Sort: Priority
          </div>
          <div className="flex-1" />
          <div className="h-4 px-1.5 rounded bg-muted/60 text-[7px] text-muted-foreground flex items-center">
            Group: Status
          </div>
        </motion.div>

        {/* Kanban */}
        <div className="flex-1 flex gap-2 p-2 overflow-hidden">
          {COLUMNS.map((col, ci) => (
            <MockColumn key={col.id} col={col} colDelay={0.35 + ci * 0.1} />
          ))}
        </div>
      </div>
    </div>
  )
}
