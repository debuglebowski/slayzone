import { useState } from 'react'
import { Info, X, Check, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@slayzone/ui'

interface SlayNudgeBannerProps {
  projectPath: string
  onDismiss: () => void
  onSetupComplete: () => void
}

type RunState = 'idle' | 'running' | 'done' | 'error'

export function SlayNudgeBanner({ projectPath, onDismiss, onSetupComplete }: SlayNudgeBannerProps) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [instructionsState, setInstructionsState] = useState<RunState>('idle')
  const [skillsState, setSkillsState] = useState<RunState>('idle')
  const [error, setError] = useState<string | null>(null)

  const runCommand = async (command: 'instructions' | 'skills') => {
    const setState = command === 'instructions' ? setInstructionsState : setSkillsState
    setState('running')
    setError(null)
    const result = await window.api.aiConfig.setupSlay(projectPath, command)
    if (result.ok) {
      setState('done')
    } else {
      setState('error')
      setError(result.error ?? 'Unknown error')
    }
  }

  const anyRan = instructionsState === 'done' || skillsState === 'done'

  const handleDialogChange = (open: boolean) => {
    setInfoOpen(open)
    if (!open && anyRan) onSetupComplete()
  }

  return (
    <>
      <div className="shrink-0 bg-amber-50 dark:bg-amber-500/5 border-b border-amber-200 dark:border-amber-500/10 px-4 py-2 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
        <span className="text-xs text-amber-700 dark:text-amber-500">
          Add <code className="px-1 rounded font-mono">slay</code> to your CLAUDE.md so AI agents can interact with your tasks
        </span>
        <button
          className="text-xs text-amber-700 dark:text-amber-500 hover:text-amber-600 dark:hover:text-amber-400 underline shrink-0"
          onClick={() => setInfoOpen(true)}
        >
          More information
        </button>
        <button
          className="ml-auto text-amber-700 dark:text-amber-500 hover:text-amber-600 dark:hover:text-amber-400 shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={infoOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Set up slay CLI for AI agents</DialogTitle>
            <DialogDescription>
              The slay CLI lets AI agents interact with SlayZone — managing tasks, reading descriptions,
              updating status, controlling the browser panel, and more. Add it to your project so agents
              discover it automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-1.5 rounded text-xs font-mono">
                slay init instructions {'>'}{'>'}  CLAUDE.md
              </code>
              <RunButton state={instructionsState} onClick={() => runCommand('instructions')} />
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-1.5 rounded text-xs font-mono">
                slay init skills
              </code>
              <RunButton state={skillsState} onClick={() => runCommand('skills')} />
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <p className="text-xs text-muted-foreground">
            Or use Settings &rarr; Context Manager to set up visually.
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RunButton({ state, onClick }: { state: RunState; onClick: () => void }) {
  if (state === 'running') return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  if (state === 'done') return <Check className="h-4 w-4 text-green-500" />
  return (
    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onClick}>
      Run
    </Button>
  )
}
