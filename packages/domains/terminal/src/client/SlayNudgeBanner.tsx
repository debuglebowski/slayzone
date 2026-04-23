import { useState } from 'react'
import { Info, X, Check, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,

} from '@slayzone/ui'

interface SlayNudgeBannerProps {
  projectPath: string
  onDismiss: () => void
  onSetupComplete: () => void
}

type RunState = 'idle' | 'running' | 'done' | 'error'

export function SlayNudgeBanner({ projectPath, onDismiss, onSetupComplete }: SlayNudgeBannerProps) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [setupState, setSetupState] = useState<RunState>('idle')
  const [error, setError] = useState<string | null>(null)

  const runSetup = async () => {
    setSetupState('running')
    setError(null)
    const result = await window.api.aiConfig.setupSlay(projectPath)
    if (result.ok) {
      setSetupState('done')
    } else {
      setSetupState('error')
      setError(result.error ?? 'Unknown error')
    }
  }

  const handleDialogChange = (open: boolean) => {
    setInfoOpen(open)
    if (!open && setupState === 'done') onSetupComplete()
  }

  return (
    <>
      <div className="shrink-0 bg-amber-50 dark:bg-amber-500/5 border-b border-amber-200 dark:border-amber-500/10 px-4 py-2 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
        <span className="text-xs text-amber-700 dark:text-amber-500">
          Set up the <code className="px-1 rounded font-mono">slay</code> CLI so AI agents can interact with your tasks
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
          </DialogHeader>

          <div className="space-y-4 text-sm text-muted-foreground">
            <p>
              The <code className="text-foreground font-mono text-xs">slay</code> CLI lets AI agents
              running inside SlayZone interact with your tasks &mdash; reading descriptions, updating
              status, managing subtasks, controlling the browser panel, and coordinating with other agents.
            </p>
            <p>
              Running setup appends a SlayZone environment description to your agent instruction file
              (CLAUDE.md, AGENTS.md, etc. based on your configured providers) and installs the built-in
              slay skills so agents know every available command.
            </p>
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-1.5 rounded text-xs font-mono">
                slay init
              </code>
              <RunButton state={setupState} onClick={runSetup} />
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive pt-2">{error}</p>
          )}

          <div className="bg-muted/50 rounded-md px-3 py-2.5 mt-2">
            <p className="text-xs text-muted-foreground">
              This is fully reversible &mdash; just delete the appended lines from the instruction file
              and remove the generated skill directory to undo.
            </p>
          </div>
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
