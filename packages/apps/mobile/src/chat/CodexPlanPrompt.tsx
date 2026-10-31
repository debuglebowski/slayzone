import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CodexPlanReview } from '@slayzone/terminal/reducer'
import { useTRPCClient } from '../trpc'
import type { ChatTarget } from './useChatSession'
import { newMessageId } from './ids'
import { useThemedStyles } from './styles'
import type { ChromeColors } from '../theme'

export function CodexPlanPrompt({
  review,
  target,
  onResolved,
  notify
}: {
  review: CodexPlanReview
  target: ChatTarget
  onResolved: (mode: string) => void
  notify: (message: string) => void
}) {
  const { s } = useThemedStyles(makeStyles)
  const client = useTRPCClient()
  const [busy, setBusy] = useState(false)
  const messageId = useRef<string | null>(null)
  const choose = async (decision: 'implement' | 'keep-planning') => {
    if (busy) return
    setBusy(true)
    try {
      if (decision === 'implement') messageId.current ??= review.messageId ?? newMessageId()
      const result = await client.chat.decidePlan.mutate({
        ...target,
        planId: review.planId,
        decision,
        ...(decision === 'implement' && messageId.current ? { messageId: messageId.current } : {})
      })
      onResolved(result.chatCollaboration)
    } catch (err) {
      notify(`Plan review failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={s.box}>
      <Text style={s.title}>Implement this plan?</Text>
      <View style={s.row}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={s.button}
          onPress={() => void choose('implement')}
        >
          <Text style={s.buttonText}>
            {review.phase === 'resume' ? 'Retry implementation' : 'Implement'}
          </Text>
        </Pressable>
        {review.phase === 'pending' && (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={s.button}
            onPress={() => void choose('keep-planning')}
          >
            <Text style={s.buttonText}>Keep planning</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    box: {
      marginHorizontal: 12,
      marginVertical: 6,
      padding: 12,
      borderWidth: 1,
      borderColor: t.agent,
      borderRadius: 8,
      backgroundColor: t.card
    },
    title: { fontSize: 14, fontWeight: '600', color: t.foreground },
    row: { flexDirection: 'row', gap: 8, marginTop: 8 },
    button: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: t.primary
    },
    buttonText: { color: t.primaryForeground, fontSize: 13 }
  })
}
