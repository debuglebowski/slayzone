import { useState, type RefObject } from 'react'
import { Button } from '@slayzone/ui'
import type { ChatPrompt } from '@slayzone/terminal/client'
import type { PromptAnswer } from './PermissionPrompt'
import { PromptRows } from './PromptRows'
import {
  CODEX_CANCEL as CANCEL,
  CODEX_SKIP as SKIP,
  codexQuestionsOf,
  type CodexQuestion
} from './question-options'
import { isPlainKey, isTypingTarget, usePromptKeys, type PromptKeyHandler } from './prompt-keys'

/**
 * The questions Codex asks through requestUserInput: each with its options (one pick) and,
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
        <div key={q.id} className="space-y-2">
          {questions.length > 1 && q.header && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {q.header}
            </div>
          )}
          <div className="text-sm font-medium text-foreground">{q.question}</div>
          {q.options.length > 0 && (
            <PromptRows
              options={q.options.map((o) => ({ id: o.label, ...o }))}
              selected={
                (typed[q.id] ?? '').trim()
                  ? -1
                  : q.options.findIndex((o) => o.label === picked[q.id])
              }
              disabled={submitting}
              onChoose={(i) => {
                const option = q.options[i]
                if (option) pick(q, option.label)
              }}
              appearance="cards"
              selectionMode="answer"
              label={q.question}
            />
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
              className="w-full rounded-md border border-input bg-input/30 px-3 py-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
