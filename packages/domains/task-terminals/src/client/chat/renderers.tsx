import { useEffect, useRef, useState, useMemo } from 'react'
import { useChatView } from './ChatViewContext'
import {
  ChevronDown,
  ChevronRight,
  Brain,
  CircleCheck,
  CircleX,
  Loader2,
  FileText,
  Terminal as TerminalIcon,
  Pencil,
  Search,
  CheckSquare,
  ListChecks,
  ClipboardList,
  FilePlus,
  HelpCircle,
  Sparkles,
  Copy,
  Check as CheckIcon,
  User,
  Bot
} from 'lucide-react'
import { cn } from '@slayzone/ui'
import { DiffView, GhMarkdown } from '@slayzone/worktrees/client'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'
import { claudeEditResultToFileDiff } from './claude-patch-to-filediff'
import { LinkifiedText } from './LinkifiedText'

/**
 * Context-bound LinkifiedText. Pulls `onOpenUrl`/`onOpenFile` from ChatViewContext
 * so renderers don't have to thread them per call site. When unset, falls back to
 * shell.openExternal / shell.openPath.
 */
function LinkText({ text }: { text: string }) {
  const { onOpenUrl, onOpenFile } = useChatView()
  return <LinkifiedText text={text} onOpenUrl={onOpenUrl} onOpenFile={onOpenFile} />
}
import { HighlightedText } from './HighlightedText'

// Card indent for tool/sub-agent rows: aligns with assistant card position
// (assistant uses pl-4 + size-7 avatar + gap-3 = 56px = pl-14).
const CHAT_CARD_INDENT = 'pl-14'

// --- Helpers ---

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return ''
  }
}

function useCopy(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return { copied, copy }
}

// --- Turn-scoped wrappers ---

/** User prompt — right-aligned card. */
export function UserMessage({ item }: { item: Extract<TimelineItem, { kind: 'user-text' }> }) {
  return (
    <div className="group px-4 py-2 flex justify-end items-center gap-2">
      <span className="shrink-0 text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
        {formatTime(item.timestamp)}
      </span>
      <div className="max-w-[85%] min-w-0 rounded-lg border border-primary/25 bg-primary/5 shadow-sm px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words">
        <HighlightedText text={item.text} />
      </div>
    </div>
  )
}

/** Assistant message — left-aligned avatar + card. Right edge bounded by outer pr. */
export function AssistantText({ item }: { item: Extract<TimelineItem, { kind: 'text' }> }) {
  return (
    <div className="pl-4 pr-[10%] py-2">
      <div className="group flex gap-3 items-start">
        <AssistantAvatar />
        <div className="min-w-0 rounded-lg border border-border/50 bg-card/40 shadow-sm px-3 py-2">
          <div className="text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_ul]:my-2 [&_ol]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_code]:font-mono [&_code]:text-[0.85em]">
            <GhMarkdown>{item.text}</GhMarkdown>
          </div>
        </div>
        <span className="shrink-0 self-center text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
          {formatTime(item.timestamp)}
        </span>
      </div>
    </div>
  )
}

function AssistantAvatar() {
  return (
    <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white shadow-sm">
      <Sparkles className="size-3.5" />
    </div>
  )
}

// Unused but kept for reference if we later show user avatars.
export function _UserAvatar() {
  return (
    <div className="shrink-0 size-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
      <User className="size-3.5" />
    </div>
  )
}

// --- Ancillary blocks ---

export function ThinkingBlock({ item }: { item: Extract<TimelineItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false)
  const { collapseSignal } = useChatView()
  useEffect(() => {
    setOpen(false)
  }, [collapseSignal])
  if (!item.text) return null
  return (
    <div className="px-4 pl-[4.25rem] py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted/60"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />
        <span className="italic">Thinking</span>
      </button>
      {open && (
        <pre className="mt-1 text-xs text-muted-foreground/80 whitespace-pre-wrap italic pl-5 border-l border-border/40 ml-1">
          <HighlightedText text={item.text} />
        </pre>
      )}
    </div>
  )
}

export function SystemInit({ item }: { item: Extract<TimelineItem, { kind: 'session-start' }> }) {
  return (
    <div className="px-4 py-3 flex items-center justify-center gap-2 text-[11px] text-muted-foreground/60">
      <span className="font-mono">{item.model}</span>
      <span>·</span>
      <span>{item.tools.length} tools</span>
    </div>
  )
}

export function ResultFooter({ item }: { item: Extract<TimelineItem, { kind: 'result' }> }) {
  const [expanded, setExpanded] = useState(false)
  const { collapseSignal, showMessageMeta } = useChatView()
  useEffect(() => {
    setExpanded(false)
  }, [collapseSignal])
  const { copied, copy } = useCopy(item.copyText ?? '')
  if (!showMessageMeta) return null
  return (
    <div className="group px-4 pl-[4.25rem] pb-2 flex items-center gap-2 flex-wrap">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex items-center gap-2 text-[11px] rounded-md px-2 py-1 text-muted-foreground/80 hover:text-foreground hover:bg-muted/60 transition-colors',
          item.isError && 'text-destructive'
        )}
      >
        {item.isError ? (
          <CircleX className="size-3" />
        ) : (
          <CircleCheck className="size-3 text-emerald-500" />
        )}
        <span>{(item.durationMs / 1000).toFixed(1)}s</span>
        <span>·</span>
        <span>${item.totalCostUsd.toFixed(4)}</span>
        <span>·</span>
        <span>
          {item.numTurns} turn{item.numTurns === 1 ? '' : 's'}
        </span>
        {item.isError && (
          <>
            <span>·</span>
            <span>{item.subtype}</span>
          </>
        )}
      </button>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
        <span>{formatTime(item.timestamp)}</span>
        {item.copyText && (
          <button
            onClick={copy}
            className="inline-flex items-center gap-1 hover:text-foreground"
            aria-label="Copy assistant reply"
          >
            {copied ? <CheckIcon className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {expanded && item.text && (
        <div className="basis-full mt-1.5 text-xs text-foreground/80 whitespace-pre-wrap pl-2 border-l border-border/40">
          {item.text}
        </div>
      )}
    </div>
  )
}

export function ApiRetryBanner({ item }: { item: Extract<TimelineItem, { kind: 'api-retry' }> }) {
  return (
    <div className="mx-4 my-1 px-3 py-1.5 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-center gap-2">
      <Loader2 className="size-3 animate-spin shrink-0" />
      API retry {item.attempt}/{item.maxRetries} in {item.delayMs}ms: {item.error}
    </div>
  )
}

export function StderrBlock({ item }: { item: Extract<TimelineItem, { kind: 'stderr' }> }) {
  return (
    <pre className="mx-4 my-1 px-3 py-1.5 text-xs rounded-md border border-destructive/40 bg-destructive/5 text-destructive whitespace-pre-wrap font-mono">
      <HighlightedText text={item.text} />
    </pre>
  )
}

export function InterruptedBlock(_props: { item: Extract<TimelineItem, { kind: 'interrupted' }> }) {
  return (
    <div className="px-4 pl-[4.25rem] py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
      Turn interrupted
    </div>
  )
}

export function PlanBlock({ item }: { item: Extract<TimelineItem, { kind: 'plan' }> }) {
  const done = item.steps.filter((s) => s.status === 'completed').length
  return (
    <div className="mx-4 my-1 rounded-md border border-border/60 bg-muted/20">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-muted-foreground border-b border-border/40">
        <ListChecks className="size-3" />
        <span>Plan</span>
        <span className="ml-auto tabular-nums">
          {done}/{item.steps.length}
        </span>
      </div>
      {item.explanation ? (
        <div className="px-3 pt-2 text-[11px] text-muted-foreground">{item.explanation}</div>
      ) : null}
      <ul className="p-3 text-xs grid gap-1.5">
        {item.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block size-2 rounded-full shrink-0',
                s.status === 'completed' && 'bg-emerald-500',
                s.status === 'inProgress' && 'bg-amber-500',
                s.status === 'pending' && 'bg-muted-foreground/30'
              )}
            />
            <span
              className={cn(
                s.status === 'completed' && 'line-through text-muted-foreground',
                s.status === 'inProgress' && 'font-medium'
              )}
            >
              {s.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function UnknownBlock({ item }: { item: Extract<TimelineItem, { kind: 'unknown' }> }) {
  return (
    <div className="mx-4 my-1 px-3 py-1.5 text-[11px] rounded-md border border-border/50 bg-muted/30 text-muted-foreground">
      <HelpCircle className="inline size-3 mr-1" />
      unsupported event ({item.reason})
    </div>
  )
}

export function SubAgentRow({ item }: { item: Extract<TimelineItem, { kind: 'sub-agent' }> }) {
  const { collapseSignal, timeline, childIndex } = useChatView()
  const inFlight = item.phase === 'in-flight'
  const errored = item.phase === 'failed' || item.status === 'failed' || item.status === 'error'
  const seconds = item.durationMs != null ? (item.durationMs / 1000).toFixed(1) : null
  const tokens = item.totalTokens != null ? formatTokens(item.totalTokens) : null

  const childIndices = childIndex.get(item.toolUseId) ?? []
  // The Agent/Task launcher tool that spawned this sub-agent — rendered inside
  // the accordion so users can see the prompt + subagent_type after expanding.
  const launcherTool = useMemo(
    () =>
      timeline.find(
        (t) =>
          t.kind === 'tool' &&
          isAgentLauncherToolName(t.invocation.name) &&
          t.invocation.id === item.toolUseId
      ),
    [timeline, item.toolUseId]
  )
  const hasChildren = childIndices.length > 0 || launcherTool != null
  // Mirror ToolShell convention: errored items default open so the user sees what failed;
  // everything else stays collapsed. collapseSignal forces all back to closed.
  const [open, setOpen] = useState(errored)
  useEffect(() => {
    setOpen(false)
  }, [collapseSignal])

  return (
    <>
      <div
        className={cn(CHAT_CARD_INDENT, 'pr-4 py-1 group flex items-start gap-2')}
        data-testid="sub-agent-row"
      >
        <div className="w-fit max-w-full rounded-md border border-border/50 bg-muted/20 overflow-hidden">
          <button
            type="button"
            onClick={() => hasChildren && setOpen((v) => !v)}
            disabled={!hasChildren}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-xs text-left max-w-full',
              hasChildren && 'hover:bg-muted/40 cursor-pointer',
              !hasChildren && 'cursor-default'
            )}
          >
            {inFlight ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-violet-500" />
            ) : errored ? (
              <CircleX className="size-3 shrink-0 text-destructive" />
            ) : (
              <CircleCheck className="size-3 shrink-0 text-emerald-500" />
            )}
            <Bot className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-medium shrink-0">Sub-agent</span>
            <span className="text-muted-foreground truncate min-w-0 font-mono text-[11px] flex items-center gap-2">
              {item.description && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="truncate">{item.description}</span>
                </>
              )}
              {item.status && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className={cn('shrink-0', errored && 'text-destructive')}>
                    {item.status}
                  </span>
                </>
              )}
              {seconds && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="shrink-0">{seconds}s</span>
                </>
              )}
              {item.toolUses != null && item.toolUses > 0 && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="shrink-0">
                    {item.toolUses} tool{item.toolUses === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {tokens && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="shrink-0">{tokens} tok</span>
                </>
              )}
            </span>
            {hasChildren && (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </span>
            )}
          </button>
        </div>
        <HoverTimestamp timestamp={item.timestamp} />
      </div>
      {open && hasChildren && (
        <div className="pl-4" data-testid="sub-agent-children">
          {launcherTool && launcherTool.kind === 'tool' && (
            <div key={`${item.toolUseId}:launcher`}>
              {renderTool(launcherTool.invocation, launcherTool.timestamp)}
            </div>
          )}
          {childIndices.map((idx) => {
            const child = timeline[idx]
            if (!child) return null
            return renderTimelineItem(child, `${item.toolUseId}:${idx}`)
          })}
        </div>
      )}
    </>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// --- Tool renderers ---

/**
 * Sub-agent launcher tool — `Agent` in current Claude Code SDK, `Task` in older
 * versions. Paired with a `kind:'sub-agent'` timeline row that already shows
 * status/usage; we render this card inside the SubAgentRow accordion instead of
 * at root.
 */
function isAgentLauncherToolName(name: string | undefined): boolean {
  return name === 'Agent' || name === 'Task'
}

interface ToolProps {
  invocation: ToolInvocation
  /** Wall-clock ts of the tool-call timeline item — surfaced on card hover. */
  timestamp?: number
}

/** Hover-revealed timestamp, sits beside left-aligned cards (tool, sub-agent, etc.). */
function HoverTimestamp({ timestamp }: { timestamp?: number }) {
  if (timestamp == null) return null
  return (
    <span className="shrink-0 self-center text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
      {formatTime(timestamp)}
    </span>
  )
}

function extractRawText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return (raw as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n')
  }
  return ''
}

function ToolShell({
  invocation,
  icon,
  title,
  summary,
  children,
  defaultOpen,
  timestamp
}: {
  invocation: ToolInvocation
  icon: React.ReactNode
  title: React.ReactNode
  summary?: React.ReactNode
  children?: React.ReactNode
  defaultOpen?: boolean
  timestamp?: number
}) {
  const status = invocation.status
  const [open, setOpen] = useState(defaultOpen ?? status === 'error')
  const { collapseSignal } = useChatView()
  useEffect(() => {
    setOpen(false)
  }, [collapseSignal])
  // Body fallback chain: per-tool rich children > rawContent text > pending placeholder.
  // Keeps any tool card non-blank when structured data is missing or absent.
  const rawText = useMemo(() => extractRawText(invocation.result?.rawContent), [invocation.result])
  let body: React.ReactNode = children
  if (!body && rawText) {
    body = (
      <pre className="p-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto bg-muted/30 text-muted-foreground">
        <LinkText text={rawText} />
      </pre>
    )
  }
  if (!body && status === 'pending') {
    body = <div className="px-3 py-2 text-xs text-muted-foreground italic">Waiting for result…</div>
  }
  const canOpen = Boolean(body)
  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1 group flex items-start gap-2')}>
      <div className="w-fit max-w-full rounded-lg border border-border/50 bg-card/40 overflow-hidden shadow-sm">
        <button
          onClick={() => canOpen && setOpen(!open)}
          disabled={!canOpen}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-xs text-left max-w-full',
            canOpen && 'hover:bg-muted/40 cursor-pointer',
            !canOpen && 'cursor-default'
          )}
        >
          <StatusIcon status={status} />
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span className="font-medium shrink-0">{title}</span>
          {summary !== undefined && summary !== '' && (
            <span className="text-muted-foreground truncate min-w-0 font-mono text-[11px]">
              {summary}
            </span>
          )}
          {canOpen && (
            <span className="shrink-0 text-muted-foreground">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
          )}
        </button>
        {open && canOpen && (
          <div className="border-t border-border/40 bg-background/40">{body}</div>
        )}
      </div>
      <HoverTimestamp timestamp={timestamp} />
    </div>
  )
}

function StatusIcon({ status }: { status: ToolInvocation['status'] }) {
  if (status === 'pending')
    return <Loader2 className="size-3 animate-spin text-muted-foreground shrink-0" />
  if (status === 'error') return <CircleX className="size-3 text-destructive shrink-0" />
  if (status === 'denied') return <CircleX className="size-3 text-amber-500 shrink-0" />
  return <CircleCheck className="size-3 text-emerald-500 shrink-0" />
}

function shortenPath(p?: string): string {
  if (!p) return ''
  const parts = p.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

export function ToolCallEdit({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as {
    file_path?: string
    old_string?: string
    new_string?: string
  } | null
  const { fileEditsOpenByDefault } = useChatView()
  const fileDiff = useMemo(() => {
    return invocation.result ? claudeEditResultToFileDiff(invocation.result.structured) : null
  }, [invocation.result])
  return (
    <ToolShell
      icon={<Pencil className="size-3" />}
      title="Edit"
      invocation={invocation}
      timestamp={timestamp}
      summary={shortenPath(input?.file_path)}
      defaultOpen={fileEditsOpenByDefault}
    >
      {fileDiff ? (
        <div className="p-1">
          <DiffView diff={fileDiff} />
        </div>
      ) : input ? (
        <div className="p-3 text-xs font-mono grid gap-1">
          <div className="text-red-600 dark:text-red-400">- {input.old_string}</div>
          <div className="text-green-700 dark:text-green-400">+ {input.new_string}</div>
        </div>
      ) : null}
    </ToolShell>
  )
}

export function ToolCallRead({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { file_path?: string; offset?: number; limit?: number } | null
  const structured = invocation.result?.structured as {
    file?: { content?: string; numLines?: number }
  } | null
  const summary = input?.file_path
    ? `${shortenPath(input.file_path)}${input.limit ? ` · L${input.offset ?? 1}–${(input.offset ?? 1) + input.limit - 1}` : ''}`
    : ''
  return (
    <ToolShell
      icon={<FileText className="size-3" />}
      title="Read"
      invocation={invocation}
      timestamp={timestamp}
      summary={summary}
    >
      {structured?.file?.content && (
        <pre className="p-3 text-xs font-mono whitespace-pre overflow-x-auto max-h-64 bg-muted/30">
          <LinkText text={structured.file.content} />
        </pre>
      )}
    </ToolShell>
  )
}

export function ToolCallWrite({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { file_path?: string; content?: string } | null
  const { fileEditsOpenByDefault } = useChatView()
  return (
    <ToolShell
      icon={<FilePlus className="size-3" />}
      title="Write"
      invocation={invocation}
      timestamp={timestamp}
      summary={shortenPath(input?.file_path)}
      defaultOpen={fileEditsOpenByDefault}
    >
      {input?.content && (
        <pre className="p-3 text-xs font-mono whitespace-pre overflow-x-auto max-h-64 bg-muted/30">
          {input.content}
        </pre>
      )}
    </ToolShell>
  )
}

export function ToolCallBash({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { command?: string; description?: string } | null
  const resultText = extractRawText(invocation.result?.rawContent)
  return (
    <ToolShell
      icon={<TerminalIcon className="size-3" />}
      title="Bash"
      invocation={invocation}
      timestamp={timestamp}
      summary={input?.description ?? input?.command}
      defaultOpen
    >
      {input?.command && (
        <div className="px-3 pt-2 text-xs font-mono flex items-start gap-2">
          <span className="text-primary shrink-0">$</span>
          <span className="whitespace-pre-wrap break-all">{input.command}</span>
        </div>
      )}
      {resultText && (
        <pre className="px-3 pb-2 pt-1 text-xs font-mono whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">
          <LinkText text={resultText} />
        </pre>
      )}
    </ToolShell>
  )
}

export function ToolCallGlob({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { pattern?: string; path?: string } | null
  const structured = invocation.result?.structured as {
    filenames?: string[]
    numFiles?: number
  } | null
  return (
    <ToolShell
      icon={<Search className="size-3" />}
      title="Glob"
      invocation={invocation}
      timestamp={timestamp}
      summary={`${input?.pattern ?? ''}${structured ? ` → ${structured.numFiles ?? 0} files` : ''}`}
    >
      {structured?.filenames && (
        <ul className="p-3 text-xs font-mono grid gap-0.5 max-h-48 overflow-y-auto">
          {structured.filenames.map((f) => (
            <li key={f}>
              <LinkText text={f} />
            </li>
          ))}
        </ul>
      )}
    </ToolShell>
  )
}

export function ToolCallGrep({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { pattern?: string; path?: string } | null
  const structured = invocation.result?.structured as {
    mode?: string
    filenames?: string[]
    numFiles?: number
    numLines?: number
    content?: string
  } | null
  const summary = `${input?.pattern ?? ''}${
    structured?.mode === 'content'
      ? ` → ${structured.numLines ?? 0} lines`
      : structured?.numFiles !== undefined
        ? ` → ${structured.numFiles} files`
        : ''
  }`
  return (
    <ToolShell
      icon={<Search className="size-3" />}
      title="Grep"
      invocation={invocation}
      timestamp={timestamp}
      summary={summary}
    >
      {structured?.content && (
        <pre className="p-3 text-xs font-mono whitespace-pre overflow-x-auto max-h-48 bg-muted/30">
          <LinkText text={structured.content} />
        </pre>
      )}
      {!structured?.content && structured?.filenames && (
        <ul className="p-3 text-xs font-mono grid gap-0.5 max-h-48 overflow-y-auto">
          {structured.filenames.map((f) => (
            <li key={f}>
              <LinkText text={f} />
            </li>
          ))}
        </ul>
      )}
    </ToolShell>
  )
}

export function ToolCallTodoWrite({ invocation, timestamp }: ToolProps) {
  const structured = invocation.result?.structured as {
    newTodos?: Array<{ content: string; status: string; activeForm?: string }>
  } | null
  const input = invocation.input as { todos?: Array<{ content: string; status: string }> } | null
  const todos = structured?.newTodos ?? input?.todos ?? []
  const inProgress = todos.find((t) => t.status === 'in_progress')
  return (
    <ToolShell
      icon={<CheckSquare className="size-3" />}
      title="TodoWrite"
      invocation={invocation}
      timestamp={timestamp}
      summary={`${todos.length} todos${inProgress ? ` · ${inProgress.content}` : ''}`}
      defaultOpen
    >
      <ul className="p-3 text-xs grid gap-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block size-2 rounded-full shrink-0',
                t.status === 'completed' && 'bg-emerald-500',
                t.status === 'in_progress' && 'bg-amber-500',
                t.status === 'pending' && 'bg-muted-foreground/30'
              )}
            />
            <span
              className={cn(
                t.status === 'completed' && 'line-through text-muted-foreground',
                t.status === 'in_progress' && 'font-medium'
              )}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </ToolShell>
  )
}

type AskQuestion = {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string; preview?: string }>
}

export function ToolCallAskUserQuestion({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { questions?: AskQuestion[] } | null
  const questions = input?.questions ?? []
  const {
    sendMessage,
    permissionRequests,
    respondPermission,
    abortAgent,
    timeline,
    collapseSignal
  } = useChatView()
  // Latest AskUserQuestion in the timeline stays expanded; older ones auto-collapse
  // when a newer ask appears. User can still toggle manually.
  const isLatestAsk = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const it = timeline[i]
      if (it.kind === 'tool' && it.invocation.name === 'AskUserQuestion') {
        return it.invocation.id === invocation.id
      }
    }
    return false
  }, [timeline, invocation.id])
  const [collapsed, setCollapsed] = useState(!isLatestAsk)
  useEffect(() => {
    setCollapsed(!isLatestAsk)
  }, [isLatestAsk])
  // Skip mount: initial state already honors latest-ask. Only react to
  // user-triggered "Collapse all" bumps after mount.
  const initialSignalRef = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal !== initialSignalRef.current) {
      setCollapsed(true)
    }
  }, [collapseSignal])
  // Permission-prompt path: when the CLI was spawned with
  // `--permission-prompt-tool stdio`, the SDK emits a control_request that
  // we surface here. Resolving it with `behavior:'allow' + updatedInput.answers`
  // lets the tool run and Claude continue from a real tool_result.
  // Fallback: plain user-message (legacy path; loses tool_use linkage but
  // still conveys the answer).
  const pendingPrompt = permissionRequests?.get(invocation.id) ?? null
  const canRespond = Boolean((pendingPrompt && respondPermission) || sendMessage)
  const [answered, setAnswered] = useState(false)
  const [submittedText, setSubmittedText] = useState<string | null>(null)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map())
  const [otherActive, setOtherActive] = useState<Set<number>>(() => new Set())
  const [otherText, setOtherText] = useState<Map<number, string>>(() => new Map())

  // SDK closes AskUserQuestion automatically in non-interactive print mode
  // (synthetic tool_result + entry in `result.permissionDenials` because no
  // `--permission-prompt-tool` is wired) — so by the time renderer mounts,
  // both `invocation.status === 'done'` and `invocation.denied === true`
  // are already set. Treating either as "locked" hides the buttons before
  // the user can answer. Lock ONLY on explicit user submit; the user-msg
  // path (handleSubmit) is what actually carries the answer to Claude.
  const locked = answered

  const pickOption = (qi: number, label: string, multi: boolean): void => {
    if (locked) return
    setOtherActive((prev) => {
      if (!prev.has(qi)) return prev
      const next = new Set(prev)
      next.delete(qi)
      return next
    })
    setSelections((prev) => {
      const next = new Map(prev)
      const cur = new Set(next.get(qi) ?? [])
      if (multi) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        cur.clear()
        cur.add(label)
      }
      next.set(qi, cur)
      return next
    })
  }

  const pickOther = (qi: number): void => {
    if (locked) return
    setOtherActive((prev) => new Set(prev).add(qi))
    setSelections((prev) => {
      const next = new Map(prev)
      next.set(qi, new Set())
      return next
    })
  }

  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = new Map(prev)
      next.set(qi, value)
      return next
    })
  }

  const canSubmit =
    questions.length > 0 &&
    questions.every((_q, qi) => {
      if (otherActive.has(qi)) return (otherText.get(qi) ?? '').trim().length > 0
      return (selections.get(qi)?.size ?? 0) > 0
    })

  const handleSubmit = (): void => {
    if (!canSubmit || !canRespond || locked) return
    const answersByQuestion: Record<string, string> = {}
    const lines: string[] = []
    questions.forEach((q, qi) => {
      const ans = otherActive.has(qi)
        ? (otherText.get(qi) ?? '').trim()
        : Array.from(selections.get(qi) ?? []).join(', ')
      answersByQuestion[q.question] = ans
      const prefix = q.header || q.question || `Q${qi + 1}`
      lines.push(`${prefix}: ${ans}`)
    })
    const text = lines.join('\n')
    setSubmittedText(text)
    setAnswered(true)

    // Primary: resolve the inbound `can_use_tool` permission request with
    // `behavior:'allow'` + answers in `updatedInput`. The CLI then runs the
    // tool with the merged input → emits a real tool_result → Claude reads
    // the answers and continues. Single turn, no orphan tool_use, no
    // synthetic "user declined" text.
    // Fallback: when no pending prompt is wired (adapter without stdio
    // permission routing or sub-agent context), send the answer as a plain
    // user message so Claude can still read it from the next turn.
    if (pendingPrompt && respondPermission) {
      void respondPermission({
        requestId: pendingPrompt.requestId,
        decision: {
          behavior: 'allow',
          // Merge into the tool's original input so the CLI runs it with the
          // populated `answers`. Spread original input first; our `answers`
          // overrides any stale field of the same name.
          updatedInput: {
            ...((pendingPrompt.input as Record<string, unknown>) ?? {}),
            answers: answersByQuestion
          }
        }
      })
      return
    }
    if (sendMessage) sendMessage(text)
  }

  // Cancel = interrupt the agent. Same path as the Stop button: clear
  // queued messages, abort the in-flight turn (kill+respawn). Skip the
  // permission-deny/sendMessage paths when abortAgent is wired since the
  // session dies anyway. Fallback (harness, no abortAgent): preserve old
  // behavior so the question still resolves cleanly.
  const canCancel = Boolean(abortAgent) || canRespond
  const handleCancel = (): void => {
    if (!canCancel || locked) return
    setSubmittedText('Cancelled')
    setAnswered(true)
    if (abortAgent) {
      void abortAgent()
      return
    }
    if (pendingPrompt && respondPermission) {
      void respondPermission({
        requestId: pendingPrompt.requestId,
        decision: { behavior: 'deny', message: 'User cancelled the question.' }
      })
      return
    }
    if (sendMessage) sendMessage('Cancelled')
  }

  return (
    <div className="pl-4 pr-4 py-3">
      <div className="group flex gap-3 items-start">
        <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-sm">
          <HelpCircle className="size-3.5" />
        </div>
        <div
          className={cn(
            'min-w-0 flex-1 rounded-lg border border-indigo-500/40 bg-indigo-500/5 shadow-sm overflow-hidden transition-opacity',
            locked && 'opacity-60'
          )}
        >
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              'w-full flex items-center gap-2 bg-indigo-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/15 transition-colors',
              !collapsed && 'border-b border-indigo-500/20'
            )}
          >
            <HelpCircle className="size-3 shrink-0" />
            <span className="shrink-0">Question</span>
            {/* StatusIcon intentionally omitted — SDK auto-marks AskUserQuestion
                done/denied in non-interactive print mode, which would render a
                red X next to "Question" while the user is still picking. */}
            {collapsed && (
              <span className="flex-1 min-w-0 truncate normal-case font-normal text-indigo-700/80 dark:text-indigo-300/80">
                {locked && submittedText
                  ? submittedText.split('\n')[0]
                  : questions[0]?.question || ''}
              </span>
            )}
            <span className="ml-auto shrink-0">
              {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            </span>
          </button>
          {!collapsed && questions.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">No questions provided.</div>
          )}
          {!collapsed &&
            questions.map((q, qi) => {
              const sel = selections.get(qi) ?? new Set<string>()
              const isOther = otherActive.has(qi)
              return (
                <div
                  key={qi}
                  className={cn('px-3 py-2', qi > 0 && 'border-t border-indigo-500/10')}
                >
                  <div className="text-sm font-medium text-foreground mb-2">{q.question}</div>
                  <div className="grid gap-1.5">
                    {q.options.map((opt) => {
                      const active = sel.has(opt.label)
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          disabled={locked}
                          onClick={() => pickOption(qi, opt.label, q.multiSelect)}
                          className={cn(
                            'text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                            active
                              ? 'border-indigo-500 bg-indigo-500/15 text-foreground'
                              : 'border-border/60 bg-background/60 hover:bg-indigo-500/5 hover:border-indigo-500/40',
                            locked && 'opacity-60 cursor-not-allowed'
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span
                              className={cn(
                                'mt-0.5 shrink-0 size-3.5 border flex items-center justify-center',
                                q.multiSelect ? 'rounded-sm' : 'rounded-full',
                                active
                                  ? 'border-indigo-500 bg-indigo-500 text-white'
                                  : 'border-border'
                              )}
                              aria-hidden
                            >
                              {active && <CheckIcon className="size-2.5" />}
                            </span>
                            <div className="min-w-0">
                              <div className="font-medium">{opt.label}</div>
                              {opt.description && (
                                <div className="text-muted-foreground text-[11px] mt-0.5">
                                  {opt.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => pickOther(qi)}
                      className={cn(
                        'text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                        isOther
                          ? 'border-indigo-500 bg-indigo-500/15 text-foreground'
                          : 'border-dashed border-border/60 bg-background/60 hover:bg-indigo-500/5 hover:border-indigo-500/40',
                        locked && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'shrink-0 size-3.5 rounded-full border flex items-center justify-center',
                            isOther ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-border'
                          )}
                          aria-hidden
                        >
                          {isOther && <CheckIcon className="size-2.5" />}
                        </span>
                        <span className="font-medium">Other…</span>
                      </div>
                    </button>
                    {isOther && (
                      <textarea
                        autoFocus
                        disabled={locked}
                        value={otherText.get(qi) ?? ''}
                        onChange={(e) => setOther(qi, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            handleSubmit()
                          }
                        }}
                        placeholder="Type your answer…"
                        className="w-full rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-indigo-500"
                        rows={2}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          {!collapsed && questions.length > 0 && (
            <div className="border-t border-indigo-500/20 bg-indigo-500/10 px-3 py-2 flex items-center gap-2">
              {locked ? (
                <span className="flex-1 text-xs text-muted-foreground whitespace-pre-wrap">
                  {submittedText ?? 'Answered.'}
                </span>
              ) : (
                <>
                  <span className="flex-1 text-[11px] text-muted-foreground">
                    {!canRespond
                      ? 'Cannot submit — chat send unavailable.'
                      : pendingPrompt
                        ? 'Submit resolves the tool with your answers.'
                        : 'Answer is sent as your next chat message.'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={!canCancel}
                    className={cn(
                      'shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      canCancel
                        ? 'border-border/60 bg-background/60 hover:bg-destructive/10 hover:border-destructive/40 hover:text-destructive text-muted-foreground'
                        : 'border-border/40 bg-muted/30 text-muted-foreground cursor-not-allowed'
                    )}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit || !canRespond}
                    className={cn(
                      'shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      canSubmit && canRespond
                        ? 'border-indigo-500/40 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-900 dark:text-indigo-100'
                        : 'border-border/40 bg-muted/30 text-muted-foreground cursor-not-allowed'
                    )}
                  >
                    Submit
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <HoverTimestamp timestamp={timestamp} />
      </div>
    </div>
  )
}

// Marker text the Approve/Cancel buttons send. Detector below scans for either
// to mark the plan as resolved — keep sender + detector in sync via these consts.
// Sentinel-style strings so normal user text ("Approved", "Cancelled") doesn't
// accidentally trigger plan resolution. Hidden from chat render via
// `isPlanMarker` below.
export const PLAN_APPROVED_MARKER = '__slay_plan_approved__'
export const PLAN_CANCELLED_MARKER = '__slay_plan_cancelled__'
export const isPlanMarker = (text: string): boolean =>
  text === PLAN_APPROVED_MARKER || text === PLAN_CANCELLED_MARKER

export function ToolCallExitPlanMode({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { plan?: string } | null
  const plan = input?.plan ?? ''
  const denied = invocation.denied === true
  const { setChatMode, sendMessage, timeline } = useChatView()
  // Show approve-footer only on the LAST ExitPlanMode card AND only until the
  // user clicks Approve. Both signals are derived from `timeline` so the state
  // survives unmount (virtualized scroll, tab switch). The click sends a
  // canonical 'Approved' user-text — its presence after this plan idx marks
  // it pressed. `denied` never flips back, so we can't rely on invocation
  // status alone.
  const { isLastPlan, pressed } = useMemo(() => {
    let lastPlanId: string | null = null
    let myIdx = -1
    for (let i = 0; i < timeline.length; i++) {
      const t = timeline[i]
      if (t.kind === 'tool' && t.invocation.name === 'ExitPlanMode') {
        lastPlanId = t.invocation.id
        if (t.invocation.id === invocation.id) myIdx = i
      }
    }
    let resolved = false
    if (myIdx >= 0) {
      for (let i = myIdx + 1; i < timeline.length; i++) {
        const t = timeline[i]
        if (
          t.kind === 'user-text' &&
          (t.text === PLAN_APPROVED_MARKER || t.text === PLAN_CANCELLED_MARKER)
        ) {
          resolved = true
          break
        }
      }
    }
    return { isLastPlan: lastPlanId === invocation.id, pressed: resolved }
  }, [timeline, invocation.id])
  const showApproveFooter = denied && isLastPlan && !pressed
  return (
    <div className="pl-4 pr-4 py-3">
      <div className="group flex gap-3 items-start">
        <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-sm">
          <ClipboardList className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-amber-500/40 bg-amber-500/5 shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            <ClipboardList className="size-3" />
            <span>Plan</span>
            <span className="ml-auto">
              <StatusIcon status={invocation.status} />
            </span>
          </div>
          {plan && (
            <div className="px-3 py-2 text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_ul]:my-2 [&_ol]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_code]:font-mono [&_code]:text-[0.85em]">
              <GhMarkdown>{plan}</GhMarkdown>
            </div>
          )}
          {showApproveFooter && (
            <div className="border-t border-amber-500/20 bg-amber-500/10 px-3 py-2 flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
              <span className="flex-1">Approve plan?</span>
              <button
                onClick={() => {
                  sendMessage?.(PLAN_CANCELLED_MARKER)
                }}
                disabled={!sendMessage}
                className="shrink-0 rounded-md border border-border/60 bg-background/60 hover:bg-destructive/10 hover:border-destructive/40 hover:text-destructive px-2 py-1 font-medium text-muted-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              {setChatMode && (
                <button
                  onClick={async () => {
                    try {
                      await setChatMode('auto-accept')
                    } catch {
                      return
                    }
                    sendMessage?.(PLAN_APPROVED_MARKER)
                  }}
                  className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/20 hover:bg-amber-500/30 px-2 py-1 font-medium text-amber-900 dark:text-amber-200 transition-colors"
                >
                  Approve & exit plan
                </button>
              )}
            </div>
          )}
        </div>
        <HoverTimestamp timestamp={timestamp} />
      </div>
    </div>
  )
}

export function ToolCallGeneric({ invocation, timestamp }: ToolProps) {
  const result = invocation.result?.rawContent
  const resultText =
    typeof result === 'string' ? result : result != null ? JSON.stringify(result, null, 2) : ''
  const inputPreview = JSON.stringify(invocation.input).slice(0, 80)
  return (
    <ToolShell
      icon={<HelpCircle className="size-3" />}
      title={invocation.name || 'Tool'}
      invocation={invocation}
      timestamp={timestamp}
      summary={inputPreview}
    >
      <div className="p-3 grid gap-2 text-xs font-mono">
        <div>
          <div className="text-muted-foreground/70 mb-1">Input</div>
          <pre className="whitespace-pre-wrap bg-muted/30 p-2 rounded">
            {JSON.stringify(invocation.input, null, 2)}
          </pre>
        </div>
        {resultText && (
          <div>
            <div className="text-muted-foreground/70 mb-1">Result</div>
            <pre className="whitespace-pre-wrap bg-muted/30 p-2 rounded max-h-64 overflow-y-auto">
              {resultText}
            </pre>
          </div>
        )}
      </div>
    </ToolShell>
  )
}

export const toolRenderers: Record<string, React.FC<ToolProps>> = {
  Edit: ToolCallEdit,
  Read: ToolCallRead,
  Write: ToolCallWrite,
  Bash: ToolCallBash,
  Glob: ToolCallGlob,
  Grep: ToolCallGrep,
  TodoWrite: ToolCallTodoWrite,
  ExitPlanMode: ToolCallExitPlanMode,
  AskUserQuestion: ToolCallAskUserQuestion
}

export function renderTool(invocation: ToolInvocation, timestamp?: number): React.JSX.Element {
  const R = toolRenderers[invocation.name] ?? ToolCallGeneric
  return <R invocation={invocation} timestamp={timestamp} />
}

/**
 * Items the dispatcher renders as `null`. Virtualized lists must filter these
 * before counting, otherwise reserved slot heights leave ghost gaps.
 */
export function isRenderable(item: TimelineItem): boolean {
  if (item.kind === 'session-start') return false
  if (item.kind === 'rate-limit' && item.status === 'allowed') return false
  // Launcher tool is rendered inside SubAgentRow's accordion, not at root.
  if (item.kind === 'tool' && isAgentLauncherToolName(item.invocation.name)) return false
  // Plan resolution markers are detector-only, never shown as user bubbles.
  if (item.kind === 'user-text' && isPlanMarker(item.text)) return false
  return true
}

/** Single dispatcher used by ChatPanel + the dev harness. */
export function renderTimelineItem(item: TimelineItem, key: React.Key): React.JSX.Element | null {
  switch (item.kind) {
    case 'user-text':
      return <UserMessage key={key} item={item} />
    case 'text':
      return <AssistantText key={key} item={item} />
    case 'thinking':
      return <ThinkingBlock key={key} item={item} />
    case 'tool':
      return <div key={key}>{renderTool(item.invocation, item.timestamp)}</div>
    case 'session-start':
      return null
    case 'result':
      return <ResultFooter key={key} item={item} />
    case 'api-retry':
      return <ApiRetryBanner key={key} item={item} />
    case 'rate-limit':
      return item.status === 'allowed' ? null : (
        <div key={key} className="mx-4 my-1 text-[11px] text-amber-600">
          rate limit: {item.status}
        </div>
      )
    case 'sub-agent':
      return <SubAgentRow key={key} item={item} />
    case 'stderr':
      return <StderrBlock key={key} item={item} />
    case 'interrupted':
      return <InterruptedBlock key={key} item={item} />
    case 'plan':
      return <PlanBlock key={key} item={item} />
    case 'unknown':
      return <UnknownBlock key={key} item={item} />
  }
}
