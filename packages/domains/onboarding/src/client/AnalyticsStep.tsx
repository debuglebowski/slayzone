import { motion } from 'framer-motion'
import { Button } from '@slayzone/ui'
import { BarChart3 } from 'lucide-react'
import { TRACKED_EVENTS, NOT_TRACKED } from './onboardingConstants'

interface AnalyticsStepProps {
  onChoose: (tier: 'anonymous' | 'opted_in') => void
}

export function AnalyticsStep({ onChoose }: AnalyticsStepProps): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="text-center mb-6">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <BarChart3 className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight mb-2">Analytics</h2>
        <p className="text-muted-foreground">
          We want to track as little as possible, but also get a feeling for what features are
          used.
        </p>
      </div>

      <div className="rounded-xl bg-muted/40 p-4 mb-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">We track</p>
        <ul className="space-y-2">
          {TRACKED_EVENTS.map((event) => (
            <li key={event} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15">
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
              </div>
              {event}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl bg-muted/40 p-4 mb-6">
        <p className="text-xs font-medium text-muted-foreground mb-2">We never track</p>
        <ul className="space-y-2">
          {NOT_TRACKED.map((event) => (
            <li key={event} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive/15">
                <div className="h-1.5 w-1.5 rounded-full bg-destructive" />
              </div>
              {event}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-sm text-muted-foreground text-left mb-6 leading-relaxed">
        Store a <strong className="text-foreground">random ID</strong> on your device so we can
        understand retention? No personal info leaves your machine.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" className="h-11" onClick={() => onChoose('anonymous')}>
          No
        </Button>
        <Button className="h-11" onClick={() => onChoose('opted_in')}>
          Yes
        </Button>
      </div>
    </motion.div>
  )
}
