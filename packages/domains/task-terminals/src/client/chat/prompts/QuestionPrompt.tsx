import { useState, type RefObject } from 'react'
import { CheckIcon } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { ChatPrompt } from '@slayzone/terminal/client'
import {
  clarifyDecision,
  declineQuestionDecision,
  questionAnswerDecision,
  type QuestionAnnotations
} from './prompt-options'
import { isPlainKey, isTypingTarget, usePromptKeys, type PromptKeyHandler } from './prompt-keys'
import type { PromptAnswer } from './PermissionPrompt'

export interface AskOption {
  label: string
  description?: string
  /** Shown beside the options when focused (a mock-up, a snippet). */
  preview?: string
}
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

export function questionsOf(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  return Array.isArray(qs)
    ? qs.filter(
        (q): q is AskQuestion =>
          q !== null && typeof q === 'object' && typeof (q as AskQuestion).question === 'string'
      )
    : []
}

/** Single-select questions with previews get the TUI's preview pane + notes. */
function hasPreviews(q: AskQuestion): boolean {
  return !q.multiSelect && (q.options ?? []).some((o) => typeof o.preview === 'string')
}

interface QuestionPromptProps {
  prompt: ChatPrompt
  submitting: boolean
  answer: PromptAnswer
  keysRef?: RefObject<PromptKeyHandler | null>
}

/**
 * AskUserQuestion: every question with its options ("Type something" for a
 * free answer), previews with notes, then Submit — or "Chat about this" (hand
 * the questions back to Claude), or Cancel (decline just this question; the
 * turn and the queue are untouched).
 *
 * Keys, as in the TUI: 1–9 pick an option of the current question (the last
 * number is "Type something"), ↑/↓ move, Enter picks (then the next question;
 * on Submit it submits), Tab / → and Shift+Tab / ← switch question, Esc
 * declines. Typing in a field is never taken for keys (Esc still declines).
 */
export function QuestionPrompt({ prompt, submitting, answer, keysRef }: QuestionPromptProps) {
  const questions = questionsOf(prompt.input)
  const [selections, setSelections] = useState<Map<number, string[]>>(() => new Map())
  const [otherActive, setOtherActive] = useState<Set<number>>(() => new Set())
  const [otherText, setOtherText] = useState<Map<number, string>>(() => new Map())
  /** Option whose preview is shown, per question (the last one picked or hovered). */
  const [focused, setFocused] = useState<Map<number, string>>(() => new Map())
  const [notes, setNotes] = useState<Map<number, string>>(() => new Map())
  /** The keyboard's place: question `q`, option `o` (`o` = options.length: "Type something"); `q` = questions.length: Submit. */
  const [cursor, setCursor] = useState<{ q: number; o: number }>({ q: 0, o: 0 })

  const setIn = <V,>(map: Map<number, V>, qi: number, value: V): Map<number, V> => {
    const next = new Map(map)
    next.set(qi, value)
    return next
  }

  const pickOption = (qi: number, label: string, multi: boolean): void => {
    if (submitting) return
    setOtherActive((prev) => {
      if (!prev.has(qi)) return prev
      const next = new Set(prev)
      next.delete(qi)
      return next
    })
    setSelections((prev) => {
      const cur = prev.get(qi) ?? []
      const nextSel = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label]
      return setIn(prev, qi, nextSel)
    })
    setFocused((prev) => setIn(prev, qi, label))
  }

  const pickOther = (qi: number): void => {
    if (submitting) return
    setOtherActive((prev) => new Set(prev).add(qi))
    setSelections((prev) => setIn(prev, qi, []))
  }

  const answerOf = (qi: number): string =>
    otherActive.has(qi) ? (otherText.get(qi) ?? '').trim() : (selections.get(qi) ?? []).join(', ')

  const canSubmit = questions.length > 0 && questions.every((_q, qi) => answerOf(qi).length > 0)

  const answersByQuestion = (): Record<string, string> => {
    const out: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const a = answerOf(qi)
      if (a) out[q.question] = a
    })
    return out
  }

  const notesByQuestion = (): Record<string, string> => {
    const out: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const n = (notes.get(qi) ?? '').trim()
      if (n && hasPreviews(q)) out[q.question] = n
    })
    return out
  }

  const submit = (): void => {
    if (!canSubmit || submitting) return
    const annotations: QuestionAnnotations = {}
    const noteMap = notesByQuestion()
    questions.forEach((q, qi) => {
      if (!hasPreviews(q) || otherActive.has(qi)) return
      const picked = (selections.get(qi) ?? [])[0]
      const preview = q.options.find((o) => o.label === picked)?.preview
      const note = noteMap[q.question]
      if (preview || note) {
        annotations[q.question] = {
          ...(preview ? { preview } : {}),
          ...(note ? { notes: note } : {})
        }
      }
    })
    void answer('answer', questionAnswerDecision(prompt.input, answersByQuestion(), annotations))
  }

  const decline = (): void => {
    if (submitting) return
    void answer('decline', declineQuestionDecision())
  }

  /** Move the keyboard's place; a question with previews shows the option there. */
  const moveTo = (q: number, o: number): void => {
    setCursor({ q, o })
    const label = questions[q]?.options[o]?.label
    if (label && hasPreviews(questions[q])) setFocused((prev) => setIn(prev, q, label))
  }

  /** Pick option `oi` of question `qi` by key: a single answer moves on to the next question. */
  const pickByKey = (qi: number, oi: number): void => {
    const q = questions[qi]
    if (oi === q.options.length) {
      setCursor({ q: qi, o: oi })
      pickOther(qi)
      return
    }
    pickOption(qi, q.options[oi].label, q.multiSelect === true)
    if (q.multiSelect) setCursor({ q: qi, o: oi })
    else moveTo(qi + 1, 0)
  }

  usePromptKeys(keysRef, (e) => {
    if (e.defaultPrevented) return false
    if (e.key === 'Escape' && isPlainKey(e) && !e.shiftKey) {
      decline()
      return true
    }
    if (isTypingTarget(document.activeElement) || !isPlainKey(e) || submitting) return false
    const onSubmit = cursor.q >= questions.length
    const rows = onSubmit ? 0 : questions[cursor.q].options.length + 1
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const oi = Number(e.key) - 1
      if (onSubmit || oi >= rows) return false
      pickByKey(cursor.q, oi)
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (onSubmit) {
        if (e.key === 'ArrowUp' && questions.length > 0) moveTo(questions.length - 1, 0)
        return true
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      moveTo(cursor.q, (cursor.o + step + rows) % rows)
      return true
    }
    const next = (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowRight'
    const prev = (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowLeft'
    if (next || prev) {
      moveTo(Math.max(0, Math.min(questions.length, cursor.q + (next ? 1 : -1))), 0)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (onSubmit) submit()
      else pickByKey(cursor.q, cursor.o)
      return true
    }
    return false
  })

  if (questions.length === 0) {
    return <div className="text-sm text-muted-foreground">No questions provided.</div>
  }

  return (
    <div className="space-y-3">
      {questions.map((q, qi) => {
        const sel = selections.get(qi) ?? []
        const isOther = otherActive.has(qi)
        const showPreview = hasPreviews(q)
        const shownLabel = focused.get(qi) ?? q.options[0]?.label
        const preview = q.options.find((o) => o.label === shownLabel)?.preview
        return (
          <div key={qi} className="space-y-1.5">
            {q.header && (
              <div className="text-[11px] font-semibold uppercase tracking-wide text-info-foreground">
                {q.header}
              </div>
            )}
            <div className="text-sm font-medium text-foreground">{q.question}</div>
            <div className={cn(showPreview && 'grid grid-cols-2 gap-2')}>
              <div className="grid gap-1.5 content-start">
                {q.options.map((opt, oi) => {
                  const active = sel.includes(opt.label)
                  const keyFocus = cursor.q === qi && cursor.o === oi
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      data-key-focus={keyFocus ? 'true' : undefined}
                      disabled={submitting}
                      onClick={() => pickOption(qi, opt.label, q.multiSelect === true)}
                      onMouseEnter={() => {
                        if (showPreview) setFocused((prev) => setIn(prev, qi, opt.label))
                      }}
                      className={cn(
                        'text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                        active
                          ? 'border-info bg-info/15 text-foreground'
                          : 'border-border/60 bg-background/60 hover:bg-info/5 hover:border-info/40',
                        keyFocus && 'ring-1 ring-info',
                        submitting && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-0.5 shrink-0 size-3.5 border flex items-center justify-center',
                            q.multiSelect ? 'rounded-sm' : 'rounded-full',
                            active ? 'border-info bg-info text-info-contrast' : 'border-border'
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
                  disabled={submitting}
                  data-key-focus={
                    cursor.q === qi && cursor.o === q.options.length ? 'true' : undefined
                  }
                  onClick={() => pickOther(qi)}
                  className={cn(
                    'text-left rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    isOther
                      ? 'border-info bg-info/15 text-foreground'
                      : 'border-dashed border-border/60 bg-background/60 hover:bg-info/5 hover:border-info/40',
                    cursor.q === qi && cursor.o === q.options.length && 'ring-1 ring-info'
                  )}
                >
                  Type something
                </button>
                {isOther && (
                  <textarea
                    autoFocus
                    disabled={submitting}
                    value={otherText.get(qi) ?? ''}
                    onChange={(e) => {
                      const value = e.target.value
                      setOtherText((prev) => setIn(prev, qi, value))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    placeholder="Type something…"
                    rows={2}
                    className="w-full rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-info"
                  />
                )}
              </div>
              {showPreview && (
                <div className="space-y-1.5 min-w-0">
                  <pre className="rounded-md border border-border bg-surface-1 px-2 py-1.5 font-mono text-[11px] whitespace-pre overflow-auto max-h-48">
                    {preview ?? 'No preview available'}
                  </pre>
                  <textarea
                    disabled={submitting}
                    value={notes.get(qi) ?? ''}
                    onChange={(e) => {
                      const value = e.target.value
                      setNotes((prev) => setIn(prev, qi, value))
                    }}
                    placeholder="Add notes on this design…"
                    rows={2}
                    className="w-full rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-info"
                  />
                </div>
              )}
            </div>
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() =>
            void answer(
              'clarify',
              clarifyDecision(questions, answersByQuestion(), notesByQuestion())
            )
          }
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-60"
        >
          Chat about this
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={submitting}
          onClick={decline}
          className="shrink-0 rounded-md border border-border/60 bg-background/60 hover:bg-destructive/10 hover:border-destructive/40 hover:text-destructive px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit || submitting}
          data-key-focus={cursor.q >= questions.length ? 'true' : undefined}
          onClick={submit}
          className={cn(
            'shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
            canSubmit && !submitting
              ? 'border-info/40 bg-info/20 hover:bg-info/30 text-info-foreground'
              : 'border-border/40 bg-muted/30 text-muted-foreground cursor-not-allowed',
            cursor.q >= questions.length && 'ring-1 ring-info'
          )}
        >
          Submit
        </button>
      </div>
    </div>
  )
}
