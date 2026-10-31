import { useRef, useState } from 'react'
import { toast } from '@slayzone/ui'
import type { CodexPlanReview } from '@slayzone/terminal/client'
import type { ChatCollaborationMode } from '@slayzone/terminal-contracts'
import { useTRPCClient } from '../trpc'

interface Props {
  review: CodexPlanReview
  target: { tabId: string; taskId: string; mode: string; cwd: string }
  onResolved: (mode: ChatCollaborationMode) => void
}

export function CodexPlanPrompt({ review, target, onResolved }: Props) {
  const client = useTRPCClient()
  const [busy, setBusy] = useState(false)
  const messageId = useRef<string | null>(null)

  const choose = async (decision: 'implement' | 'keep-planning'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (decision === 'implement') messageId.current ??= review.messageId ?? crypto.randomUUID()
      const result = await client.chat.decidePlan.mutate({
        ...target,
        planId: review.planId,
        decision,
        ...(decision === 'implement' && messageId.current ? { messageId: messageId.current } : {})
      })
      onResolved(result.chatCollaboration)
    } catch (err) {
      toast(`Plan review failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-4 mb-2 rounded-lg border border-agent/40 bg-agent/5 px-3 py-2">
      <div className="text-sm font-semibold">Implement this plan?</div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose('implement')}
          className="rounded bg-agent px-3 py-1.5 text-xs font-medium text-agent-contrast disabled:opacity-50"
        >
          {review.phase === 'resume' ? 'Retry implementation' : 'Implement'}
        </button>
        {review.phase === 'pending' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose('keep-planning')}
            className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Keep planning
          </button>
        )}
      </div>
    </div>
  )
}
