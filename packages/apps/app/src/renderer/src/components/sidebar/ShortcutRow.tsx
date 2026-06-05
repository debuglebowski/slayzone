import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
  formatKeysForDisplay,
  type ShortcutDefinition
} from '@slayzone/ui'

export function ShortcutRow({
  def,
  effectiveKeys,
  isRecordingThis,
  onStartRecording,
  onCancelRecording,
  onClear,
  conflictAction,
  shadowAction,
  onConfirmReassign,
  onCancelConflict,
  onDismissShadow
}: {
  def: ShortcutDefinition
  effectiveKeys: string | null
  isRecordingThis: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onClear: () => void
  conflictAction: ShortcutDefinition | null
  shadowAction: ShortcutDefinition | null
  onConfirmReassign: () => void
  onCancelConflict: () => void
  onDismissShadow: () => void
}) {
  const customizable = def.customizable !== false
  const isBound = effectiveKeys !== null

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 gap-2">
        <span className="text-sm">{def.label}</span>
        {isRecordingThis ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground bg-primary/10 border border-primary/30 px-2.5 py-0.5 rounded-md font-[system-ui] animate-pulse">
              Press keys...
            </span>
            <button
              type="button"
              onClick={onCancelRecording}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {effectiveKeys !== null ? (
              <span
                className={cn(
                  'text-base text-muted-foreground bg-muted border px-2.5 py-0.5 rounded-md font-[system-ui] shadow-[0_1px_0_0_rgba(0,0,0,0.05)]',
                  customizable && 'cursor-pointer'
                )}
                onClick={customizable ? onStartRecording : undefined}
              >
                {formatKeysForDisplay(effectiveKeys)}
              </span>
            ) : (
              <span
                className={cn(
                  'text-xs italic text-muted-foreground/60 px-2.5 py-0.5 rounded-md border border-dashed',
                  customizable && 'cursor-pointer hover:text-muted-foreground'
                )}
                onClick={customizable ? onStartRecording : undefined}
              >
                Unbound
              </span>
            )}
            {isBound &&
              (customizable ? (
                <button
                  type="button"
                  onClick={onClear}
                  aria-label={`Clear shortcut for ${def.label}`}
                  title="Clear shortcut"
                  className="text-xs text-muted-foreground/60 hover:text-foreground px-1"
                >
                  ✕
                </button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      aria-disabled="true"
                      className="text-xs text-muted-foreground/30 px-1 cursor-not-allowed"
                    >
                      ✕
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left">This shortcut cannot be removed</TooltipContent>
                </Tooltip>
              ))}
          </div>
        )}
      </div>
      {conflictAction && (
        <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <span className="text-xs text-amber-400">
            Already bound to <strong>{conflictAction.label}</strong> — it will be swapped
          </span>
          <div className="flex gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onCancelConflict}
              className="text-xs px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmReassign}
              className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Reassign
            </button>
          </div>
        </div>
      )}
      {shadowAction && !conflictAction && (
        <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <span className="text-xs text-muted-foreground">
            Also used by <strong>{shadowAction.label}</strong> ({shadowAction.group})
          </span>
          <button
            type="button"
            onClick={onDismissShadow}
            className="text-xs px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground shrink-0"
          >
            OK
          </button>
        </div>
      )}
    </div>
  )
}
