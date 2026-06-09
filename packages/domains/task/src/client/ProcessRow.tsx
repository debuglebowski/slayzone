import type { ReactNode } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import {
  Play,
  Square,
  RotateCcw,
  Trash2,
  Pencil,
  FileText,
  MoreHorizontal,
  CornerDownLeft,
  Globe
} from 'lucide-react'
import {
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@slayzone/ui'
import type { ProcessEntry } from './ProcessesPanel.types'
import { StatusBadge } from './StatusBadge'

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ProcessRow({
  proc,
  expanded,
  stats,
  onToggleLog,
  onRestart,
  onStop,
  onKill,
  onEdit,
  onInject,
  onOpenUrl,
  logEndRef
}: {
  proc: ProcessEntry
  expanded: boolean
  stats?: { cpu: number; rss: number }
  onToggleLog: () => void
  onRestart: () => void
  onStop: () => void
  onKill: () => void
  onEdit: () => void
  onInject: () => void
  onOpenUrl?: (url: string) => void
  logEndRef: (el: HTMLDivElement | null) => void
}) {
  const trpcClient = useTRPCClient()
  const serverUrl = proc.status === 'running' ? (proc.serverUrl ?? null) : null
  return (
    <div className="rounded-lg border border-border bg-surface-3 overflow-hidden group/row">
      <div className="flex items-center gap-3 px-3.5 py-3">
        {/* Label + command */}
        <div className="flex flex-col min-w-0 flex-1 gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium leading-tight truncate">{proc.label}</span>
            {proc.autoRestart && (
              <span
                className="text-[10px] text-muted-foreground/40 shrink-0"
                title="Auto-restart enabled"
              >
                ↺
              </span>
            )}
          </div>
          <span className="text-[11px] font-mono text-muted-foreground/55 truncate">
            {proc.command}
          </span>
        </div>

        {/* Stop + Restart — visible when running */}
        {proc.status === 'running' && (
          <>
            <Tip label="Stop">
              <button
                onClick={onStop}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <Square className="size-3.5" />
              </button>
            </Tip>
            <Tip label="Restart">
              <button
                onClick={onRestart}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </Tip>
          </>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {proc.status !== 'running' && (
            <Tip label="Start">
              <button
                onClick={onRestart}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Play className="size-3.5" />
              </button>
            </Tip>
          )}
          <Tip label="Logs">
            <button
              onClick={onToggleLog}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                expanded
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <FileText className="size-3.5" />
            </button>
          </Tip>
          <Tip label="Send output to terminal">
            <button
              onClick={onInject}
              disabled={proc.logBuffer.length === 0}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <CornerDownLeft className="size-3.5" />
            </button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="More"
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-3.5 mr-2" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onKill} className="text-red-500 focus:text-red-500">
                <Trash2 className="size-3.5 mr-2 text-red-500" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Pills row */}
      <div className="flex items-center gap-1.5 flex-wrap px-3.5 pb-2.5 -mt-1">
        <StatusBadge status={proc.status} />
        {serverUrl && (
          <a
            href={serverUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault()
              if (onOpenUrl) onOpenUrl(serverUrl)
              else void trpcClient.app.shell.openExternal.mutate({ url: serverUrl })
            }}
            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 text-sky-400 bg-sky-400/10 border-sky-400/20 hover:bg-sky-400/20 transition-colors"
            title={`Open ${serverUrl}`}
          >
            <Globe className="size-2.5" />
            {serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </a>
        )}
        {proc.processTitle && (
          <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 text-muted-foreground bg-muted/60 border-border">
            {proc.processTitle}
          </span>
        )}
        {proc.status === 'error' && proc.exitCode !== null && (
          <span className="text-[10px] text-red-400/70 font-mono">exit {proc.exitCode}</span>
        )}
        {proc.status === 'running' && (stats || proc.restartCount > 0) && (
          <span className="text-[10px] text-muted-foreground/40 font-mono flex items-center gap-1.5 ml-auto">
            {stats && (
              <>
                <span>{stats.cpu.toFixed(1)}%</span>
                <span className="text-muted-foreground/15">·</span>
                <span>
                  {stats.rss >= 1024 ? `${(stats.rss / 1024).toFixed(0)} MB` : `${stats.rss} KB`}
                </span>
              </>
            )}
            {proc.restartCount > 0 && (
              <>
                <span className="text-muted-foreground/15">·</span>
                <span>↺{proc.restartCount}</span>
              </>
            )}
          </span>
        )}
      </div>

      {/* Log panel */}
      {expanded && (
        <div className="bg-surface-0 dark:bg-black border-t border-border">
          <div className="flex items-center px-4 py-1.5 border-b border-border">
            <span className="text-[10px] text-muted-foreground font-mono">
              {proc.logBuffer.length === 0 ? 'no output' : `${proc.logBuffer.length} lines`}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto">
            <pre className="text-[10px] font-mono text-foreground px-4 py-3 whitespace-pre-wrap break-all leading-relaxed">
              {proc.logBuffer.length === 0 ? (
                <span className="text-muted-foreground italic">Waiting for output…</span>
              ) : (
                proc.logBuffer.join('\n')
              )}
            </pre>
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
