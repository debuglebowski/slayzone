import { useState, useMemo } from 'react'
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
  HelpCircle,
  Sparkles,
  Copy,
  Check as CheckIcon,
  User,
  Bot
} from 'lucide-react'
import { cn, safeClipboardWriteText, useDepsChanged } from '@slayzone/ui'
import { DiffView } from '@slayzone/diff-view'
import { GhMarkdown } from '@slayzone/markdown/client'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'
import { claudeEditResultToFileDiff } from './claude-patch-to-filediff'
import {
  CHAT_CARD_INDENT,
  formatTime,
  HoverTimestamp,
  LinkText,
  ToolShell,
  StatusIcon,
  shortenPath,
  extractRawText,
  type ToolProps
} from './tool-cards/card-shell'
import { questionsOf } from './prompts/QuestionPrompt'
import {
  answersOf,
  PlanStatus,
  PromptStatusLine,
  QuestionStatus,
  usePromptFor
} from './prompts/PromptStatus'
import { HighlightedText } from './HighlightedText'
import { CompactionRow } from './CompactionRow'
import { CommandOutputBlock } from './CommandOutputBlock'
import { HookOutputRow } from './HookOutputRow'
import { NoticeRow } from './NoticeRow'
import {
  McpToolCard,
  MultiEditCard,
  NotebookEditCard,
  WebFetchCard,
  WebSearchCard,
  WriteCard,
  parseMcpToolName
} from './tool-cards'

// --- Helpers ---

function useCopy(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void safeClipboardWriteText(text)
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
    <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-agent to-agent-emphasis flex items-center justify-center text-agent-contrast shadow-sm">
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
  // "Collapse all": adjusted during render — same trigger as a
  // `[collapseSignal]` effect (whose mount run was a no-op: starts closed).
  const [seenCollapseSignal, setSeenCollapseSignal] = useState(collapseSignal)
  if (!Object.is(seenCollapseSignal, collapseSignal)) {
    setSeenCollapseSignal(collapseSignal)
    setOpen(false)
  }
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
  // "Collapse all": adjusted during render — same trigger as a
  // `[collapseSignal]` effect (whose mount run was a no-op: starts collapsed).
  const [seenCollapseSignal, setSeenCollapseSignal] = useState(collapseSignal)
  if (!Object.is(seenCollapseSignal, collapseSignal)) {
    setSeenCollapseSignal(collapseSignal)
    setExpanded(false)
  }
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
          <CircleCheck className="size-3 text-success" />
        )}
        <span>{(item.durationMs / 1000).toFixed(1)}s</span>
        <span>·</span>
        <span>${item.turnCostUsd.toFixed(4)}</span>
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
    <div className="mx-4 my-1 px-3 py-1.5 text-xs rounded-md border border-warning/40 bg-warning/10 text-warning-foreground flex items-center gap-2">
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
    <div className="px-4 pl-[4.25rem] py-0.5 text-[11px] text-warning-foreground">
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
                s.status === 'completed' && 'bg-success',
                s.status === 'inProgress' && 'bg-warning',
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
  // everything else stays collapsed. A collapseSignal bump ("collapse all") forces
  // all back to closed — adjusted during render on a CHANGE only, so mounting
  // (incl. under an already-bumped signal) keeps the default.
  const [open, setOpen] = useState(errored)
  const collapseBumped = useDepsChanged([collapseSignal])
  if (collapseBumped) setOpen(false)

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
              <Loader2 className="size-3 shrink-0 animate-spin text-agent" />
            ) : errored ? (
              <CircleX className="size-3 shrink-0 text-destructive" />
            ) : (
              <CircleCheck className="size-3 shrink-0 text-success" />
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
          <div className="text-diff-removed-foreground">- {input.old_string}</div>
          <div className="text-diff-added-foreground">+ {input.new_string}</div>
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
                t.status === 'completed' && 'bg-success',
                t.status === 'in_progress' && 'bg-warning',
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

/**
 * AskUserQuestion in the timeline: the questions and what became of them
 * (answered, declined, handed back, expired). Answering happens in the prompt
 * dock above the composer; this card only reads the prompt's state, which the
 * event log carries — so a reload shows the same answer and nothing can be
 * answered twice.
 */
export function ToolCallAskUserQuestion({ invocation, timestamp }: ToolProps) {
  const questions = questionsOf(invocation.input)
  const { timeline, collapseSignal } = useChatView()
  const prompt = usePromptFor(invocation.id)
  const answers = answersOf(prompt, invocation)
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
  // Skip mount: initial state already honors latest-ask. Afterwards follow
  // latest-ask changes, then user-triggered "Collapse all" bumps (the signal
  // only ever increments, so "changed" = "differs from its mount value").
  // Adjusted during render, in that order — same triggers as an `[isLatestAsk]`
  // effect followed by a `[collapseSignal]` effect.
  const [collapseInputs, setCollapseInputs] = useState({ isLatestAsk, collapseSignal })
  const latestAskChanged = !Object.is(collapseInputs.isLatestAsk, isLatestAsk)
  const collapseSignalChanged = !Object.is(collapseInputs.collapseSignal, collapseSignal)
  if (latestAskChanged || collapseSignalChanged) {
    setCollapseInputs({ isLatestAsk, collapseSignal })
    if (latestAskChanged) setCollapsed(!isLatestAsk)
    if (collapseSignalChanged) setCollapsed(true)
  }
  const firstAnswer = answers ? Object.values(answers)[0] : undefined

  return (
    <div className="pl-4 pr-4 py-3">
      <div className="group flex gap-3 items-start">
        <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-info to-info-emphasis flex items-center justify-center text-info-contrast shadow-sm">
          <HelpCircle className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-info/40 bg-info/5 shadow-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              'w-full flex items-center gap-2 bg-info/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-info-foreground hover:bg-info/15 transition-colors',
              !collapsed && 'border-b border-info/20'
            )}
          >
            <HelpCircle className="size-3 shrink-0" />
            <span className="shrink-0">Question</span>
            {collapsed && (
              <span className="flex-1 min-w-0 truncate normal-case font-normal text-info-foreground/80">
                {firstAnswer ?? questions[0]?.question ?? ''}
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
              const picked = answers?.[q.question]?.split(', ') ?? []
              return (
                <div key={qi} className={cn('px-3 py-2', qi > 0 && 'border-t border-info/10')}>
                  <div className="text-sm font-medium text-foreground mb-1.5">{q.question}</div>
                  <ul className="grid gap-1">
                    {q.options.map((opt) => (
                      <li
                        key={opt.label}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs',
                          picked.includes(opt.label)
                            ? 'border-info bg-info/15 text-foreground'
                            : 'border-border/60 bg-background/60'
                        )}
                      >
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="text-muted-foreground"> — {opt.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          {!collapsed && questions.length > 0 && (prompt || answers) && (
            <div className="border-t border-info/20 bg-info/10 px-3 py-2">
              <QuestionStatus prompt={prompt} invocation={invocation} />
            </div>
          )}
        </div>
        <HoverTimestamp timestamp={timestamp} />
      </div>
    </div>
  )
}

// Marker texts older builds sent as chat messages to approve / cancel a plan.
// Plan approval now answers ExitPlanMode itself; the markers stay only so old
// conversations keep them hidden (`isRenderable`) and out of prompt history.
export const PLAN_APPROVED_MARKER = '__slay_plan_approved__'
export const PLAN_CANCELLED_MARKER = '__slay_plan_cancelled__'
export const isPlanMarker = (text: string): boolean =>
  text === PLAN_APPROVED_MARKER || text === PLAN_CANCELLED_MARKER

/**
 * ExitPlanMode in the timeline: the plan, and how it was answered. Approval
 * happens in the prompt dock right below ("Ready to code?").
 */
export function ToolCallExitPlanMode({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { plan?: string } | null
  const plan = input?.plan ?? ''
  const prompt = usePromptFor(invocation.id)
  return (
    <div className="pl-4 pr-4 py-3">
      <div className="group flex gap-3 items-start">
        <div className="shrink-0 size-7 rounded-full bg-gradient-to-br from-warning to-warning-emphasis flex items-center justify-center text-warning-contrast shadow-sm">
          <ClipboardList className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-warning/40 bg-warning/5 shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-foreground">
            <ClipboardList className="size-3" />
            <span>Plan</span>
            {/* No status icon while the plan waits: a pending prompt is not a failure. */}
            {prompt?.status !== 'pending' && (
              <span className="ml-auto">
                <StatusIcon status={invocation.status} />
              </span>
            )}
          </div>
          {plan && (
            <div className="px-3 py-2 text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-3 [&_ul]:my-2 [&_ol]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_code]:font-mono [&_code]:text-[0.85em]">
              <GhMarkdown>{plan}</GhMarkdown>
            </div>
          )}
          {prompt && (
            <div className="border-t border-warning/20 bg-warning/10 px-3 py-2">
              <PlanStatus prompt={prompt} />
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
  Write: WriteCard,
  MultiEdit: MultiEditCard,
  NotebookEdit: NotebookEditCard,
  WebFetch: WebFetchCard,
  WebSearch: WebSearchCard,
  Bash: ToolCallBash,
  Glob: ToolCallGlob,
  Grep: ToolCallGrep,
  TodoWrite: ToolCallTodoWrite,
  ExitPlanMode: ToolCallExitPlanMode,
  AskUserQuestion: ToolCallAskUserQuestion
}

/** Tools whose card shows its own prompt status. */
const OWN_PROMPT_STATUS = new Set(['AskUserQuestion', 'ExitPlanMode'])

export function renderTool(invocation: ToolInvocation, timestamp?: number): React.JSX.Element {
  const R =
    toolRenderers[invocation.name] ??
    (parseMcpToolName(invocation.name) ? McpToolCard : ToolCallGeneric)
  if (OWN_PROMPT_STATUS.has(invocation.name)) {
    return <R invocation={invocation} timestamp={timestamp} />
  }
  return (
    <>
      <R invocation={invocation} timestamp={timestamp} />
      <PromptStatusLine toolUseId={invocation.id} />
    </>
  )
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
        <div key={key} className="mx-4 my-1 text-[11px] text-warning-foreground">
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
    case 'compaction':
      return <CompactionRow key={key} item={item} />
    case 'command-output':
      return <CommandOutputBlock key={key} item={item} />
    case 'hook':
      return <HookOutputRow key={key} item={item} />
    case 'notice':
      return <NoticeRow key={key} item={item} />
    case 'unknown':
      return <UnknownBlock key={key} item={item} />
  }
}
