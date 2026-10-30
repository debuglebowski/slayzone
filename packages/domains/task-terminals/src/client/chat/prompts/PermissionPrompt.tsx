import { useState, type RefObject } from 'react'
import { cn } from '@slayzone/ui'
import type { ChatPrompt } from '@slayzone/terminal/client'
import type { PermissionDecision } from '@slayzone/terminal-contracts'
import {
  buildPermissionView,
  feedbackDenial,
  REJECT_MESSAGE,
  type PermissionView
} from './prompt-options'
import { isPlainKey, isTypingTarget, usePromptKeys, type PromptKeyHandler } from './prompt-keys'
import { PromptRows } from './PromptRows'
import { CodexApprovalPreview } from './CodexApprovalPreview'
import { isCodexApproval } from './codex-approval-options'
import { useChatProvider } from '../ChatViewContext'

export interface PromptAnswer {
  (optionId: string, decision: PermissionDecision): Promise<boolean>
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function lines(v: unknown): string[] {
  return typeof v === 'string' ? v.split('\n') : []
}

const MAX_PREVIEW_LINES = 40

/** Removed then added lines of one replacement, the way the TUI's edit dialog shows it. */
function EditLines({ oldText, newText }: { oldText: unknown; newText: unknown }) {
  return (
    <>
      {lines(oldText).map((l, i) => (
        <div
          key={`o${i}`}
          className="flex gap-2 bg-diff-removed/40 text-diff-removed-foreground px-1.5"
        >
          <span aria-hidden className="select-none">
            -
          </span>
          <span className="whitespace-pre-wrap break-all">{l}</span>
        </div>
      ))}
      {lines(newText).map((l, i) => (
        <div
          key={`n${i}`}
          className="flex gap-2 bg-diff-added/40 text-diff-added-foreground px-1.5"
        >
          <span aria-hidden className="select-none">
            +
          </span>
          <span className="whitespace-pre-wrap break-all">{l}</span>
        </div>
      ))}
    </>
  )
}

/** What the tool would do: the command, the edit, the new file, the URL, the arguments. */
function ToolPreview({ prompt }: { prompt: ChatPrompt }) {
  if (isCodexApproval(prompt.toolName)) return <CodexApprovalPreview prompt={prompt} />
  const input = asRecord(prompt.input)
  const box =
    'rounded-md border border-border bg-surface-1 font-mono text-xs overflow-auto max-h-64'
  switch (prompt.toolName) {
    case 'Bash':
      return (
        <div className="space-y-1">
          {typeof input.description === 'string' && (
            <div className="text-xs text-muted-foreground">{input.description}</div>
          )}
          <div className={cn(box, 'px-2 py-1.5 flex gap-2')}>
            <span aria-hidden className="text-primary select-none">
              $
            </span>
            <span className="whitespace-pre-wrap break-all">{String(input.command ?? '')}</span>
          </div>
        </div>
      )
    case 'Edit':
      return (
        <div className={cn(box, 'py-1')}>
          <EditLines oldText={input.old_string} newText={input.new_string} />
        </div>
      )
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      return (
        <div className={cn(box, 'py-1 space-y-1')}>
          {edits.map((e, i) => (
            <div key={i}>
              <EditLines oldText={asRecord(e).old_string} newText={asRecord(e).new_string} />
            </div>
          ))}
        </div>
      )
    }
    case 'Write': {
      const content = lines(input.content)
      return (
        <div className={cn(box, 'px-2 py-1.5')}>
          {content.slice(0, MAX_PREVIEW_LINES).map((l, i) => (
            <div key={i} className="flex gap-3">
              <span aria-hidden className="select-none text-muted-foreground w-6 text-right">
                {i + 1}
              </span>
              <span className="whitespace-pre-wrap break-all">{l}</span>
            </div>
          ))}
          {content.length > MAX_PREVIEW_LINES && (
            <div className="text-muted-foreground">
              … {content.length - MAX_PREVIEW_LINES} more lines
            </div>
          )}
        </div>
      )
    }
    case 'WebFetch':
      return (
        <div className={cn(box, 'px-2 py-1.5 space-y-1')}>
          <div className="break-all">url: {String(input.url ?? '')}</div>
          {typeof input.prompt === 'string' && (
            <div className="whitespace-pre-wrap text-muted-foreground">prompt: {input.prompt}</div>
          )}
        </div>
      )
    default: {
      const entries = Object.entries(input)
      if (prompt.toolName.startsWith('mcp__')) {
        return (
          <div className={cn(box, 'px-2 py-1.5')}>
            {entries.map(([k, v]) => (
              <div key={k} className="whitespace-pre-wrap break-all">
                {k}: {JSON.stringify(v)}
              </div>
            ))}
          </div>
        )
      }
      return (
        <pre className={cn(box, 'px-2 py-1.5 whitespace-pre-wrap break-all')}>
          {JSON.stringify(prompt.input, null, 2)}
        </pre>
      )
    }
  }
}

interface PermissionPromptProps {
  prompt: ChatPrompt
  autoModeAvailable: boolean
  cwd: string
  agentName: string | null
  submitting: boolean
  answer: PromptAnswer
  keysRef?: RefObject<PromptKeyHandler | null>
}

/**
 * A `can_use_tool` request for a regular tool: the TUI's dialog — what the tool
 * would do, the question, numbered rows, and "Tab to amend" (reject with typed
 * feedback, the turn continues).
 */
export function PermissionPrompt({
  prompt,
  autoModeAvailable,
  cwd,
  agentName,
  submitting,
  answer,
  keysRef
}: PermissionPromptProps) {
  const provider = useChatProvider()
  const view: PermissionView = buildPermissionView(prompt.request, {
    autoModeAvailable,
    cwd,
    agentName,
    agent: provider.agent
  })
  const [selected, setSelected] = useState(view.defaultIndex)
  // The row whose typed feedback is being written ("Tab to amend" / WebFetch's No).
  const [amendFor, setAmendFor] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')

  const choose = (index: number): void => {
    const option = view.options[index]
    if (!option || submitting) return
    setSelected(index)
    if (option.needsFeedback || !option.decision) {
      setAmendFor(option.id)
      return
    }
    void answer(option.id, option.decision)
  }

  const submitFeedback = (): void => {
    if (submitting) return
    const text = feedback.trim()
    const decision: PermissionDecision = text
      ? feedbackDenial(text)
      : { behavior: 'deny', message: REJECT_MESSAGE }
    void answer(amendFor ?? 'no-feedback', decision)
  }

  usePromptKeys(keysRef, (e) => {
    if (e.defaultPrevented) return false
    if (e.key === 'Escape' && isPlainKey(e) && !e.shiftKey) {
      // Esc picks the cancel row: "No" (the turn stops), or WebFetch's
      // feedback row.
      if (!submitting) choose(view.options.length - 1)
      return true
    }
    if (isTypingTarget(document.activeElement)) return false
    if (!isPlainKey(e)) return false
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      choose(Number(e.key) - 1)
      return true
    }
    if (submitting) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSelected((i) => (i + step + view.options.length) % view.options.length)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      choose(selected)
      return true
    }
    if (e.key === 'Tab' && e.shiftKey && view.shiftTabOptionId) {
      choose(view.options.findIndex((o) => o.id === view.shiftTabOptionId))
      return true
    }
    if (e.key === 'Tab' && !e.shiftKey && view.canAmend) {
      setAmendFor('no-feedback')
      return true
    }
    return false
  })

  const filePath = asRecord(prompt.input).file_path
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground">
        <span>{view.title}</span>
        {view.agentLabel && (
          <span className="font-normal text-muted-foreground">· {view.agentLabel}</span>
        )}
      </div>
      {view.tip && <div className="text-[11px] text-muted-foreground">{view.tip}</div>}
      {view.subtitle && (
        <div
          className="text-xs text-foreground/90"
          title={typeof filePath === 'string' ? filePath : undefined}
        >
          {view.subtitle}
        </div>
      )}
      <ToolPreview prompt={prompt} />
      {view.decisionReason && (
        <div className="text-xs text-muted-foreground">{view.decisionReason}</div>
      )}
      <div className="text-sm text-foreground">{view.question}</div>
      <PromptRows
        options={view.options}
        selected={selected}
        disabled={submitting}
        onChoose={choose}
      />
      {amendFor && (
        <input
          autoFocus
          aria-label={`No, and tell ${provider.agent} what to do differently`}
          placeholder={`No, and tell ${provider.agent} what to do differently`}
          value={feedback}
          disabled={submitting}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitFeedback()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setAmendFor(null)
            }
          }}
          className="w-full rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
        />
      )}
      {view.footer && <div className="text-[11px] text-muted-foreground">{view.footer}</div>}
    </div>
  )
}
