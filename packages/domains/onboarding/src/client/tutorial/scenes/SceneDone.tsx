import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'

export function SceneDone(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-5 h-full py-8">
      <motion.div
        className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 350, damping: 20, delay: 0.05 }}
      >
        <Sparkles className="w-9 h-9 text-primary" />
      </motion.div>

      <div className="text-center">
        <motion.h2
          className="text-2xl font-semibold tracking-tight"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          Ready to build
        </motion.h2>
        <motion.p
          className="text-muted-foreground mt-2 max-w-xs"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
        >
          Create a project, add tasks, and let your AI agent do the heavy lifting.
        </motion.p>
      </div>

      {/* Feature pills */}
      <motion.div
        className="flex flex-wrap justify-center gap-2 mt-2"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        {['Kanban board', 'AI terminals', 'Git worktrees', 'Multi-agent'].map((pill) => (
          <span
            key={pill}
            className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-muted text-muted-foreground"
          >
            {pill}
          </span>
        ))}
      </motion.div>
    </div>
  )
}
