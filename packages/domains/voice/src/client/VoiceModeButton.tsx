import { AudioLines, Mic, MicOff } from 'lucide-react'
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { VoiceSessionStatus } from './voice-session'

const ACTIVITY_LABEL = {
  listening: 'Listening',
  'user-turn': 'Hearing you',
  waiting: 'Waiting for reply',
  speaking: 'Speaking'
} as const

function describe(enabled: boolean, status: VoiceSessionStatus | null, endKeyword: string): string {
  if (!enabled) return `Conversation mode: talk hands-free, end each turn with "${endKeyword}"`
  if (!status || status.phase === 'starting') return 'Starting voice (loading models)…'
  if (status.phase === 'error') return `Voice off: ${status.error ?? 'failed'}`
  const loop = status.loop
  const activity = loop ? ACTIVITY_LABEL[loop.activity] : 'Listening'
  const heard = loop?.buffer ? ` — "${loop.buffer}"` : ''
  return `${activity}${heard}. Click to turn conversation mode off.`
}

/** The composer-footer toggle for conversation mode (the mic is open only while on). */
export function VoiceModeButton({
  enabled,
  status,
  onToggle,
  endKeyword = 'over'
}: {
  enabled: boolean
  status: VoiceSessionStatus | null
  onToggle: () => void
  endKeyword?: string
}): React.JSX.Element {
  const label = describe(enabled, status, endKeyword)
  const failed = enabled && status?.phase === 'error'
  const speaking = enabled && status?.loop?.activity === 'speaking'
  const hearing = enabled && status?.loop?.activity === 'user-turn'
  const Icon = failed ? MicOff : speaking ? AudioLines : Mic
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="voice-mode-toggle"
          data-voice-state={enabled ? (status?.phase ?? 'starting') : 'off'}
          data-voice-activity={status?.loop?.activity ?? ''}
          data-voice-error={failed ? (status?.error ?? '') : undefined}
          aria-pressed={enabled}
          aria-label={enabled ? 'Turn conversation mode off' : 'Turn conversation mode on'}
          onClick={onToggle}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors',
            enabled
              ? failed
                ? 'bg-destructive/15 text-destructive'
                : 'bg-primary/15 text-foreground'
              : 'hover:bg-muted/60 hover:text-foreground'
          )}
        >
          <Icon className={cn('size-3', hearing && 'animate-pulse')} />
          {enabled && status?.phase === 'starting' && <span>…</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
