import type { ReactNode } from 'react'
import {
  selectPromptForTool,
  type ChatPrompt,
  type ToolInvocation
} from '@slayzone/terminal/client'
import { useChatProvider, useChatView } from '../ChatViewContext'
import { buildPermissionView } from './prompt-options'

/** The prompt raised for a tool call, when this provider answers prompts with cards. */
export function usePromptFor(toolUseId: string): ChatPrompt | null {
  const { promptCards, prompts } = useChatView()
  if (!promptCards || !prompts) return null
  return selectPromptForTool({ prompts }, toolUseId)
}

const FEEDBACK_MARKER = 'To tell you how to proceed, the user said:\n'

/** The text a user typed with a rejection ("Tab to amend", "Tell Claude what to change"). */
export function feedbackOf(prompt: ChatPrompt): string | null {
  const d = prompt.decision
  if (!d || d.behavior !== 'deny') return null
  const at = d.message.indexOf(FEEDBACK_MARKER)
  return at === -1 ? null : d.message.slice(at + FEEDBACK_MARKER.length)
}

export const EXPIRED_TEXT = 'Expired'

/** Answers an AskUserQuestion got: from the recorded decision, else the tool result. */
export function answersOf(
  prompt: ChatPrompt | null,
  invocation: ToolInvocation
): Record<string, string> | null {
  const fromDecision =
    prompt?.decision?.behavior === 'allow'
      ? (prompt.decision.updatedInput as { answers?: unknown } | undefined)?.answers
      : undefined
  const fromResult = (invocation.result?.structured as { answers?: unknown } | null | undefined)
    ?.answers
  const answers = fromDecision ?? fromResult
  return answers && typeof answers === 'object' ? (answers as Record<string, string>) : null
}

/** The status line under an AskUserQuestion card. */
export function QuestionStatus({
  prompt,
  invocation
}: {
  prompt: ChatPrompt | null
  invocation: ToolInvocation
}) {
  const answers = answersOf(prompt, invocation)
  const provider = useChatProvider()
  if (prompt?.status === 'pending') {
    return <StatusText>Answer below ↓</StatusText>
  }
  if (prompt?.status === 'expired' || prompt?.status === 'cancelled') {
    return <StatusText>Expired — {provider.agent} is no longer waiting for this answer.</StatusText>
  }
  if (prompt?.decision?.behavior === 'deny') {
    return (
      <StatusText>
        {prompt.optionId === 'clarify'
          ? `User asked ${provider.agent} for more questions`
          : 'User declined to answer questions'}
      </StatusText>
    )
  }
  if (!answers) return null
  return (
    <div className="space-y-0.5">
      {prompt?.decision && (
        <StatusText>User answered {provider.agent}&apos;s questions:</StatusText>
      )}
      {Object.entries(answers).map(([q, a]) => (
        <div key={q} className="text-xs text-foreground/90">
          {`${q} → ${a}`}
        </div>
      ))}
    </div>
  )
}

const PLAN_APPROVALS: Record<string, string> = {
  'plan-auto': 'Approved · auto mode',
  'plan-accept-edits': 'Approved · auto-accept edits',
  'plan-manual': 'Approved · manually approve edits'
}

/** The status line under an ExitPlanMode card. */
export function PlanStatus({ prompt }: { prompt: ChatPrompt | null }) {
  if (!prompt) return null
  if (prompt.status === 'pending') return <StatusText>Waiting for your approval below ↓</StatusText>
  if (prompt.status === 'expired' || prompt.status === 'cancelled') {
    return <StatusText>{EXPIRED_TEXT}</StatusText>
  }
  if (prompt.decision?.behavior === 'allow') {
    return <StatusText>{PLAN_APPROVALS[prompt.optionId ?? ''] ?? 'Approved'}</StatusText>
  }
  const feedback = feedbackOf(prompt)
  if (feedback !== null) return <StatusText>{`Keep planning: ${feedback}`}</StatusText>
  return prompt.decision ? <StatusText>Rejected</StatusText> : null
}

/**
 * One line under a tool card whose call needed approval: waiting, or what was
 * decided (the picked row, the typed feedback), or expired.
 */
export function PromptStatusLine({ toolUseId }: { toolUseId: string }) {
  const prompt = usePromptFor(toolUseId)
  const { autoModeAvailable, cwd } = useChatView()
  const provider = useChatProvider()
  if (!prompt) return null
  let text: string | null = null
  if (prompt.status === 'pending') text = 'Waiting for your approval below ↓'
  else if (prompt.status === 'expired' || prompt.status === 'cancelled') text = EXPIRED_TEXT
  else if (prompt.decision?.behavior === 'allow') {
    const row =
      prompt.optionId && prompt.optionId !== 'yes'
        ? buildPermissionView(prompt.request, {
            autoModeAvailable: autoModeAvailable ?? false,
            cwd: cwd ?? '',
            agent: provider.agent
          }).options.find((o) => o.id === prompt.optionId)
        : undefined
    text = row ? `Allowed · ${row.label.replace(/^Yes, and /, '')}` : 'Allowed'
  } else if (prompt.decision) {
    const feedback = feedbackOf(prompt)
    text = feedback !== null ? `Rejected · ${feedback}` : 'Rejected'
  }
  if (!text) return null
  return (
    <div className="pl-14 pr-4 -mt-1 pb-1">
      <StatusText>{text}</StatusText>
    </div>
  )
}

function StatusText({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-muted-foreground">{children}</div>
}
