import { motion } from 'framer-motion'
import { Button, cn } from '@slayzone/ui'
import { Check, SquareTerminal } from 'lucide-react'
import { PROVIDERS } from './onboardingConstants'

interface ProviderStepProps {
  selectedProvider: string
  onSelect: (mode: string) => void
  onNext: () => void
}

export function ProviderStep({
  selectedProvider,
  onSelect,
  onNext
}: ProviderStepProps): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="text-center mb-6">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <SquareTerminal className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight mb-2">Choose your default AI</h2>
        <p className="text-muted-foreground">
          Pick the CLI you use most. Change anytime in settings.
        </p>
      </div>
      <div className="space-y-1.5">
        {PROVIDERS.map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => onSelect(mode)}
            className={cn(
              'w-full flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium transition-all',
              selectedProvider === mode
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'hover:bg-muted/60'
            )}
          >
            <span>{label}</span>
            {selectedProvider === mode && <Check className="h-4 w-4" />}
          </button>
        ))}
      </div>
      <div className="mt-8">
        <Button onClick={onNext} className="w-full">
          Continue
        </Button>
      </div>
    </motion.div>
  )
}
