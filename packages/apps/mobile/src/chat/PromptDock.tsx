/**
 * "Claude is waiting for you": the agent's oldest pending question, answered above the
 * composer — desktop's prompt dock (`task-terminals/src/client/chat/prompts/`), with its
 * wording and rows (`@slayzone/task-terminals/prompt-options`):
 *
 *   - a tool permission: what the tool would do, the question, one button per row
 *     (Yes / don't ask again / switch mode / No — the turn stops), and "No, and tell
 *     Claude what to do differently" (the tool is rejected, the turn goes on);
 *   - AskUserQuestion: each question's options (several where it allows), "Type
 *     something", then Submit — or "Chat about this" / Cancel;
 *   - ExitPlanMode: approve (with a mode), or tell Claude what to change.
 *
 * One at a time ("1 of N"). An answer is sent once: the buttons are disabled while it
 * is on its way, and a refusal (no longer pending) is said, not retried.
 */
import type { PermissionDecision } from '@slayzone/terminal-contracts'
import type { ChatPrompt } from '@slayzone/terminal/chat-prompts'
import type { TimelineItem } from '@slayzone/terminal/reducer'
import {
  buildPermissionView,
  buildPlanOptions,
  clarifyDecision,
  declineQuestionDecision,
  feedbackDenial,
  type PromptOption,
  questionAnswerDecision,
  REJECT_MESSAGE
} from '@slayzone/task-terminals/prompt-options'
import { type ReactNode, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { MONO, useThemedStyles } from './styles'
import { questionsOf } from './ToolCard'

export type PromptAnswer = (optionId: string, decision: PermissionDecision) => Promise<boolean>

export function PromptDock({
  prompts,
  submitting,
  answer,
  autoModeAvailable,
  cwd,
  timeline,
  sendMessage
}: {
  prompts: readonly ChatPrompt[]
  submitting: ReadonlySet<string>
  answer: (requestId: string, optionId: string, decision: PermissionDecision) => Promise<boolean>
  autoModeAvailable: boolean
  cwd: string
  timeline: readonly TimelineItem[]
  /** Sends feedback after "approve with this feedback". */
  sendMessage: (text: string) => void
}) {
  const { s } = useThemedStyles(makeStyles)
  const pending = prompts.filter((p) => p.status === 'pending')
  const current = pending[0]
  if (!current) return null
  const busy = submitting.has(current.requestId)
  const reply: PromptAnswer = (optionId, decision) => answer(current.requestId, optionId, decision)

  let body: ReactNode
  if (current.toolName === 'AskUserQuestion') {
    body = (
      <QuestionPrompt key={current.requestId} prompt={current} busy={busy} answer={reply} s={s} />
    )
  } else if (current.toolName === 'ExitPlanMode') {
    body = (
      <PlanPrompt
        key={current.requestId}
        autoModeAvailable={autoModeAvailable}
        busy={busy}
        answer={reply}
        sendMessage={sendMessage}
        s={s}
      />
    )
  } else {
    body = (
      <PermissionPrompt
        key={current.requestId}
        prompt={current}
        autoModeAvailable={autoModeAvailable}
        cwd={cwd}
        agentName={agentNameFor(current, timeline)}
        busy={busy}
        answer={reply}
        s={s}
      />
    )
  }
  return (
    <View
      style={s.dock}
      testID="prompt-dock"
      accessibilityLabel="Claude is waiting for your answer"
    >
      <View style={s.dockHeader}>
        <Text style={s.dockTitle}>Claude is waiting for your answer</Text>
        {pending.length > 1 && <Text style={s.dockCount}>1 of {pending.length}</Text>}
      </View>
      <ScrollView style={s.dockBody} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
    </View>
  )
}

type Styles = ReturnType<typeof makeStyles>

/** Subagent type of the Task that ran the prompting tool, when the timeline has it. */
function agentNameFor(prompt: ChatPrompt, timeline: readonly TimelineItem[]): string | null {
  const tool = timeline.find((it) => it.kind === 'tool' && it.invocation.id === prompt.toolUseId)
  const parentId = tool?.parentToolUseId
  if (!parentId) return null
  const task = timeline.find((it) => it.kind === 'tool' && it.invocation.id === parentId)
  const type =
    task?.kind === 'tool'
      ? (task.invocation.input as { subagent_type?: unknown } | null)?.subagent_type
      : null
  return typeof type === 'string' && type ? type : null
}

function Rows({
  options,
  busy,
  onChoose,
  s
}: {
  options: PromptOption[]
  busy: boolean
  onChoose: (index: number) => void
  s: Styles
}) {
  return (
    <View style={s.rows}>
      {options.map((o, i) => (
        <Pressable
          key={o.id}
          disabled={busy}
          onPress={() => onChoose(i)}
          style={({ pressed }) => [s.row, pressed && s.rowPressed, busy && s.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={s.rowNumber}>{i + 1}.</Text>
          <Text style={s.rowLabel}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function Feedback({
  placeholder,
  busy,
  onSubmit,
  onCancel,
  s
}: {
  placeholder: string
  busy: boolean
  onSubmit: (text: string) => void
  onCancel?: () => void
  s: Styles
}) {
  const [text, setText] = useState('')
  return (
    <View style={s.feedback}>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        multiline
        editable={!busy}
        style={s.input}
      />
      <View style={s.actions}>
        {onCancel && <Action label="Back" onPress={onCancel} busy={busy} s={s} />}
        <Action label="Send" onPress={() => onSubmit(text.trim())} busy={busy} s={s} primary />
      </View>
    </View>
  )
}

function Action({
  label,
  onPress,
  busy,
  s,
  primary = false,
  disabled = false
}: {
  label: string
  onPress: () => void
  busy: boolean
  s: Styles
  primary?: boolean
  disabled?: boolean
}) {
  const off = busy || disabled
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={[s.action, primary && s.actionPrimary, off && s.disabled]}
      accessibilityRole="button"
      accessibilityState={{ disabled: off }}
    >
      <Text style={[s.actionText, primary && s.actionTextPrimary]}>{label}</Text>
    </Pressable>
  )
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** What the tool would do: the command, the edit, the new file, the URL, the arguments. */
function ToolPreview({ prompt, s }: { prompt: ChatPrompt; s: Styles }) {
  const input = asRecord(prompt.input)
  let text: string
  switch (prompt.toolName) {
    case 'Bash':
      text = `$ ${String(input.command ?? '')}`
      break
    case 'Edit':
      text = [
        ...String(input.old_string ?? '')
          .split('\n')
          .map((l) => `- ${l}`),
        ...String(input.new_string ?? '')
          .split('\n')
          .map((l) => `+ ${l}`)
      ].join('\n')
      break
    case 'Write':
      text = String(input.content ?? '')
        .split('\n')
        .slice(0, 40)
        .join('\n')
      break
    case 'WebFetch':
      text = String(input.url ?? '')
      break
    default:
      text = JSON.stringify(prompt.input, null, 2) ?? ''
  }
  return (
    <ScrollView horizontal style={s.preview}>
      <Text style={s.mono} selectable>
        {text}
      </Text>
    </ScrollView>
  )
}

function PermissionPrompt({
  prompt,
  autoModeAvailable,
  cwd,
  agentName,
  busy,
  answer,
  s
}: {
  prompt: ChatPrompt
  autoModeAvailable: boolean
  cwd: string
  agentName: string | null
  busy: boolean
  answer: PromptAnswer
  s: Styles
}) {
  const view = buildPermissionView(prompt.request, { autoModeAvailable, cwd, agentName })
  // The row whose typed feedback is being written (amend / WebFetch's No).
  const [amendFor, setAmendFor] = useState<string | null>(null)
  const choose = (index: number): void => {
    const option = view.options[index]
    if (!option || busy) return
    if (option.needsFeedback || !option.decision) {
      setAmendFor(option.id)
      return
    }
    void answer(option.id, option.decision)
  }
  return (
    <View>
      <Text style={s.title}>
        {view.title}
        {view.agentLabel ? <Text style={s.muted}> {view.agentLabel}</Text> : null}
      </Text>
      {view.subtitle ? <Text style={s.muted}>{view.subtitle}</Text> : null}
      <ToolPreview prompt={prompt} s={s} />
      {view.decisionReason ? <Text style={s.muted}>{view.decisionReason}</Text> : null}
      {view.tip ? <Text style={s.muted}>{view.tip}</Text> : null}
      <Text style={s.question}>{view.question}</Text>
      <Rows options={view.options} busy={busy} onChoose={choose} s={s} />
      {view.canAmend && !amendFor && (
        <Pressable
          onPress={() => setAmendFor('no-feedback')}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={s.link}>No, and tell Claude what to do differently</Text>
        </Pressable>
      )}
      {amendFor && (
        <Feedback
          placeholder="No, and tell Claude what to do differently"
          busy={busy}
          onCancel={() => setAmendFor(null)}
          onSubmit={(text) =>
            void answer(
              amendFor,
              text ? feedbackDenial(text) : { behavior: 'deny', message: REJECT_MESSAGE }
            )
          }
          s={s}
        />
      )}
    </View>
  )
}

function QuestionPrompt({
  prompt,
  busy,
  answer,
  s
}: {
  prompt: ChatPrompt
  busy: boolean
  answer: PromptAnswer
  s: Styles
}) {
  const questions = questionsOf(prompt.input) as Array<{
    question: string
    header?: string
    multiSelect?: boolean
    options: Array<{ label: string; description?: string }>
  }>
  const [picked, setPicked] = useState<Map<number, string[]>>(() => new Map())
  const [other, setOther] = useState<Map<number, string>>(() => new Map())

  const pick = (qi: number, label: string, multi: boolean): void => {
    if (busy) return
    setOther((prev) => {
      if (!prev.has(qi)) return prev
      const next = new Map(prev)
      next.delete(qi)
      return next
    })
    setPicked((prev) => {
      const cur = prev.get(qi) ?? []
      const next = new Map(prev)
      next.set(
        qi,
        multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
      )
      return next
    })
  }
  const answerOf = (qi: number): string =>
    other.has(qi) ? (other.get(qi) ?? '').trim() : (picked.get(qi) ?? []).join(', ')
  const answers = (): Record<string, string> => {
    const out: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const a = answerOf(qi)
      if (a) out[q.question] = a
    })
    return out
  }
  const complete = questions.length > 0 && questions.every((_q, qi) => answerOf(qi).length > 0)

  if (questions.length === 0) return <Text style={s.muted}>No questions provided.</Text>
  return (
    <View>
      {questions.map((q, qi) => {
        const sel = picked.get(qi) ?? []
        const typing = other.has(qi)
        return (
          <View key={q.question} style={s.questionBlock}>
            {q.header ? <Text style={s.header}>{q.header}</Text> : null}
            <Text style={s.question}>{q.question}</Text>
            {q.options.map((o) => {
              const on = sel.includes(o.label)
              return (
                <Pressable
                  key={o.label}
                  disabled={busy}
                  onPress={() => pick(qi, o.label, q.multiSelect === true)}
                  style={[s.option, on && s.optionOn]}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: on, disabled: busy }}
                >
                  <Text style={s.rowLabel}>{o.label}</Text>
                  {o.description ? <Text style={s.muted}>{o.description}</Text> : null}
                </Pressable>
              )
            })}
            <Pressable
              disabled={busy}
              onPress={() => {
                setOther((prev) => new Map(prev).set(qi, prev.get(qi) ?? ''))
                setPicked((prev) => new Map(prev).set(qi, []))
              }}
              style={[s.option, typing && s.optionOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: typing, disabled: busy }}
            >
              <Text style={s.rowLabel}>Type something</Text>
            </Pressable>
            {typing && (
              <TextInput
                autoFocus
                value={other.get(qi) ?? ''}
                onChangeText={(v) => setOther((prev) => new Map(prev).set(qi, v))}
                placeholder="Type something…"
                accessibilityLabel={`Your answer to: ${q.question}`}
                multiline
                editable={!busy}
                style={s.input}
              />
            )}
          </View>
        )
      })}
      <View style={s.actions}>
        <Action
          label="Chat about this"
          busy={busy}
          onPress={() => void answer('clarify', clarifyDecision(questions, answers(), {}))}
          s={s}
        />
        <Action
          label="Cancel"
          busy={busy}
          onPress={() => void answer('decline', declineQuestionDecision())}
          s={s}
        />
        <Action
          label="Submit"
          busy={busy}
          disabled={!complete}
          primary
          onPress={() => void answer('answer', questionAnswerDecision(prompt.input, answers(), {}))}
          s={s}
        />
      </View>
    </View>
  )
}

function PlanPrompt({
  autoModeAvailable,
  busy,
  answer,
  sendMessage,
  s
}: {
  autoModeAvailable: boolean
  busy: boolean
  answer: PromptAnswer
  sendMessage: (text: string) => void
  s: Styles
}) {
  const options = buildPlanOptions({ autoModeAvailable })
  const [writing, setWriting] = useState(false)
  const choose = (index: number): void => {
    const option = options[index]
    if (!option || busy) return
    if (option.needsFeedback || !option.decision) {
      setWriting(true)
      return
    }
    void answer(option.id, option.decision)
  }
  const approve = options[0]
  return (
    <View>
      <Text style={s.title}>Ready to code?</Text>
      <Text style={s.muted}>Here is Claude's plan: see the plan card above.</Text>
      <Text style={s.question}>
        Claude has written up a plan and is ready to execute. Would you like to proceed?
      </Text>
      <Rows options={options} busy={busy} onChoose={choose} s={s} />
      {writing && (
        <PlanFeedback
          busy={busy}
          onKeepPlanning={(text) => void answer('plan-feedback', feedbackDenial(text))}
          onApproveWith={(text) => {
            if (!approve.decision) return
            void answer(approve.id, approve.decision).then((ok) => {
              if (ok) sendMessage(text)
            })
          }}
          onCancel={() => setWriting(false)}
          s={s}
        />
      )}
    </View>
  )
}

function PlanFeedback({
  busy,
  onKeepPlanning,
  onApproveWith,
  onCancel,
  s
}: {
  busy: boolean
  onKeepPlanning: (text: string) => void
  onApproveWith: (text: string) => void
  onCancel: () => void
  s: Styles
}) {
  const [text, setText] = useState('')
  const t = text.trim()
  return (
    <View style={s.feedback}>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        placeholder="Tell Claude what to change"
        accessibilityLabel="Tell Claude what to change"
        multiline
        editable={!busy}
        style={s.input}
      />
      <View style={s.actions}>
        <Action label="Back" busy={busy} onPress={onCancel} s={s} />
        <Action
          label="Approve with this"
          busy={busy}
          disabled={!t}
          onPress={() => onApproveWith(t)}
          s={s}
        />
        <Action
          label="Keep planning"
          busy={busy}
          disabled={!t}
          primary
          onPress={() => onKeepPlanning(t)}
          s={s}
        />
      </View>
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    dock: {
      marginHorizontal: 8,
      marginBottom: 6,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.info,
      backgroundColor: t.card,
      maxHeight: 420
    },
    dockHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingTop: 8
    },
    dockTitle: { color: t.infoForeground, fontSize: 12, fontWeight: '600' },
    dockCount: { color: t.mutedForeground, fontSize: 12 },
    dockBody: { paddingHorizontal: 12, paddingVertical: 8 },
    title: { color: t.foreground, fontSize: 15, fontWeight: '700', marginBottom: 2 },
    header: {
      color: t.infoForeground,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase'
    },
    muted: { color: t.mutedForeground, fontSize: 13 },
    question: {
      color: t.foreground,
      fontSize: 14,
      fontWeight: '600',
      marginTop: 6,
      marginBottom: 6
    },
    questionBlock: { marginBottom: 10 },
    preview: {
      maxHeight: 160,
      marginTop: 6,
      padding: 8,
      borderRadius: 6,
      backgroundColor: t.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: t.foreground },
    rows: { gap: 6 },
    row: {
      flexDirection: 'row',
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface2
    },
    rowPressed: { backgroundColor: t.accent },
    rowNumber: { color: t.mutedForeground, fontSize: 14 },
    rowLabel: { color: t.foreground, fontSize: 14, flexShrink: 1 },
    option: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      marginBottom: 6
    },
    optionOn: { borderColor: t.info, backgroundColor: t.surface2 },
    disabled: { opacity: 0.5 },
    link: { color: t.infoForeground, fontSize: 14, marginTop: 10 },
    feedback: { marginTop: 8 },
    input: {
      minHeight: 40,
      maxHeight: 120,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.input,
      color: t.foreground,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 15
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 8
    },
    action: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    actionPrimary: { backgroundColor: t.primary, borderColor: t.primary },
    actionText: { color: t.foreground, fontSize: 14, fontWeight: '600' },
    actionTextPrimary: { color: t.primaryForeground }
  })
}
