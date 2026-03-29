import { IconButton, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { Pencil, Play, Pause, Square, RotateCcw } from 'lucide-react'
import type { LoopStatus } from './useLoopMode'
import { isLoopActive } from './useLoopMode'
import type { LoopConfig } from '@slayzone/terminal/shared'

interface LoopModeBannerProps {
  config: LoopConfig
  status: LoopStatus
  iteration: number
  onStart: (config: LoopConfig) => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onEditConfig: () => void
}

const STATUS_LABELS: Record<LoopStatus, string> = {
  idle: 'Ready',
  running: 'Running...',
  paused: 'Paused',
  passed: 'Passed',
  stopped: 'Stopped',
  error: 'Error',
  'max-reached': 'Max reached'
}

const STATUS_DOT_COLORS: Record<LoopStatus, string> = {
  idle: 'bg-neutral-400',
  running: 'bg-yellow-500',
  paused: 'bg-blue-500',
  passed: 'bg-green-500',
  stopped: 'bg-neutral-400',
  error: 'bg-red-500',
  'max-reached': 'bg-orange-500'
}

const CRITERIA_LABELS = {
  'contains': 'contains',
  'not-contains': 'not contains',
  'regex': 'regex'
} as const

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s
}

export function LoopModeBanner({ config, status, iteration, onStart, onPause, onResume, onStop, onEditConfig }: LoopModeBannerProps) {
  const active = isLoopActive(status)
  const showStatus = status !== 'idle'
  const progress = config.maxIterations > 0 ? (iteration / config.maxIterations) * 100 : 0

  return (
    <div
      className={`absolute top-6 right-6 z-10 w-72 rounded-xl border-2 ${active ? 'border-orange-500/60' : 'border-border'} bg-background backdrop-blur-md text-xs overflow-hidden transition-all duration-300`}
      style={{
        boxShadow: active
          ? '0 0 20px 0 rgba(249,115,22,0.4), 0 0 60px 0 rgba(249,115,22,0.15)'
          : '0 4px 20px 0 rgba(249,115,22,0.08), 0 0 15px 2px rgba(249,115,22,0.08)',
        animation: active ? 'loop-glow-active 2s ease-in-out infinite' : undefined
      }}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 border-b ${active ? 'border-orange-500/20 bg-orange-500/5' : 'border-border'}`}>
        <span className="font-bold text-foreground tracking-wide">LOOP COMMAND</span>
        <div className="flex items-center gap-0.5">
          {!active && status !== 'paused' && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton variant="ghost" className="size-7" aria-label="Edit config" onClick={onEditConfig}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Configure</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton variant="ghost" className="size-7" aria-label="Start loop" onClick={() => onStart(config)}>
                    <Play className="size-4" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Start</TooltipContent>
              </Tooltip>
            </>
          )}
          {active && (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton variant="ghost" className="size-7" aria-label="Pause loop" onClick={onPause}>
                  <Pause className="size-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">Pause</TooltipContent>
            </Tooltip>
          )}
          {status === 'paused' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton variant="ghost" className="size-7" aria-label="Resume loop" onClick={onResume}>
                  <RotateCcw className="size-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">Resume</TooltipContent>
            </Tooltip>
          )}
          {(active || status === 'paused') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton variant="ghost" className="size-7 text-destructive" aria-label="Stop loop" onClick={onStop}>
                  <Square className="size-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">Stop</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Prompt */}
      <div className={`px-3 py-2.5 border-b ${active ? 'border-orange-500/20' : 'border-border'}`}>
        <div className="text-muted-foreground mb-0.5">Prompt</div>
        <div className="text-foreground leading-snug">{truncate(config.prompt, 100)}</div>
      </div>

      {/* Criteria */}
      <div className={`px-3 py-2.5 border-b ${active ? 'border-orange-500/20' : 'border-border'}`}>
        <div className="text-muted-foreground mb-0.5">Criteria</div>
        <div className="text-foreground">{CRITERIA_LABELS[config.criteriaType]} &ldquo;{truncate(config.criteriaPattern, 40)}&rdquo;</div>
      </div>

      {/* Status + progress */}
      <div className={`px-3 py-2.5 space-y-2`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className={`size-2.5 rounded-full shrink-0 ${STATUS_DOT_COLORS[status]} ${active ? 'animate-pulse' : ''}`} />
            <span className={showStatus ? 'text-foreground font-medium' : 'text-muted-foreground'}>
              {STATUS_LABELS[status]}
            </span>
          </div>
          <span className="text-muted-foreground font-mono tabular-nums">{iteration}/{config.maxIterations}</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${active ? 'bg-orange-500' : 'bg-foreground/30'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  )
}
