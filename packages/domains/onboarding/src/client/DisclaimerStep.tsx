import { motion } from 'framer-motion'
import { Button } from '@slayzone/ui'
import { TriangleAlert } from 'lucide-react'

export function DisclaimerStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="text-center"
    >
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-yellow-500/10">
        <TriangleAlert className="h-7 w-7 text-yellow-500" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight mb-2">Your AI, your responsibility</h2>
      <p className="text-muted-foreground leading-relaxed mb-8">
        You decide when and how AI runs. We take no responsibility for anything it does or data it
        handles.
      </p>
      <Button onClick={onNext} className="w-full">
        I understand
      </Button>
    </motion.div>
  )
}
