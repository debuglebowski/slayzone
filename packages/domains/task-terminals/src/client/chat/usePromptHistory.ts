import { useMemo, useState } from 'react'
import { useStableCallback } from '@slayzone/ui'
import { useAgentPrompts } from '../agent-prompts/useAgentPrompts'
import { buildPromptHistory } from './prompt-history'

/**
 * The task's prompt history for the composer, newest first: every prompt stored
 * for the task (`agent_prompts` — chat sends and terminal-agent prompts, so it
 * survives a chat reset) plus what this composer sent since mount (exactly as
 * typed, and visible before the stored copy arrives). `enabled` = the mode's
 * `promptHistory` capability; off → no query, no entries.
 */
export function usePromptHistory({ taskId, enabled }: { taskId: string; enabled: boolean }): {
  entries: string[]
  record: (text: string) => void
} {
  const stored = useAgentPrompts(taskId, undefined, enabled)
  const [sent, setSent] = useState<string[]>([])
  const entries = useMemo(
    () =>
      enabled
        ? buildPromptHistory(
            sent,
            stored.map((p) => p.text)
          )
        : [],
    [enabled, sent, stored]
  )
  const record = useStableCallback((text: string) => {
    if (!enabled || !text.trim()) return
    setSent((prev) => [text, ...prev])
  })
  return { entries, record }
}
