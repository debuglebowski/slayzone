import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus } from 'lucide-react'
import { SceneShell } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'

interface MockTask {
  id: string
  title: string
  priority: number
}

interface ProjectData {
  backlog: MockTask[]
  inProgress: MockTask[]
  done: MockTask[]
}

const PROJECT_DATA: ProjectData[] = [
  {
    backlog: [
      { id: 'sz1', title: 'Set up authentication', priority: 1 },
      { id: 'sz2', title: 'Design system tokens', priority: 3 },
      { id: 'sz3', title: 'Write integration tests', priority: 5 }
    ],
    inProgress: [{ id: 'sz4', title: 'Build kanban board', priority: 1 }],
    done: [{ id: 'sz5', title: 'Landing page', priority: 4 }]
  },
  {
    backlog: [
      { id: 'be1', title: 'Rate limiting', priority: 2 },
      { id: 'be2', title: 'DB migrations', priority: 3 }
    ],
    inProgress: [
      { id: 'be3', title: 'REST API routes', priority: 1 },
      { id: 'be4', title: 'Auth middleware', priority: 2 }
    ],
    done: [
      { id: 'be5', title: 'Project setup', priority: 5 },
      { id: 'be6', title: 'Docker config', priority: 4 }
    ]
  },
  { backlog: [], inProgress: [], done: [] }
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
    <span className="flex items-end gap-[2px] shrink-0 mt-1">
      {[4, 6, 8, 10].map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-[1px] ${i < filled ? color : 'bg-muted-foreground/20'}`}
          style={{ height: h }}
        />
      ))}
    </span>
  )
}

function MockCard({ task, delay }: { task: MockTask; delay: number }): React.JSX.Element {
  return (
    <motion.div
      className="bg-surface-1 border rounded-lg px-3 py-3 flex items-start gap-3"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.2 }}
    >
      <PriorityBars priority={task.priority} />
      <p className="text-[16px] font-medium leading-tight line-clamp-2 flex-1">{task.title}</p>
    </motion.div>
  )
}

function KanbanBoard({ project }: { project: ProjectData }): React.JSX.Element {
  const cols = [
    { title: 'Backlog', tasks: project.backlog },
    { title: 'In Progress', tasks: project.inProgress },
    { title: 'Done', tasks: project.done }
  ]
  return (
    <div className="flex gap-4 p-4 flex-1 overflow-hidden">
      {cols.map((col, ci) => (
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
              <MockCard key={task.id} task={task} delay={ci * 0.05 + i * 0.06} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SceneProjects(): React.JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setActiveIdx(1), 1800)
    return () => clearTimeout(t)
  }, [])

  return (
    <SceneShell
      activeProject={activeIdx}
      tabs={[{ label: 'Set up auth' }, { label: 'Build kanban' }]}
    >
      {/* Kanban — animates when project switches */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeIdx}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.25 }}
          className="flex-1 flex min-h-0 overflow-hidden"
        >
          <KanbanBoard project={PROJECT_DATA[activeIdx]} />
        </motion.div>
      </AnimatePresence>
      <AnimatedCursor
        waypoints={[
          { x: '50%', y: '50%', delay: 0.5, click: false },
          { x: '3%', y: '18%', delay: 1.6 }
        ]}
      />
    </SceneShell>
  )
}
