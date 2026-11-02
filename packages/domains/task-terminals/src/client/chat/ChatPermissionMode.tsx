import { useRef, useState } from 'react'
import {
  AgentModePill,
  agentModeLabel,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  type AgentMode,
  type AutoModeCapability
} from '@slayzone/ui'
import { chatModesForMode } from '@slayzone/terminal-contracts'
import type { useChatMode } from './useChatMode'

export function ChatPermissionMode({
  mode,
  chatMode,
  inFlight,
  onChange,
  autoCapability,
  defaultMode,
  onSetDefault
}: {
  mode: string
  chatMode: AgentMode
  inFlight: boolean
  onChange: ReturnType<typeof useChatMode>['handleModeChange']
  autoCapability: AutoModeCapability
  /** The provider's default mode (`useChatDefaultMode`); undefined until loaded. */
  defaultMode?: AgentMode
  onSetDefault?: (mode: AgentMode) => void
}) {
  const [requested, setRequested] = useState<AgentMode | null>(null)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)
  const apply = (next: AgentMode, stopAndResume = false) => {
    if (applyingRef.current) return
    applyingRef.current = true
    setApplying(true)
    const change = stopAndResume ? onChange(next, { stopAndResume: true }) : onChange(next)
    void change
      .then(() => setRequested(null))
      .catch(() => {
        // useChatMode reports the failure; keep the choice available for retry.
      })
      .finally(() => {
        applyingRef.current = false
        setApplying(false)
      })
  }
  return (
    <>
      <AgentModePill
        mode={chatMode}
        modes={chatModesForMode(mode)}
        onChange={(next) => {
          if (next === chatMode) return
          if (mode === 'codex-chat' && inFlight) setRequested(next)
          else apply(next)
        }}
        disabled={applying || (inFlight && mode !== 'codex-chat')}
        compact
        variant="text"
        autoCapability={autoCapability}
        defaultMode={defaultMode}
        onSetDefault={onSetDefault}
      />
      <AlertDialog
        open={requested !== null}
        onOpenChange={(open) => {
          if (!open && !applying) setRequested(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change permissions to {requested && agentModeLabel(requested)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Apply on the next turn and let Codex finish its current work, or stop the current turn
              and continue the conversation with the new permissions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={applying}
              onClick={() => requested && apply(requested)}
            >
              Apply next turn
            </Button>
            <Button disabled={applying} onClick={() => requested && apply(requested, true)}>
              {applying ? 'Applying…' : 'Stop and resume'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
