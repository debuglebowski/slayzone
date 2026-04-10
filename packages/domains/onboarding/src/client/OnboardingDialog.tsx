import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dialog, DialogContent } from '@slayzone/ui'
import { Button, IconButton } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { useTelemetry, track } from '@slayzone/telemetry/client'
import { Check, BarChart3, Sparkles, SquareTerminal, ChevronLeft, TriangleAlert, Terminal } from 'lucide-react'

const STEP_NAMES = ['welcome', 'disclaimer', 'provider', 'analytics', 'cli', 'success'] as const
const STEP_COUNT = STEP_NAMES.length

const PROVIDERS = [
  { mode: 'claude-code', label: 'Claude Code' },
  { mode: 'codex', label: 'Codex' },
  { mode: 'cursor-agent', label: 'Cursor' },
  { mode: 'gemini', label: 'Gemini' },
  { mode: 'opencode', label: 'OpenCode' },
  { mode: 'qwen-code', label: 'Qwen Code' },
  { mode: 'copilot', label: 'Copilot' }
]

const TRACKED_EVENTS = [
  'App version, active time, and crash reports',
  'Feature usage (tasks, terminal, editor, git, browser)',
  'Navigation and keyboard shortcuts',
  'Settings and theme changes',
]

const NOT_TRACKED = [
  'Your code, files, or terminal content',
  'AI conversations or prompts',
  'Any project data',
]

const CLI_FEATURES = [
  { cmd: 'slay tasks', desc: 'List and filter tasks' },
  { cmd: 'slay tasks add', desc: 'Create tasks from the command line' },
  { cmd: 'slay projects', desc: 'Switch between projects' },
  { cmd: 'slay init', desc: 'Set up AI config for a project' },
]

function CliInstallStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState('')
  const [installed, setInstalled] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.app.cliStatus().then((status) => {
      setInstalled(status.installed)
    })
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    setMessage('')
    try {
      const result = await window.api.app.installCli()
      if (result.ok) {
        setInstalled(true)
        let msg = 'Installed successfully.'
        if (result.pathNotInPATH) msg += " Note: the install directory is not in your PATH. Add it to use 'slay' from any terminal."
        setMessage(msg)
      } else if (result.elevationCancelled) {
        setMessage('Install cancelled. You can try again later from Settings.')
      } else if (result.permissionDenied) {
        setMessage(`Permission denied. Run in Terminal:\n${result.error}`)
      } else {
        setMessage(result.error ?? 'Install failed.')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Install failed.')
    } finally {
      setInstalling(false)
    }
  }

  // Loading state while checking
  if (installed === null) return <div />

  return (
    <motion.div
      key="cli"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {!installed && (
        <div className="text-center mb-6">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Terminal className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Install the slay CLI</h2>
          <p className="text-muted-foreground text-balance">
            Manage tasks and projects from the terminal, or let your AI agents do it.
          </p>
        </div>
      )}

      {!installed && (
        <div className="rounded-xl border overflow-hidden mb-6">
          <table className="w-full text-sm">
            <tbody>
              {CLI_FEATURES.map(({ cmd, desc }, i) => (
                <tr key={cmd} className={i > 0 ? 'border-t' : ''}>
                  <td className="px-4 py-2.5">
                    <code className="text-xs font-medium">{cmd}</code>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {installed ? (
        <div className="text-center">
          <motion.div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none">
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
          <motion.p
            className="text-sm text-muted-foreground mb-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            CLI installed.
          </motion.p>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            <Button onClick={onNext} className="w-full h-11">Continue</Button>
          </motion.div>
        </div>
      ) : (
        <>
      {message && (
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap text-left mb-4">{message}</pre>
      )}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" className="h-11" onClick={onNext} disabled={installing}>
            Skip
          </Button>
          <Button className="h-11" onClick={handleInstall} disabled={installing}>
            {installing ? 'Installing…' : 'Install'}
          </Button>
        </div>
        </>
      )}
    </motion.div>
  )
}

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
  const [selectedProvider, setSelectedProvider] = useState('claude-code')
  const [closing, setClosing] = useState(false)
  const { setTier } = useTelemetry()

  const open = autoOpen || (externalOpen ?? false)

  useEffect(() => {
    if (open) track('onboarding_step', { step, step_name: STEP_NAMES[step] })
  }, [step, open])

  useEffect(() => {
    window.api.settings.get('onboarding_completed').then((value) => {
      if (value !== 'true') {
        setAutoOpen(true)
      }
    })
  }, [])

  const handleNext = (): void => {
    if (step === 2) {
      track('onboarding_provider_selected', { provider: selectedProvider })
      window.api.settings.set('default_terminal_mode', selectedProvider)
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
    <Dialog open={open || closing} onOpenChange={autoOpen ? () => {} : handleSkip}>
      <DialogContent
        className={cn('p-0 overflow-hidden border-none shadow-none bg-transparent transition-[max-width] duration-300', step === 4 ? 'max-w-xl' : 'max-w-[460px]')}
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
                <Button
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={handleSkip}
                >
                  Skip
                </Button>
              )}
            </div>
          )}

          <div className="px-8 pb-8">
            <AnimatePresence mode="wait" initial={false}>
            {step === 0 && (
              <motion.div
                key="welcome"
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
                  <Button onClick={handleNext} className="w-full">Continue</Button>
                </div>
              </motion.div>
            )}

            {step === 1 && (
              <motion.div
                key="disclaimer"
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
                  You decide when and how AI runs. We take no responsibility for anything it does or data it handles.
                </p>
                <Button onClick={handleNext} className="w-full">I understand</Button>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="provider"
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
                      onClick={() => setSelectedProvider(mode)}
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
                  <Button onClick={handleNext} className="w-full">Continue</Button>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="analytics"
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
                    We want to track as little as possible, but also get a feeling for what features are used.
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
                  Store a <strong className="text-foreground">random ID</strong> on your device so we can understand retention? No personal info leaves your machine.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => {
                      setTier('anonymous')
                      track('onboarding_completed', { provider: selectedProvider, tier: 'anonymous' })
                      window.api.settings.set('onboarding_completed', 'true')
                      setStep(4)
                    }}
                  >
                    No
                  </Button>
                  <Button
                    className="h-11"
                    onClick={() => {
                      setTier('opted_in')
                      track('onboarding_completed', { provider: selectedProvider, tier: 'opted_in' })
                      window.api.settings.set('onboarding_completed', 'true')
                      setStep(4)
                    }}
                  >
                    Yes
                  </Button>
                </div>
              </motion.div>
            )}

            {step === 4 && (
              <CliInstallStep onNext={handleNext} />
            )}

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
