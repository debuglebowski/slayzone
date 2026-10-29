import { useState, type RefObject } from 'react'
import type { ChatPrompt } from '@slayzone/terminal/client'
import { buildPlanOptions, feedbackDenial, REJECT_MESSAGE } from './prompt-options'
import { isPlainKey, isTypingTarget, usePromptKeys, type PromptKeyHandler } from './prompt-keys'
import type { PromptAnswer } from './PermissionPrompt'
import { PromptRows } from './PromptRows'

interface PlanPromptProps {
  prompt: ChatPrompt
  autoModeAvailable: boolean
  submitting: boolean
  answer: PromptAnswer
  /** Sends the feedback after "approve with this feedback". */
  sendMessage?: (text: string) => void
  keysRef?: RefObject<PromptKeyHandler | null>
}

/**
 * ExitPlanMode — "Ready to code?". The plan itself is the timeline card right
 * above. Approving answers the request (the mode switch rides the answer);
 * "Tell Claude what to change" rejects it with the feedback so Claude keeps
 * planning. "Approve with this feedback" (the TUI's shift+tab) has no wire
 * field: it approves, then sends the feedback as the next message.
 */
export function PlanPrompt({
  prompt,
  autoModeAvailable,
  submitting,
  answer,
  sendMessage,
  keysRef
}: PlanPromptProps) {
  const options = buildPlanOptions({ autoModeAvailable })
  const [selected, setSelected] = useState(0)
  const [writing, setWriting] = useState(false)
  const [feedback, setFeedback] = useState('')
  void prompt

  const choose = (index: number): void => {
    const option = options[index]
    if (!option || submitting) return
    setSelected(index)
    if (option.needsFeedback || !option.decision) {
      setWriting(true)
      return
    }
    void answer(option.id, option.decision)
  }

  const keepPlanning = (): void => {
    const text = feedback.trim()
    if (!text || submitting) return
    void answer('plan-feedback', feedbackDenial(text))
  }

  const approveWithFeedback = (): void => {
    const text = feedback.trim()
    const approve = options[0]
    if (!text || submitting || !approve.decision) return
    void answer(approve.id, approve.decision).then((ok) => {
      if (ok) sendMessage?.(text)
    })
  }

  usePromptKeys(keysRef, (e) => {
    if (e.defaultPrevented) return false
    if (e.key === 'Escape' && isPlainKey(e) && !e.shiftKey) {
      // The TUI's Esc rejects the plan and stops the turn.
      if (!submitting) {
        void answer('plan-reject', { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true })
      }
      return true
    }
    if (isTypingTarget(document.activeElement) || !isPlainKey(e)) return false
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      choose(Number(e.key) - 1)
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSelected((i) => (i + step + options.length) % options.length)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      choose(selected)
      return true
    }
    return false
  })

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-foreground">Ready to code?</div>
      <div className="text-xs text-muted-foreground">
        Here is Claude&apos;s plan: see the plan card above.
      </div>
      <div className="text-sm text-foreground">
        Claude has written up a plan and is ready to execute. Would you like to proceed?
      </div>
      <PromptRows options={options} selected={selected} disabled={submitting} onChoose={choose} />
      {writing && (
        <div className="space-y-1">
          <textarea
            autoFocus
            aria-label="Tell Claude what to change"
            placeholder="Tell Claude what to change"
            value={feedback}
            disabled={submitting}
            rows={2}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault()
                approveWithFeedback()
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                keepPlanning()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setWriting(false)
              }
            }}
            className="w-full rounded-md border border-input bg-input/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
          />
          <div className="text-[11px] text-muted-foreground">
            Enter to send · shift+tab to approve with this feedback
          </div>
        </div>
      )}
    </div>
  )
}
