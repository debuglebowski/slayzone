import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  cn
} from '@slayzone/ui'
import type {
  ConversationActionsDialog,
  FilesPreviewState,
  PendingConversationAction,
  RewindChoice
} from './useConversationActions'

const TITLE = { edit: 'Edit & resend', rewind: 'Rewind to here', fork: 'Fork from here' }
const ACTION = { edit: 'Edit', rewind: 'Rewind', fork: 'Fork' }
const BUSY = { edit: 'Rewinding…', rewind: 'Rewinding…', fork: 'Forking…' }
const WHAT = {
  edit: 'Claude forgets this message and everything after it. Its text goes back into the message box to edit and send again.',
  rewind: 'Claude keeps this message and its answer and forgets everything after it.',
  fork: 'Starts a new conversation with everything up to this answer. The current conversation stays as it is, in Sessions.'
}

/**
 * Confirms edit & resend, rewind to here and fork from here — the TUI's
 * double-Esc choices: conversation and code, conversation only, code only.
 * The code part comes from a dry run of the CLI's file checkpoints.
 */
export function RewindDialog({ dialog }: { dialog: ConversationActionsDialog }): React.JSX.Element {
  const { pending, preview, busy } = dialog
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) dialog.cancel()
      }}
    >
      {pending && (
        // Keyed: each action starts from its own default choice.
        <RewindDialogBody
          key={`${pending.kind}:${pending.messageId}`}
          pending={pending}
          preview={preview}
          busy={busy}
          onConfirm={dialog.confirm}
        />
      )}
    </AlertDialog>
  )
}

function RewindDialogBody({
  pending,
  preview,
  busy,
  onConfirm
}: {
  pending: PendingConversationAction
  preview: FilesPreviewState
  busy: boolean
  onConfirm: (choice: RewindChoice) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<RewindChoice | null>(null)
  const codeReady = preview.status === 'ready' && preview.value.canRewind
  const choices: RewindChoice[] =
    pending.kind === 'fork'
      ? []
      : pending.kind === 'edit'
        ? ['both', 'conversation']
        : ['both', 'conversation', 'code']
  // Until the user picks, code is included when it can be restored.
  const choice: RewindChoice = picked ?? (codeReady ? 'both' : 'conversation')
  const needsCode = choice !== 'conversation'
  const blocked = busy || preview.status === 'loading' || (needsCode && !codeReady)
  return (
    <AlertDialogContent data-testid="rewind-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{TITLE[pending.kind]}</AlertDialogTitle>
        <AlertDialogDescription>{WHAT[pending.kind]}</AlertDialogDescription>
      </AlertDialogHeader>
      {choices.length > 0 && (
        <div className="space-y-3 text-sm">
          <div role="radiogroup" aria-label="What to restore" className="space-y-1.5">
            {choices.map((c) => {
              const disabled = c !== 'conversation' && !codeReady
              return (
                <label
                  key={c}
                  className={cn(
                    'flex items-center gap-2',
                    disabled ? 'text-muted-foreground' : 'text-foreground'
                  )}
                >
                  <input
                    type="radio"
                    name="rewind-choice"
                    value={c}
                    checked={choice === c}
                    disabled={disabled || busy}
                    onChange={() => setPicked(c)}
                    className="accent-primary"
                  />
                  {c === 'both'
                    ? 'Conversation and code'
                    : c === 'conversation'
                      ? 'Conversation only'
                      : 'Code only'}
                </label>
              )
            })}
          </div>
          <FilesSummary preview={preview} />
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          data-testid="rewind-confirm"
          disabled={blocked}
          onClick={(e) => {
            // Stay open through the request: the busy label shows, a second
            // click can't fire it twice.
            e.preventDefault()
            onConfirm(choice)
          }}
        >
          {busy ? BUSY[pending.kind] : ACTION[pending.kind]}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

function FilesSummary({ preview }: { preview: FilesPreviewState }): React.JSX.Element {
  if (preview.status === 'loading' || preview.status === 'idle') {
    return <p className="text-xs text-muted-foreground">Checking which files would change…</p>
  }
  if (preview.status === 'error') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="rewind-files">
        Code can&apos;t be restored: {preview.error}
      </p>
    )
  }
  const { value } = preview
  if (!value.canRewind) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="rewind-files">
        Code can&apos;t be restored: {value.error ?? 'no checkpoint for this message.'}
      </p>
    )
  }
  return (
    <div className="space-y-1 text-xs" data-testid="rewind-files">
      <p className="text-foreground">
        {value.filesChanged.length === 0
          ? 'No files changed since then.'
          : `${value.filesChanged.length} ${value.filesChanged.length === 1 ? 'file' : 'files'} would change`}{' '}
        {value.filesChanged.length > 0 && (
          <span className="tabular-nums text-muted-foreground">
            (+{value.insertions} −{value.deletions})
          </span>
        )}
      </p>
      {value.filesChanged.length > 0 && (
        <ul className="max-h-28 overflow-y-auto font-mono text-[11px] text-muted-foreground">
          {value.filesChanged.map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">Changes made by shell commands are not restored.</p>
    </div>
  )
}
