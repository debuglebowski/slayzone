import { useState, type RefObject } from 'react'
import { Button, cn } from '@slayzone/ui'
import type { ChatPrompt } from '@slayzone/terminal/client'
import type { PermissionDecision } from '@slayzone/terminal-contracts'
import type { PromptAnswer } from './PermissionPrompt'
import { isPlainKey, isTypingTarget, usePromptKeys, type PromptKeyHandler } from './prompt-keys'

/** Codex's plan-mode questions (`item/tool/requestUserInput`). */
export const CODEX_QUESTIONS = 'item/tool/requestUserInput'

interface CodexQuestion {
  id: string
  header: string
  question: string
  /** A free-text answer besides the options. */
  isOther: boolean
  /** The answer is typed hidden (a token, a password). */
  isSecret: boolean
  options: Array<{ label: string; description?: string }>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function codexQuestionsOf(input: unknown): CodexQuestion[] {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : []
  return raw.flatMap((q): CodexQuestion[] => {
    if (!isRecord(q) || !str(q.id)) return []
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) =>
          isRecord(o) && str(o.label)
            ? [
                {
                  label: str(o.label),
                  ...(str(o.description) ? { description: str(o.description) } : {})
                }
              ]
            : []
        )
      : []
    return [
      {
        id: str(q.id),
        header: str(q.header),
        question: str(q.question),
        isOther: q.isOther === true,
        isSecret: q.isSecret === true,
        options
      }
    ]
  })
}

const SKIP: PermissionDecision = { behavior: 'deny', message: '' }
const CANCEL: PermissionDecision = { behavior: 'deny', message: '', interrupt: true }

/**
 * The questions Codex asks in plan mode: each with its options (one pick) and,
 * where offered, a typed answer. Submit sends every answer keyed by question
 * id; Skip answers nothing (the turn goes on); Esc stops the turn. Keys 1–9
 * pick an option of the first unanswered question.
 */
export function CodexQuestionPrompt({
  prompt,
  submitting,
  answer,
  keysRef
}: {
  prompt: ChatPrompt
  submitting: boolean
  answer: PromptAnswer
  keysRef?: RefObject<PromptKeyHandler | null>
}) {
  const questions = codexQuestionsOf(prompt.input)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})

  const answerOf = (q: CodexQuestion): string => (typed[q.id] ?? '').trim() || picked[q.id] || ''
  const complete = questions.every((q) => answerOf(q) !== '')
  const submit = (): void => {
    if (!complete || submitting) return
    const answers = Object.fromEntries(questions.map((q) => [q.id, [answerOf(q)]]))
    void answer('submit', { behavior: 'allow', updatedInput: { answers } })
  }
  const pick = (q: CodexQuestion, label: string): void => {
    setPicked((p) => ({ ...p, [q.id]: label }))
    setTyped((t) => ({ ...t, [q.id]: '' }))
  }

  usePromptKeys(keysRef, (e) => {
    if (e.defaultPrevented) return false
    if (e.key === 'Escape' && isPlainKey(e) && !e.shiftKey) {
      if (!submitting) void answer('cancel', CANCEL)
      return true
    }
    if (isTypingTarget(document.activeElement) || !isPlainKey(e) || submitting) return false
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const q = questions.find((x) => answerOf(x) === '' && x.options.length > 0)
      const option = q?.options[Number(e.key) - 1]
      if (!q || !option) return false
      pick(q, option.label)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey && complete) {
      submit()
      return true
    }
    return false
  })

  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <div key={q.id} className="space-y-1.5">
          {q.header && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {q.header}
            </div>
          )}
          <div className="text-sm text-foreground">{q.question}</div>
          {q.options.length > 0 && (
            <div role="group" className="grid gap-0.5">
              {q.options.map((o, i) => {
                const selected = picked[q.id] === o.label && !(typed[q.id] ?? '').trim()
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={submitting}
                    aria-pressed={selected}
                    onClick={() => pick(q, o.label)}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                      selected
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/60 text-foreground'
                    )}
                  >
                    <span
                      aria-hidden
                      className="shrink-0 w-6 select-none font-mono text-muted-foreground"
                    >
                      {selected ? '❯' : ' '} {i + 1}.
                    </span>
                    <span className="min-w-0">
                      {o.label}
                      {o.description && (
                        <span className="text-muted-foreground"> — {o.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {(q.isOther || q.options.length === 0) && (
            <input
              type={q.isSecret ? 'password' : 'text'}
              aria-label={q.question}
              placeholder={q.options.length > 0 ? 'Other…' : 'Your answer'}
              value={typed[q.id] ?? ''}
              disabled={submitting}
              onChange={(e) => {
                const value = e.target.value
                setTyped((t) => ({ ...t, [q.id]: value }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              className="w-full rounded-md border border-input bg-input/30 px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!complete || submitting}
          onClick={submit}
        >
          Submit answers
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={submitting}
          onClick={() => void answer('skip', SKIP)}
        >
          Skip
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">Esc to stop the turn</span>
      </div>
    </div>
  )
}
