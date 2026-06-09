import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dialog, DialogContent } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { useTelemetry, track } from '@slayzone/telemetry/client'
import { useTRPC } from '@slayzone/transport/client'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { STEP_NAMES, STEP_COUNT } from './onboardingConstants'
import { WelcomeStep } from './WelcomeStep'
import { DisclaimerStep } from './DisclaimerStep'
import { ProviderStep } from './ProviderStep'
import { AnalyticsStep } from './AnalyticsStep'
import { CliInstallStep } from './CliInstallStep'
import { SuccessStep } from './SuccessStep'

interface OnboardingDialogProps {
  externalOpen?: boolean
  onExternalClose?: () => void
}

export function OnboardingDialog({
  externalOpen,
  onExternalClose
}: OnboardingDialogProps): React.JSX.Element | null {
  const trpc = useTRPC()
  const [autoOpen, setAutoOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [selectedProvider, setSelectedProvider] = useState('claude-code')
  const [closing, setClosing] = useState(false)
  const { setTier } = useTelemetry()

  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())
  const onboardingCompletedQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'onboarding_completed' })
  )

  const open = autoOpen || (externalOpen ?? false)

  useEffect(() => {
    if (open) track('onboarding_step', { step, step_name: STEP_NAMES[step] })
  }, [step, open])

  useEffect(() => {
    if (onboardingCompletedQuery.isSuccess && onboardingCompletedQuery.data !== 'true') {
      setAutoOpen(true)
    }
  }, [onboardingCompletedQuery.isSuccess, onboardingCompletedQuery.data])

  const handleNext = (): void => {
    if (step === 2) {
      track('onboarding_provider_selected', { provider: selectedProvider })
      setSettingMutation.mutate({ key: 'default_terminal_mode', value: selectedProvider })
    }
    if (step < STEP_COUNT - 1) {
      setStep(step + 1)
    }
  }

  const handleBack = (): void => {
    if (step > 0) {
      setStep(step - 1)
    }
  }

  const handleSkip = (): void => {
    track('onboarding_skipped', { from_step: step, from_step_name: STEP_NAMES[step] })
    finishOnboarding()
  }

  const finishOnboarding = useCallback(
    (tier?: 'anonymous' | 'opted_in'): void => {
      if (tier) setTier(tier)
      setSettingMutation.mutate({ key: 'onboarding_completed', value: 'true' })
      setStep(0)
      setClosing(false)
      setAutoOpen(false)
      onExternalClose?.()
    },
    [setTier, onExternalClose, setSettingMutation]
  )

  const handleAnalyticsChoice = (tier: 'anonymous' | 'opted_in'): void => {
    setTier(tier)
    track('onboarding_completed', { provider: selectedProvider, tier })
    setSettingMutation.mutate({ key: 'onboarding_completed', value: 'true' })
    setStep(4)
  }

  const startClosing = useCallback((): void => {
    setClosing(true)
  }, [])

  const handleFadeOutComplete = useCallback((): void => {
    if (closing) finishOnboarding()
  }, [closing, finishOnboarding])

  // Keep dialog mounted during fade-out
  if (!open && !closing) return null

  return (
    <Dialog open={open || closing} onOpenChange={autoOpen ? () => {} : handleSkip}>
      <DialogContent
        className={cn(
          'p-0 overflow-hidden border-none shadow-none bg-transparent transition-[max-width] duration-300',
          step === 4 ? 'max-w-xl' : 'max-w-[460px]'
        )}
        showCloseButton={false}
        onEscapeKeyDown={autoOpen ? (e) => e.preventDefault() : undefined}
        onInteractOutside={autoOpen ? (e) => e.preventDefault() : undefined}
      >
        <motion.div
          className="bg-modal rounded-lg border shadow-lg"
          animate={{ opacity: closing ? 0 : 1, scale: closing ? 0.96 : 1 }}
          transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
          onAnimationComplete={handleFadeOutComplete}
        >
          {/* Top bar: back + skip — hidden on success screen and when nothing to show */}
          {step < 5 && (step > 0 || !autoOpen) && (
            <div className="flex items-center justify-between px-4 pt-4">
              <div className="w-9">
                {step > 0 && (
                  <IconButton
                    aria-label="Back"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={handleBack}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
              {!autoOpen && (
                <Button variant="ghost" className="text-muted-foreground" onClick={handleSkip}>
                  Skip
                </Button>
              )}
            </div>
          )}

          <div className="px-8 pb-8">
            <AnimatePresence mode="wait" initial={false}>
              {step === 0 && <WelcomeStep key="welcome" onNext={handleNext} />}

              {step === 1 && <DisclaimerStep key="disclaimer" onNext={handleNext} />}

              {step === 2 && (
                <ProviderStep
                  key="provider"
                  selectedProvider={selectedProvider}
                  onSelect={setSelectedProvider}
                  onNext={handleNext}
                />
              )}

              {step === 3 && <AnalyticsStep key="analytics" onChoose={handleAnalyticsChoice} />}

              {step === 4 && <CliInstallStep onNext={handleNext} />}

              {step === 5 && (
                <motion.div
                  key="success"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <SuccessStep onComplete={startClosing} />
                </motion.div>
              )}
            </AnimatePresence>

            {step < 5 && (
              <div className="flex justify-center gap-1.5 mt-5">
                {Array.from({ length: STEP_COUNT - 1 }).map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      'h-1 rounded-full transition-all duration-300',
                      i === step ? 'w-6 bg-primary' : 'w-2 bg-muted'
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
