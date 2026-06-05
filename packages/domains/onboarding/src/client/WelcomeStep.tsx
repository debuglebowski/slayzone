import { motion } from 'framer-motion'
import { Button } from '@slayzone/ui'
import { Sparkles } from 'lucide-react'

export function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="text-center"
    >
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
        <Sparkles className="h-7 w-7 text-primary" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-2">Welcome to SlayZone</h2>
      <p className="text-muted-foreground leading-relaxed">
        A task manager with built-in AI coding terminals for AI-assisted development.
      </p>
      <div className="mt-8">
        <Button onClick={onNext} className="w-full">
          Continue
        </Button>
      </div>
    </motion.div>
  )
}
