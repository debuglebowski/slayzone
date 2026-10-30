/**
 * One timeline item as a native row: the user's messages (their files, delivery state
 * and Retry), the agent's text (markdown; streaming text from the live store, so a delta
 * re-renders only the row it streams into), thinking, tool cards, sub-agents, turn
 * results, errors, an agent that could not start (with desktop's ways out), interruptions,
 * where a rewind / fork / switch changed the conversation (its folded rows shown on
 * demand), compactions, command output, hooks and notices.
 */
import { useLiveBlock } from '@slayzone/terminal/live-blocks'
import { streamKeyOf, type TimelineItem } from '@slayzone/terminal/reducer'
import { memo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { attachmentLabel } from './attachments'
import { useChatView } from './ChatViewContext'
import { Markdown } from './Markdown'
import { MONO, useThemedStyles } from './styles'
import { ToolCard } from './ToolCard'
import { agentProblemText, branchLabel, branchToggleLabel, interruptedLabel } from './timeline-rows'

type Item<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>

export const TimelineRow = memo(function TimelineRow({
  item,
  childItems,
  branchOpen = false,
  onToggleBranch
}: {
  item: TimelineItem
  /** A sub-agent's own items (its row lists them when opened). */
  childItems?: readonly TimelineItem[]
  /** A `conversation-branch` divider: its folded rows are shown. */
  branchOpen?: boolean
  /** A `conversation-branch` divider: show / hide its folded rows. */
  onToggleBranch?: (id: string) => void
}) {
  const { s } = useThemedStyles(makeStyles)
  switch (item.kind) {
    case 'user-text':
      return <UserMessage item={item} s={s} />
    case 'text':
      return <AssistantText item={item} s={s} />
    case 'thinking':
      return <Thinking item={item} s={s} />
    case 'tool':
      return <ToolCard invocation={item.invocation} streaming={item.inputStreaming === true} />
    case 'sub-agent':
      return <SubAgent item={item} childItems={childItems ?? []} s={s} />
    case 'result':
      return <TurnResult item={item} s={s} />
    case 'turn-error':
    case 'stderr':
      return (
        <Text style={[s.line, s.error]} selectable>
          {item.text}
        </Text>
      )
    case 'agent-problem':
      return <AgentProblem item={item} s={s} />
    case 'interrupted':
      return <Divider label={interruptedLabel(item)} s={s} />
    case 'conversation-branch': {
      const toggle = branchToggleLabel(item, branchOpen)
      return (
        <View style={s.divider} testID="chat-branch">
          <View style={s.rule} />
          <Text style={s.dividerText} numberOfLines={1}>
            {branchLabel(item)}
          </Text>
          {toggle && onToggleBranch ? (
            <Pressable
              onPress={() => onToggleBranch(item.id)}
              accessibilityRole="button"
              accessibilityLabel={toggle}
              accessibilityState={{ expanded: branchOpen }}
              hitSlop={8}
            >
              <Text style={s.toggle}>{toggle}</Text>
            </Pressable>
          ) : null}
          <View style={s.rule} />
        </View>
      )
    }
    case 'compaction':
      return (
        <Divider
          label={
            item.outcome === 'compacted'
              ? 'Conversation compacted'
              : `Compaction failed${item.error ? `: ${item.error}` : ''}`
          }
          s={s}
        />
      )
    case 'command-output':
      return (
        <View style={s.box}>
          {item.command && <Text style={s.caption}>/{item.command.replace(/^\//, '')}</Text>}
          <ScrollView horizontal>
            <Text style={[s.mono, item.isError && s.error]} selectable>
              {item.text}
            </Text>
          </ScrollView>
        </View>
      )
    case 'hook':
      return (
        <View style={s.box}>
          <Text style={s.caption}>
            Hook {item.hookName} ({item.hookEvent}) · {item.effect}
          </Text>
          {item.text ? (
            <Text style={s.text} selectable>
              {item.text}
            </Text>
          ) : null}
        </View>
      )
    case 'notice':
      return <Text style={[s.line, item.level === 'error' ? s.error : s.muted]}>{item.text}</Text>
    case 'api-retry':
      return (
        <Text style={[s.line, s.warn]}>
          Retrying ({item.attempt}/{item.maxRetries}) in{' '}
          {Math.max(1, Math.round(item.delayMs / 1000))}s — {item.error}
        </Text>
      )
    case 'rate-limit':
      return <Text style={[s.line, s.warn]}>Rate limited ({item.status})</Text>
    case 'plan':
      return (
        <View style={s.box}>
          <Text style={s.caption}>Plan</Text>
          {item.explanation ? <Text style={s.text}>{item.explanation}</Text> : null}
          {item.steps.map((step, i) => (
            <Text key={i} style={s.text}>
              {step.status === 'completed' ? '☑' : step.status === 'inProgress' ? '◐' : '☐'}{' '}
              {step.step}
            </Text>
          ))}
        </View>
      )
    default:
      return null
  }
})

type Styles = ReturnType<typeof makeStyles>

const DELIVERY: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending…',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
}

function UserMessage({ item, s }: { item: Item<'user-text'>; s: Styles }) {
  const { retryMessage } = useChatView()
  const failed = item.delivery === 'failed'
  return (
    <View style={s.userWrap}>
      <View style={[s.userBubble, failed && s.userFailed]}>
        {item.attachments && item.attachments.length > 0 ? (
          <View style={s.userFiles}>
            {item.attachments.map((file, i) => (
              <Text
                key={`${file.artifactId}-${i}`}
                style={s.userFile}
                numberOfLines={1}
                accessibilityLabel={attachmentLabel(file)}
              >
                📎 {file.name}
              </Text>
            ))}
          </View>
        ) : null}
        {item.text ? (
          <Text style={s.userText} selectable>
            {item.text}
          </Text>
        ) : null}
      </View>
      {failed ? (
        <View style={s.userStatusRow}>
          <Text style={[s.status, s.error]} numberOfLines={2}>
            Not sent{item.deliveryError ? `: ${item.deliveryError}` : ''}
          </Text>
          {item.id && (
            <Pressable
              onPress={() => retryMessage(item.id as string)}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={s.retry}>Retry</Text>
            </Pressable>
          )}
        </View>
      ) : item.delivery && item.delivery !== 'answered' && DELIVERY[item.delivery] ? (
        <Text style={s.status}>{DELIVERY[item.delivery]}</Text>
      ) : null}
    </View>
  )
}

function AgentProblem({ item, s }: { item: Item<'agent-problem'>; s: Styles }) {
  const { restartAgent, takeOver } = useChatView()
  const { title, hint, inUse } = agentProblemText(item)
  return (
    <View style={[s.box, s.errorBox]} accessibilityRole="alert">
      <Text style={s.error}>{title}</Text>
      <Text style={s.text}>{hint}</Text>
      <Text style={[s.mono, s.muted]} selectable>
        {item.message}
      </Text>
      <View style={s.actions}>
        {inUse ? (
          <Pressable onPress={takeOver} accessibilityRole="button" hitSlop={8}>
            <Text style={s.toggle}>Continue here</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={restartAgent}
          accessibilityRole="button"
          accessibilityLabel="Retry starting the agent"
          hitSlop={8}
        >
          <Text style={s.toggle}>Retry</Text>
        </Pressable>
      </View>
    </View>
  )
}

function AssistantText({ item, s }: { item: Item<'text'>; s: Styles }) {
  // Streaming: the live block holds the text so far; the row's own text once final.
  const live = useLiveBlock(item.stream ? streamKeyOf(item) : undefined)
  const text = live?.text ?? item.text
  if (!text) return null
  return (
    <View style={s.assistant}>
      <Markdown text={text} />
    </View>
  )
}

function Thinking({ item, s }: { item: Item<'thinking'>; s: Styles }) {
  const live = useLiveBlock(item.stream ? streamKeyOf(item) : undefined)
  const text = live?.text ?? item.text
  const [open, setOpen] = useState(false)
  return (
    <View style={s.thinking}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={s.caption}>
          {item.stream === 'open' ? 'Thinking…' : 'Thought'} {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {open && text ? <Markdown text={text} muted /> : null}
    </View>
  )
}

function SubAgent({
  item,
  childItems,
  s
}: {
  item: Item<'sub-agent'>
  childItems: readonly TimelineItem[]
  s: Styles
}) {
  const [open, setOpen] = useState(false)
  const state =
    item.phase === 'in-flight' ? 'Running' : item.phase === 'completed' ? 'Done' : 'Failed'
  return (
    <View style={[s.box, s.subAgent]}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={s.caption}>
          Sub-agent · {state}
          {item.toolUses ? ` · ${item.toolUses} tools` : ''} {open ? '▾' : '▸'}
        </Text>
        {item.description ? <Text style={s.text}>{item.description}</Text> : null}
        {item.summary ? <Text style={s.muted}>{item.summary}</Text> : null}
      </Pressable>
      {open &&
        childItems.map((child, i) =>
          child.kind === 'tool' || child.kind === 'text' ? (
            <TimelineRow key={i} item={child} />
          ) : null
        )}
    </View>
  )
}

function TurnResult({ item, s }: { item: Item<'result'>; s: Styles }) {
  if (item.isError) {
    return (
      <Text style={[s.line, s.error]} selectable>
        {item.text || `Turn failed (${item.subtype})`}
      </Text>
    )
  }
  const secs = Math.max(1, Math.round(item.durationMs / 1000))
  const cost =
    item.turnCostUsd !== undefined && item.turnCostUsd > 0
      ? ` · $${item.turnCostUsd.toFixed(2)}`
      : ''
  return (
    <Text style={[s.line, s.muted, s.result]}>
      Done in {secs}s{cost}
    </Text>
  )
}

function Divider({ label, s }: { label: string; s: Styles }) {
  return (
    <View style={s.divider}>
      <View style={s.rule} />
      <Text style={s.dividerText}>{label}</Text>
      <View style={s.rule} />
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    text: { color: t.foreground, fontSize: 14, lineHeight: 20 },
    muted: { color: t.mutedForeground, fontSize: 13 },
    caption: { color: t.mutedForeground, fontSize: 12, fontWeight: '600', marginBottom: 4 },
    error: { color: t.destructive },
    warn: { color: t.warningForeground },
    line: { marginHorizontal: 16, marginVertical: 4, fontSize: 13 },
    result: { textAlign: 'right' },
    mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: t.foreground },
    box: {
      marginHorizontal: 12,
      marginVertical: 4,
      padding: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1
    },
    errorBox: { borderColor: t.destructive },
    subAgent: { borderColor: t.agent },
    userWrap: { alignItems: 'flex-end', marginHorizontal: 12, marginVertical: 6 },
    userBubble: {
      maxWidth: '85%',
      backgroundColor: t.secondary,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 8
    },
    userFailed: { borderWidth: 1, borderColor: t.destructive },
    userText: { color: t.secondaryForeground, fontSize: 15, lineHeight: 21 },
    userFiles: { gap: 4, marginBottom: 4 },
    userFile: { color: t.secondaryForeground, fontSize: 13, opacity: 0.85 },
    userStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
    status: { color: t.mutedForeground, fontSize: 11, marginTop: 2 },
    retry: { color: t.infoForeground, fontSize: 13, fontWeight: '600' },
    assistant: { marginHorizontal: 16, marginVertical: 4 },
    thinking: { marginHorizontal: 16, marginVertical: 4 },
    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginVertical: 8,
      gap: 8
    },
    rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.border },
    dividerText: { color: t.mutedForeground, fontSize: 12, flexShrink: 1 },
    toggle: { color: t.infoForeground, fontSize: 12, fontWeight: '600' },
    actions: { flexDirection: 'row', gap: 16, marginTop: 8 }
  })
}
