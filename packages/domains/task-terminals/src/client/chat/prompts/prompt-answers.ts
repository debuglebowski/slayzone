/**
 * A pending prompt as plain data, and a typed answer turned into its wire
 * decision — for callers that have no card to click (`slay chat prompts` /
 * `slay chat answer`, served by the hub). Pure, and built on the same row
 * builders as the cards (`prompt-options`, `question-options`), so a CLI answer
 * sends exactly what the matching click sends.
 *
 * @module chat/prompts/prompt-answers
 */
import type { PermissionDecision, PermissionRequestEvent } from '@slayzone/terminal-contracts'
import {
  buildPermissionView,
  buildPlanOptions,
  clarifyDecision,
  declineQuestionDecision,
  feedbackDenial,
  questionAnswerDecision,
  REJECT_MESSAGE,
  type PermissionViewCtx,
  type PromptOption
} from './prompt-options'
import {
  CODEX_CANCEL,
  CODEX_QUESTIONS,
  CODEX_SKIP,
  codexQuestionsOf,
  questionsOf
} from './question-options'

export type ChatPromptKind = 'permission' | 'plan' | 'question' | 'codex-question'

export interface ChatPromptQuestionView {
  /** What the answer is filed under: the question text (AskUserQuestion) or its id (Codex). */
  key: string
  header?: string
  question: string
  options: string[]
  multiSelect: boolean
  /** A typed answer besides the options is accepted. */
  allowsOther: boolean
}

export interface ChatPromptOptionView {
  id: string
  label: string
  /** The row needs a message (`--message`). */
  needsFeedback: boolean
}

export interface ChatPromptView {
  requestId: string
  toolName: string
  kind: ChatPromptKind
  title: string
  subtitle?: string
  question?: string
  /** Rows answered by id (permission / plan). */
  options: ChatPromptOptionView[]
  /** Questions answered with `answers` (question / codex-question). */
  questions: ChatPromptQuestionView[]
  /** The tool's input (the command, the file, the plan). */
  input: unknown
}

export interface ChatPromptAnswer {
  /**
   * A row id from `options`, or an alias: `allow`, `deny`, `always`. Questions
   * take `answer` (implied by `answers`), `decline`, `clarify`; Codex questions
   * `submit`, `skip`, `cancel`.
   */
  optionId?: string
  /** Feedback: required by feedback rows; with `deny` it rejects and lets the turn go on. */
  message?: string
  /** Question answers keyed by question text, header, id or 1-based position. */
  answers?: Record<string, string | string[]>
}

export interface ChatPromptDecision {
  /** Persisted on `permission-resolved`, as a card click would. */
  optionId: string
  decision: PermissionDecision
  /** Send this as the next message once the answer lands ("approve with this feedback"). */
  followUpMessage?: string
}

/** The answer does not fit the prompt; the message says what would. */
export class ChatPromptAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatPromptAnswerError'
  }
}

export function chatPromptKind(toolName: string): ChatPromptKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === CODEX_QUESTIONS) return 'codex-question'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'permission'
}

const PLAN_REJECT: PromptOption = {
  id: 'plan-reject',
  label: 'No, keep planning',
  decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }
}

function planRows(ctx: PermissionViewCtx): PromptOption[] {
  return [...buildPlanOptions(ctx), PLAN_REJECT]
}

const optionView = (o: PromptOption): ChatPromptOptionView => ({
  id: o.id,
  label: o.label,
  needsFeedback: o.needsFeedback === true || o.decision === null
})

export function describeChatPrompt(
  req: PermissionRequestEvent,
  ctx: PermissionViewCtx
): ChatPromptView {
  const base = { requestId: req.requestId, toolName: req.toolName, input: req.input }
  const kind = chatPromptKind(req.toolName)
  if (kind === 'question') {
    return {
      ...base,
      kind,
      title: 'Question',
      options: [],
      questions: questionsOf(req.input).map((q) => ({
        key: q.question,
        ...(q.header ? { header: q.header } : {}),
        question: q.question,
        options: (q.options ?? []).map((o) => o.label),
        multiSelect: q.multiSelect === true,
        allowsOther: true
      }))
    }
  }
  if (kind === 'codex-question') {
    return {
      ...base,
      kind,
      title: 'Question',
      options: [],
      questions: codexQuestionsOf(req.input).map((q) => ({
        key: q.id,
        ...(q.header ? { header: q.header } : {}),
        question: q.question,
        options: q.options.map((o) => o.label),
        multiSelect: false,
        allowsOther: q.isOther || q.options.length === 0
      }))
    }
  }
  if (kind === 'plan') {
    return {
      ...base,
      kind,
      title: 'Ready to code?',
      question: `${ctx.agent ?? 'Claude'} has written up a plan and is ready to execute.`,
      options: planRows(ctx).map(optionView),
      questions: []
    }
  }
  const view = buildPermissionView(req, ctx)
  return {
    ...base,
    kind,
    title: view.title,
    ...(view.subtitle ? { subtitle: view.subtitle } : {}),
    question: view.question,
    options: view.options.map(optionView),
    questions: []
  }
}

function pickRow(rows: PromptOption[], id: string): PromptOption {
  const row = rows.find((r) => r.id === id)
  if (!row)
    throw new ChatPromptAnswerError(
      `Unknown option "${id}". Options: ${rows.map((r) => r.id).join(', ')}`
    )
  return row
}

function rowDecision(row: PromptOption, message: string | undefined): ChatPromptDecision {
  if (row.needsFeedback || !row.decision) {
    if (!message) throw new ChatPromptAnswerError(`Option "${row.id}" needs a message`)
    return { optionId: row.id, decision: feedbackDenial(message) }
  }
  if (message && row.decision.behavior === 'deny')
    return { optionId: row.id, decision: feedbackDenial(message) }
  return {
    optionId: row.id,
    decision: row.decision,
    ...(message ? { followUpMessage: message } : {})
  }
}

function decidePermission(
  req: PermissionRequestEvent,
  answer: ChatPromptAnswer,
  ctx: PermissionViewCtx
): ChatPromptDecision {
  const rows = buildPermissionView(req, ctx).options
  const id = answer.optionId ?? 'allow'
  const message = answer.message?.trim() || undefined
  if (id === 'allow') return rowDecision(rows[0], message)
  if (id === 'always') {
    const always = rows.find((r) => r.id === 'yes-dirs' || r.id === 'yes-rules')
    if (!always)
      throw new ChatPromptAnswerError(
        `This prompt offers no "always allow" row. Options: ${rows.map((r) => r.id).join(', ')}`
      )
    return rowDecision(always, message)
  }
  if (id === 'deny') {
    // The card's "No" (turn stops), or — with feedback — "No, and tell … what to do differently".
    if (message) return { optionId: 'no-feedback', decision: feedbackDenial(message) }
    const no = rows.find((r) => r.id === 'no')
    return no
      ? rowDecision(no, undefined)
      : { optionId: 'no-feedback', decision: { behavior: 'deny', message: REJECT_MESSAGE } }
  }
  return rowDecision(pickRow(rows, id), message)
}

function decidePlan(answer: ChatPromptAnswer, ctx: PermissionViewCtx): ChatPromptDecision {
  const rows = planRows(ctx)
  const id = answer.optionId ?? 'allow'
  const message = answer.message?.trim() || undefined
  if (id === 'allow') return rowDecision(rows[0], message)
  if (id === 'deny')
    return message
      ? { optionId: 'plan-feedback', decision: feedbackDenial(message) }
      : rowDecision(PLAN_REJECT, undefined)
  return rowDecision(pickRow(rows, id), message)
}

/** Resolve answer keys (text / header / id / 1-based position) to question views. */
function answersByKey(
  questions: ChatPromptQuestionView[],
  answers: Record<string, string | string[]>
): Map<ChatPromptQuestionView, string[]> {
  const out = new Map<ChatPromptQuestionView, string[]>()
  for (const [rawKey, rawValue] of Object.entries(answers)) {
    const key = rawKey.trim()
    const index = /^\d+$/.test(key) ? Number(key) - 1 : -1
    const q =
      questions.find((x) => x.key === key) ??
      questions.find((x) => x.question === key) ??
      questions.find(
        (x) => x.header !== undefined && x.header.toLowerCase() === key.toLowerCase()
      ) ??
      questions[index]
    if (!q)
      throw new ChatPromptAnswerError(
        `Unknown question "${rawKey}". Questions: ${questions.map((x, i) => `${i + 1}. ${x.question}`).join(' | ')}`
      )
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue])
      .map((v) => v.trim())
      .filter((v) => v !== '')
    out.set(
      q,
      values.map((v) => resolveOption(q, v))
    )
  }
  for (const q of questions) {
    if (!out.get(q)?.length) throw new ChatPromptAnswerError(`No answer for "${q.question}"`)
  }
  return out
}

/** An option label (case-insensitive), an option number, or — where allowed — free text. */
function resolveOption(q: ChatPromptQuestionView, value: string): string {
  const label = q.options.find((o) => o.toLowerCase() === value.toLowerCase())
  if (label) return label
  if (/^\d+$/.test(value)) {
    const byNumber = q.options[Number(value) - 1]
    if (byNumber) return byNumber
  }
  if (q.allowsOther) return value
  throw new ChatPromptAnswerError(
    `"${value}" is not an option for "${q.question}". Options: ${q.options.join(', ')}`
  )
}

function decideQuestion(
  req: PermissionRequestEvent,
  answer: ChatPromptAnswer,
  ctx: PermissionViewCtx
): ChatPromptDecision {
  const view = describeChatPrompt(req, ctx)
  const id = answer.optionId ?? 'answer'
  if (id === 'decline' || id === 'deny')
    return { optionId: 'decline', decision: declineQuestionDecision() }
  if (id === 'clarify') {
    const given = answer.answers ? answersByKeyLoose(view.questions, answer.answers) : {}
    return {
      optionId: 'clarify',
      decision: clarifyDecision(view.questions, given, {})
    }
  }
  if (id !== 'answer' && id !== 'allow')
    throw new ChatPromptAnswerError(`Unknown option "${id}". Options: answer, decline, clarify`)
  if (!answer.answers) throw new ChatPromptAnswerError('Answer the questions (answers)')
  const resolved = answersByKey(view.questions, answer.answers)
  const byQuestion = Object.fromEntries(
    view.questions.map((q) => [q.question, resolved.get(q)!.join(', ')])
  )
  return { optionId: 'answer', decision: questionAnswerDecision(req.input, byQuestion, {}) }
}

/** Clarify lists what was answered so far — partial answers are fine there. */
function answersByKeyLoose(
  questions: ChatPromptQuestionView[],
  answers: Record<string, string | string[]>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const one = Object.entries(answers).find(([k]) => {
      const key = k.trim()
      return (
        key === q.key ||
        key === q.question ||
        (/^\d+$/.test(key) && questions[Number(key) - 1] === q)
      )
    })
    if (one) out[q.question] = (Array.isArray(one[1]) ? one[1] : [one[1]]).join(', ')
  }
  return out
}

function decideCodexQuestion(
  req: PermissionRequestEvent,
  answer: ChatPromptAnswer,
  ctx: PermissionViewCtx
): ChatPromptDecision {
  const id = answer.optionId ?? 'submit'
  if (id === 'skip' || id === 'deny') return { optionId: 'skip', decision: CODEX_SKIP }
  if (id === 'cancel') return { optionId: 'cancel', decision: CODEX_CANCEL }
  if (id !== 'submit' && id !== 'allow' && id !== 'answer')
    throw new ChatPromptAnswerError(`Unknown option "${id}". Options: submit, skip, cancel`)
  if (!answer.answers) throw new ChatPromptAnswerError('Answer the questions (answers)')
  const view = describeChatPrompt(req, ctx)
  const resolved = answersByKey(view.questions, answer.answers)
  const answers = Object.fromEntries(view.questions.map((q) => [q.key, [resolved.get(q)![0]]]))
  return { optionId: 'submit', decision: { behavior: 'allow', updatedInput: { answers } } }
}

/** The wire answer for `answer` to `req`; throws `ChatPromptAnswerError` when it doesn't fit. */
export function decideChatPrompt(
  req: PermissionRequestEvent,
  answer: ChatPromptAnswer,
  ctx: PermissionViewCtx
): ChatPromptDecision {
  switch (chatPromptKind(req.toolName)) {
    case 'question':
      return decideQuestion(req, answer, ctx)
    case 'codex-question':
      return decideCodexQuestion(req, answer, ctx)
    case 'plan':
      return decidePlan(answer, ctx)
    default:
      return decidePermission(req, answer, ctx)
  }
}
