import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Dialog, DialogContent } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { useTelemetry } from '@slayzone/telemetry/client'
import { Check, BarChart3, Sparkles, SquareTerminal, ChevronLeft, TriangleAlert } from 'lucide-react'

const STEP_COUNT = 5

const PROVIDERS = [
  { mode: 'claude-code', label: 'Claude Code' },
  { mode: 'codex', label: 'Codex' },
  { mode: 'cursor-agent', label: 'Cursor' },
  { mode: 'gemini', label: 'Gemini' },
  { mode: 'opencode', label: 'OpenCode' }
]

const TRACKED_EVENTS = [
  'App opened (with version number)',
  'Activity heartbeat every 10 minutes while app is active and in the foreground'
]

function SuccessStep({ onComplete }: { onComplete: () => void }): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onComplete, 1800)
    return () => clearTimeout(timer)
  }, [onComplete])

  return (
    <div className="text-center py-6">
      <motion.div
        className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/15"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
      >
        <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
          <motion.path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-green-500"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, delay: 0.3, ease: 'easeOut' }}
          />
        </svg>
      </motion.div>
      <motion.h2
        className="text-2xl font-semibold tracking-tight mb-2"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        You're all set!
      </motion.h2>
      <motion.p
        className="text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
      >
        Let's build something great.
      </motion.p>
    </div>
  )
}

interface OnboardingDialogProps {
  externalOpen?: boolean
  onExternalClose?: () => void
}

export function OnboardingDialog({
  externalOpen,
  onExternalClose
}: OnboardingDialogProps): React.JSX.Element | null {
  const [autoOpen, setAutoOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1) // 1 = forward, -1 = back
  const [selectedProvider, setSelectedProvider] = useState('claude-code')
  const [closing, setClosing] = useState(false)
  const { setTier } = useTelemetry()

  const [contentHeight, setContentHeight] = useState<number | 'auto'>('auto')
  const contentRef = useRef<HTMLDivElement>(null)

  const measureHeight = useCallback(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [])

  const open = autoOpen || (externalOpen ?? false)

  useEffect(() => {
    window.api.settings.get('onboarding_completed').then((value) => {
      if (value !== 'true') {
        setAutoOpen(true)
      }
    }).catch(() => {})
  }, [])

  const handleNext = (): void => {
    if (step === 2) {
      window.api.settings.set('default_terminal_mode', selectedProvider)
    }
    if (step < STEP_COUNT - 1) {
      setDirection(1)
      setStep(step + 1)
    }
  }

  const handleBack = (): void => {
    if (step > 0) {
      setDirection(-1)
      setStep(step - 1)
    }
  }

  const handleSkip = (): void => {
    finishOnboarding()
  }

  const finishOnboarding = useCallback((tier?: 'anonymous' | 'opted_in'): void => {
    if (tier) setTier(tier)
    window.api.settings.set('onboarding_completed', 'true')
    setStep(0)
    setClosing(false)
    setAutoOpen(false)
    onExternalClose?.()
  }, [setTier, onExternalClose])

  const startClosing = useCallback((): void => {
    setClosing(true)
  }, [])

  const handleFadeOutComplete = useCallback((): void => {
    if (closing) finishOnboarding()
  }, [closing, finishOnboarding])

  // Keep dialog mounted during fade-out
  if (!open && !closing) return null

  return (
    <Dialog open={open || closing} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[460px] p-0 overflow-hidden border-none shadow-none bg-transparent"
        showCloseButton={false}
        onEscapeKeyDown={handleSkip}
      >
        <motion.div
          className="bg-background rounded-lg border shadow-lg"
          animate={{ opacity: closing ? 0 : 1, scale: closing ? 0.96 : 1 }}
          transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
          onAnimationComplete={handleFadeOutComplete}
        >
          {/* Top bar: back + skip — hidden on success screen */}
          {step < 4 && (
            <div className="flex items-center justify-between px-4 pt-4">
              <div className="w-9">
                {step > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={handleBack}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={handleSkip}
              >
                Skip
              </Button>
            </div>
          )}

          <div className="px-8 pb-8">
            <motion.div
              animate={{ height: contentHeight }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              style={{ overflow: 'hidden' }}
            >
            <AnimatePresence mode="wait" onExitComplete={measureHeight}>
              <motion.div
                key={step}
                ref={contentRef}
                initial={{ opacity: 0, x: direction * 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -20 }}
                transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
                onAnimationComplete={measureHeight}
              >
                {/* Step 0: Welcome */}
                {step === 0 && (
                  <div className="text-center">
                    <motion.div
                      className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.1 }}
                    >
                      <Sparkles className="h-7 w-7 text-primary" />
                    </motion.div>
                    <h2 className="text-2xl font-semibold tracking-tight mb-2">Welcome to SlayZone</h2>
                    <p className="text-muted-foreground leading-relaxed">
                      A task manager with built-in AI coding terminals for AI-assisted development.
                    </p>
                  </div>
                )}

                {/* Step 1: Disclaimer */}
                {step === 1 && (
                  <div className="text-center">
                    <motion.div
                      className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-yellow-500/10"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.1 }}
                    >
                      <TriangleAlert className="h-7 w-7 text-yellow-500" />
                    </motion.div>
                    <h2 className="text-2xl font-semibold tracking-tight mb-2">Your AI, your responsibility</h2>
                    <p className="text-muted-foreground leading-relaxed mb-8">
                      You decide when and how AI runs. We take no responsibility for anything it does or data it handles.
                    </p>
                    <Button onClick={handleNext} className="w-full">
                      I understand
                    </Button>
                  </div>
                )}

                {/* Step 2: Provider selection */}
                {step === 2 && (
                  <div>
                    <div className="text-center mb-6">
                      <motion.div
                        className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.1 }}
                      >
                        <SquareTerminal className="h-7 w-7 text-primary" />
                      </motion.div>
                      <h2 className="text-2xl font-semibold tracking-tight mb-2">Choose your default AI</h2>
                      <p className="text-muted-foreground">
                        Pick the CLI you use most. Change anytime in settings.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      {PROVIDERS.map(({ mode, label }, i) => (
                        <motion.button
                          key={mode}
                          onClick={() => setSelectedProvider(mode)}
                          initial={{ opacity: 0, x: -12 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.05 * i, duration: 0.2 }}
                          className={cn(
                            'w-full flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium transition-all',
                            selectedProvider === mode
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'hover:bg-muted/60'
                          )}
                        >
                          <span>{label}</span>
                          {selectedProvider === mode && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                            >
                              <Check className="h-4 w-4" />
                            </motion.div>
                          )}
                        </motion.button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Step 4: Success */}
                {step === 4 && (
                  <SuccessStep onComplete={startClosing} />
                )}

                {/* Step 3: Analytics */}
                {step === 3 && (
                  <div>
                    <div className="text-center mb-6">
                      <motion.div
                        className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.1 }}
                      >
                        <BarChart3 className="h-7 w-7 text-primary" />
                      </motion.div>
                      <h2 className="text-2xl font-semibold tracking-tight mb-2">Analytics</h2>
                      <p className="text-muted-foreground">
                        We always collect the following anonymously:
                      </p>
                    </div>

                    <div className="rounded-xl bg-muted/40 p-4 mb-8">
                      <ul className="space-y-2">
                        {TRACKED_EVENTS.map((event, i) => (
                          <motion.li
                            key={event}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.04 * i, duration: 0.2 }}
                            className="flex items-start gap-2.5 text-sm text-muted-foreground"
                          >
                            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15">
                              <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                            </div>
                            {event}
                          </motion.li>
                        ))}
                      </ul>
                    </div>

                    <p className="text-sm text-muted-foreground text-left mb-2 leading-relaxed">
                      To understand how often people come back, we can store a <strong className="text-foreground">random anonymous ID</strong> locally on your device. No personal info, no IP recording.
                    </p>
                    <p className="text-sm text-muted-foreground text-left mb-6">
                      All good?
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant="outline"
                        className="h-11"
                        onClick={() => {
                          setTier('anonymous')
                          window.api.settings.set('onboarding_completed', 'true')
                          setDirection(1)
                          setStep(4)
                        }}
                      >
                        No
                      </Button>
                      <Button
                        className="h-11"
                        onClick={() => {
                          setTier('opted_in')
                          window.api.settings.set('onboarding_completed', 'true')
                          setDirection(1)
                          setStep(4)
                        }}
                      >
                        Yes
                      </Button>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
            </motion.div>

            {/* Step indicators + actions — hidden on success screen and disclaimer (has own button) */}
            {step < 4 && (
              <div className="mt-8">
                {/* Continue button — not on disclaimer step (has own button) or analytics step */}
                {step !== 1 && step < 3 && (
                  <Button onClick={handleNext} className="w-full">
                    Continue
                  </Button>
                )}

                {/* Progress bar */}
                <div className="flex justify-center gap-1.5 mt-5">
                  {Array.from({ length: STEP_COUNT - 1 }).map((_, i) => (
                    <motion.div
                      key={i}
                      className={cn(
                        'h-1 rounded-full transition-colors',
                        i === step ? 'bg-primary' : 'bg-muted'
                      )}
                      animate={{ width: i === step ? 24 : 8 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
