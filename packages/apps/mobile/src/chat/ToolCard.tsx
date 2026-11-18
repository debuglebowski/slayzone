/**
 * A tool call as a compact card: what ran on what (one line), its state, and — opened —
 * what it did: an edit's removed/added lines, a command and its output (live while it
 * runs as a CLI task: `chat.commandTaskOutput`, polled only while the card is open), the
 * todo list, or the raw output. AskUserQuestion and ExitPlanMode show the questions /
 * the plan and how they were answered (answering happens in the prompt dock).
 *
 * Output shows its first lines only (no scroll area inside the chat's scroll); "Show
 * all" opens the whole of it on its own screen, selectable, with Copy. Opened or closed,
 * a card stays so when the list draws its row again (`useExpanded`).
 */
import type { ChatPrompt } from '@slayzone/terminal/chat-prompts'
import type { ToolInvocation } from '@slayzone/terminal/reducer'
import { useQuery } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { TextViewer } from './TextViewer'
import { useExpanded } from './timeline-ui'
import type { ChromeColors } from '../theme'
import { useChatView } from './ChatViewContext'
import { Markdown } from './Markdown'
import { MONO, useThemedStyles } from './styles'
import { type ToolBody, toolBody, toolSummary } from './timeline-rows'
import { useTRPC } from '../trpc'

const POLL_MS = 1_000
/** Lines of output a card shows before "Show all". */
export const PREVIEW_LINES = 12

export const ToolCard = memo(function ToolCard({
  invocation,
  streaming = false
}: {
  invocation: ToolInvocation
  /** The call's input is still streaming in. */
  streaming?: boolean
}) {
  const { s, theme } = useThemedStyles(makeStyles)
  const { prompts, agentName = 'Claude' } = useChatView()
  const prompt = latestPromptFor(prompts, invocation.id)
  const special = invocation.name === 'AskUserQuestion' || invocation.name === 'ExitPlanMode'
  const [open, toggle] = useExpanded(`tool:${invocation.id}`, special)
  const { title, summary } = toolSummary(invocation)
  const waiting = prompt?.status === 'pending'

  return (
    <View style={[s.card, waiting && s.cardWaiting]} testID={`tool-${invocation.id}`}>
      <Pressable
        onPress={toggle}
        style={s.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title} ${summary}`}
      >
        <StatusGlyph invocation={invocation} streaming={streaming} theme={theme} s={s} />
        <Text style={s.title}>{title}</Text>
        <Text style={s.summary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={s.chevron} accessible={false}>
          {open ? '▾' : '▸'}
        </Text>
      </Pressable>
      {waiting && <Text style={s.waiting}>Waiting for your answer</Text>}
      {open && (
        <View style={s.body}>
          {invocation.name === 'AskUserQuestion' ? (
            <Questions invocation={invocation} prompt={prompt} agentName={agentName} s={s} />
          ) : invocation.name === 'ExitPlanMode' ? (
            <Plan invocation={invocation} prompt={prompt} agentName={agentName} s={s} />
          ) : (
            <Body invocation={invocation} title={title} s={s} />
          )}
        </View>
      )}
    </View>
  )
})

type Styles = ReturnType<typeof makeStyles>

function StatusGlyph({
  invocation,
  streaming,
  theme,
  s
}: {
  invocation: ToolInvocation
  streaming: boolean
  theme: ChromeColors
  s: Styles
}) {
  if (invocation.status === 'pending' || streaming) {
    return <ActivityIndicator size="small" color={theme.mutedForeground} style={s.glyph} />
  }
  if (invocation.status === 'denied' || invocation.denied)
    return <Text style={[s.glyph, s.warn]}>⊘</Text>
  if (invocation.status === 'error') return <Text style={[s.glyph, s.error]}>✕</Text>
  return <Text style={[s.glyph, s.ok]}>✓</Text>
}

function Body({ invocation, title, s }: { invocation: ToolInvocation; title: string; s: Styles }) {
  const [all, setAll] = useState(false)
  const running = invocation.task?.status === 'running'
  const live = useCommandOutput(invocation.task?.taskId, running)
  let body: ToolBody = toolBody(invocation)
  if (running && live && (live.state === 'running' || live.state === 'ended')) {
    const cmd = (invocation.input as { command?: string } | null)?.command ?? ''
    body = { type: 'text', text: `$ ${cmd}\n${live.output}` }
  } else if (invocation.task?.finalOutput && invocation.task.backgrounded) {
    body = { type: 'text', text: invocation.task.finalOutput.output }
  }
  if (!body) return <Text style={s.muted}>No output</Text>
  if (body.type === 'todos') {
    return (
      <View>
        {body.todos.map((t, i) => (
          <Text key={i} style={[s.todo, t.status === 'completed' && s.todoDone]}>
            {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} {t.content}
          </Text>
        ))}
      </View>
    )
  }
  const lines =
    body.type === 'diff' ? body.lines.map((l) => `${l.sign} ${l.text}`) : body.text.split('\n')
  const hidden = lines.length - PREVIEW_LINES
  const preview = hidden > 0 ? lines.slice(0, PREVIEW_LINES) : lines
  return (
    <View>
      <ScrollView horizontal>
        {body.type === 'diff' ? (
          <View>
            {body.lines.slice(0, preview.length).map((l, i) => (
              <Text key={i} style={[s.mono, l.sign === '-' ? s.removed : s.added]}>
                {l.sign} {l.text}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={s.mono} selectable>
            {preview.join('\n')}
          </Text>
        )}
      </ScrollView>
      {hidden > 0 ? (
        <Pressable
          onPress={() => setAll(true)}
          accessibilityRole="button"
          accessibilityLabel={`Show all ${lines.length} lines`}
          style={s.showAll}
        >
          <Text style={s.showAllText}>Show all ({hidden} more lines)</Text>
        </Pressable>
      ) : null}
      <TextViewer
        title={title}
        text={lines.join('\n')}
        mono
        visible={all}
        onClose={() => setAll(false)}
      />
    </View>
  )
}

/** A running CLI task's output so far, while its card is open. */
function useCommandOutput(taskId: string | undefined, running: boolean) {
  const trpc = useTRPC()
  const { tabId } = useChatView()
  const q = useQuery({
    ...trpc.chat.commandTaskOutput.queryOptions({ tabId, taskId: taskId ?? '' }),
    enabled: Boolean(taskId && running),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? POLL_MS : false),
    staleTime: 0,
    retry: false
  })
  return q.data
}

interface AskQuestion {
  question: string
  options: Array<{ label: string; description?: string }>
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

function Questions({
  invocation,
  prompt,
  agentName,
  s
}: {
  invocation: ToolInvocation
  prompt: ChatPrompt | null
  agentName: string
  s: Styles
}) {
  const answers = answersOf(prompt)
  return (
    <View>
      {questionsOf(invocation.input).map((q) => (
        <View key={q.question} style={s.question}>
          <Text style={s.questionText}>{q.question}</Text>
          {(q.options ?? []).map((o) => {
            const picked = answers?.[q.question]?.split(', ').includes(o.label) ?? false
            return (
              <Text key={o.label} style={[s.option, picked && s.optionPicked]}>
                {picked ? '● ' : '○ '}
                {o.label}
              </Text>
            )
          })}
        </View>
      ))}
      <Text style={s.muted}>{promptStatus(prompt, answers !== null, agentName)}</Text>
    </View>
  )
}

function Plan({
  invocation,
  prompt,
  agentName,
  s
}: {
  invocation: ToolInvocation
  prompt: ChatPrompt | null
  agentName: string
  s: Styles
}) {
  const plan = (invocation.input as { plan?: string } | null)?.plan ?? ''
  return (
    <View>
      <Markdown text={plan} />
      <Text style={s.muted}>{promptStatus(prompt, false, agentName)}</Text>
    </View>
  )
}

function answersOf(prompt: ChatPrompt | null): Record<string, string> | null {
  const d = prompt?.decision
  if (!d || d.behavior !== 'allow') return null
  const answers = (d.updatedInput as { answers?: unknown } | undefined)?.answers
  return answers && typeof answers === 'object' ? (answers as Record<string, string>) : null
}

function promptStatus(prompt: ChatPrompt | null, answered: boolean, agentName: string): string {
  if (!prompt) return ''
  switch (prompt.status) {
    case 'pending':
      return 'Waiting for your answer'
    case 'cancelled':
      return `Withdrawn by ${agentName}`
    case 'expired':
      return 'No longer active'
    default:
      if (answered) return 'Answered'
      return prompt.decision?.behavior === 'deny' ? 'Declined' : 'Approved'
  }
}

function latestPromptFor(prompts: readonly ChatPrompt[], toolUseId: string): ChatPrompt | null {
  for (let i = prompts.length - 1; i >= 0; i--)
    if (prompts[i].toolUseId === toolUseId) return prompts[i]
  return null
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    card: {
      marginHorizontal: 12,
      marginVertical: 4,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1,
      overflow: 'hidden'
    },
    cardWaiting: { borderColor: t.info },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 6
    },
    glyph: { width: 16, textAlign: 'center', fontSize: 13 },
    ok: { color: t.successForeground },
    error: { color: t.destructive },
    warn: { color: t.warningForeground },
    title: { color: t.foreground, fontWeight: '600', fontSize: 13 },
    summary: { flex: 1, color: t.mutedForeground, fontSize: 13, fontFamily: MONO },
    chevron: { color: t.mutedForeground, fontSize: 12 },
    waiting: { color: t.infoForeground, fontSize: 12, paddingHorizontal: 10, paddingBottom: 6 },
    body: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border, padding: 10 },
    showAll: { minHeight: 44, justifyContent: 'center' },
    showAllText: { color: t.infoForeground, fontSize: 13, fontWeight: '600' },
    mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: t.foreground },
    removed: { color: t.diffRemovedForeground },
    added: { color: t.diffAddedForeground },
    muted: { color: t.mutedForeground, fontSize: 12, marginTop: 4 },
    todo: { color: t.foreground, fontSize: 13, marginBottom: 2 },
    todoDone: { color: t.mutedForeground, textDecorationLine: 'line-through' },
    question: { marginBottom: 8 },
    questionText: { color: t.foreground, fontWeight: '600', fontSize: 14, marginBottom: 4 },
    option: { color: t.mutedForeground, fontSize: 13, marginLeft: 4 },
    optionPicked: { color: t.infoForeground, fontWeight: '600' }
  })
}
