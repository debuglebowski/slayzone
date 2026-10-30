import { useEffect, useRef, type RefObject } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { toast } from '@slayzone/ui'
import type { ChatPrompt, TimelineItem } from '@slayzone/terminal/client'
import type { PermissionDecision } from '@slayzone/terminal-contracts'
import { useChatProvider, useChatView } from '../ChatViewContext'
import { PermissionPrompt } from './PermissionPrompt'
import { QuestionPrompt } from './QuestionPrompt'
import { PlanPrompt } from './PlanPrompt'
import { CODEX_QUESTIONS, CodexQuestionPrompt } from './CodexQuestionPrompt'
import type { PromptKeyHandler } from './prompt-keys'

export type { PromptKeyHandler } from './prompt-keys'

/** Subagent type of the Task that ran the prompting tool, when the timeline has it. */
function agentNameFor(prompt: ChatPrompt, timeline: TimelineItem[]): string | null {
  const tool = timeline.find((it) => it.kind === 'tool' && it.invocation.id === prompt.toolUseId) as
    | Extract<TimelineItem, { kind: 'tool' }>
    | undefined
  const parentId = tool?.parentToolUseId
  if (!parentId) return null
  const task = timeline.find((it) => it.kind === 'tool' && it.invocation.id === parentId) as
    | Extract<TimelineItem, { kind: 'tool' }>
    | undefined
  const type = (task?.invocation.input as { subagent_type?: unknown } | null)?.subagent_type
  return typeof type === 'string' && type ? type : null
}

/**
 * The agent's oldest pending prompt, answered above the composer — where the
 * TUI shows its dialog. One prompt at a time ("1 of N"); each kind has its own
 * body. Keys reach it through `keysRef` (see `prompt-keys.ts`).
 */
export function PromptDock({
  keysRef,
  autoFocus = false
}: {
  keysRef?: RefObject<PromptKeyHandler | null>
  /** Take focus when a prompt arrives and nothing is being typed (the active tab). */
  autoFocus?: boolean
}) {
  const {
    promptCards,
    prompts,
    submittingPrompts,
    respondPermission,
    autoModeAvailable,
    cwd,
    timeline,
    sendMessage
  } = useChatView()
  const provider = useChatProvider()
  const pending = promptCards ? (prompts ?? []).filter((p) => p.status === 'pending') : []
  const current = pending[0] ?? null
  const rootRef = useRef<HTMLElement | null>(null)
  const currentId = current?.requestId ?? null

  // A new prompt takes focus like the TUI's dialog — unless the user is typing
  // something (a non-empty composer, any other field).
  useEffect(() => {
    if (!autoFocus || !currentId) return
    const active = document.activeElement as HTMLElement | null
    const typing =
      active &&
      (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') &&
      (active as HTMLTextAreaElement).value !== ''
    if (!typing) rootRef.current?.focus()
  }, [autoFocus, currentId])

  if (!current) return null

  const submitting = submittingPrompts?.has(current.requestId) ?? false
  const answer = (optionId: string, decision: PermissionDecision): Promise<boolean> => {
    if (!respondPermission) return Promise.resolve(false)
    return respondPermission({ requestId: current.requestId, decision, optionId }).then(
      (ok) => {
        if (!ok)
          toast(`This request is no longer active — ${provider.agent} stopped waiting for it.`)
        return ok
      },
      (err: unknown) => {
        toast(`Could not send the answer: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    )
  }

  let body
  if (current.toolName === 'AskUserQuestion') {
    body = (
      <QuestionPrompt
        key={current.requestId}
        prompt={current}
        submitting={submitting}
        answer={answer}
        keysRef={keysRef}
      />
    )
  } else if (current.toolName === CODEX_QUESTIONS) {
    body = (
      <CodexQuestionPrompt
        key={current.requestId}
        prompt={current}
        submitting={submitting}
        answer={answer}
        keysRef={keysRef}
      />
    )
  } else if (current.toolName === 'ExitPlanMode') {
    body = (
      <PlanPrompt
        key={current.requestId}
        prompt={current}
        autoModeAvailable={autoModeAvailable ?? false}
        submitting={submitting}
        answer={answer}
        sendMessage={sendMessage}
        keysRef={keysRef}
      />
    )
  } else {
    body = (
      <PermissionPrompt
        key={current.requestId}
        prompt={current}
        autoModeAvailable={autoModeAvailable ?? false}
        cwd={cwd ?? ''}
        agentName={agentNameFor(current, timeline)}
        submitting={submitting}
        answer={answer}
        keysRef={keysRef}
      />
    )
  }

  return (
    <section
      ref={rootRef}
      data-prompt-dock
      tabIndex={-1}
      aria-label={`${provider.agent} is waiting for your answer`}
      className="mx-3 mb-2 max-h-[55vh] overflow-y-auto rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageCircleQuestion className="size-3" />
        <span>{provider.agent} is waiting for your answer</span>
        {pending.length > 1 && <span className="ml-auto">1 of {pending.length}</span>}
      </div>
      {body}
    </section>
  )
}
