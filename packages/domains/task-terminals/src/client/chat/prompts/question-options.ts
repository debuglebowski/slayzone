/**
 * The questions a prompt asks, parsed from its tool input. Pure: the prompt
 * cards render them, and the hub answers them for `slay chat answer`.
 *
 * @module chat/prompts/question-options
 */
import type { PermissionDecision } from '@slayzone/terminal-contracts'

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

/** Codex's user-input questions (`item/tool/requestUserInput`). */
export const CODEX_QUESTIONS = 'item/tool/requestUserInput'

export interface CodexQuestion {
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

/** Codex "Skip": answers nothing, the turn goes on. */
export const CODEX_SKIP: PermissionDecision = { behavior: 'deny', message: '' }
/** Codex Esc: stops the turn. */
export const CODEX_CANCEL: PermissionDecision = { behavior: 'deny', message: '', interrupt: true }
