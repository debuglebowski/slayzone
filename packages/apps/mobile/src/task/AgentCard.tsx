/**
 * The phone task page's agent card — the status island opened: a glass card from the
 * top over the dimmed page, with everything about the agent and the task in one place
 * (the page has no other menu):
 *
 * - the agent: its provider and state ("Idle · Unread");
 * - a chat's controls as tiles: model, permission mode, effort (and Codex's
 *   collaboration mode), each opening its choices;
 * - what can be done with it: Start / Interrupt / Stop / Restart / New conversation
 *   (destructive ones ask first, as in `AgentPanel`), and Provider, which folds out the
 *   providers to switch to;
 * - a terminal's text: copy, share, text size;
 * - the task: keep a temporary task, mark unread, archive, delete (`useTaskMenuItems`).
 *
 * Tapping outside or Done closes it; an action closes it, then runs.
 */
import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentNav } from '../agents/AgentPanel'
import { ChatControls } from '../chat/ChatControls'
import { SCRIM, type ChromeColors, useTheme, useThemeVariant } from '../theme'
import { MODAL_ORIENTATIONS } from '../ui-kit/Chrome'
import { Glass } from '../ui-kit/Glass'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import type { TaskMenuItem } from './task-parts'

export function AgentCard({
  visible,
  agent,
  taskItems,
  onClose
}: {
  visible: boolean
  agent: AgentNav
  /** The task's actions (`useTaskMenuItems`). */
  taskItems: readonly TaskMenuItem[]
  onClose: () => void
}) {
  const theme = useTheme()
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const insets = useSafeAreaInsets()
  const [providers, setProviders] = useState(false)
  const close = () => {
    setProviders(false)
    onClose()
  }
  const then = (run: () => void) => () => {
    close()
    run()
  }
  const lifecycle = agent.actions.filter((a) => a.kind === 'lifecycle')
  const terminal = agent.actions.filter((a) => a.kind === 'terminal')
  const disabled = agent.busy
  const providerLabel = agent.providers.find((p) => p.id === agent.providerId)?.label

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      supportedOrientations={MODAL_ORIENTATIONS}
    >
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM[variant] }]}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close the agent card"
        testID="agent-card-scrim"
      />
      <Glass style={[styles.card, { marginTop: insets.top + 4 }]} testID="agent-card">
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          accessibilityViewIsModal
        >
          <View style={styles.head}>
            {agent.dot ? <AgentDot kind={agent.dot} size={10} /> : <View style={styles.noDot} />}
            <View style={styles.headText}>
              <Text style={styles.provider} numberOfLines={1} testID="agent-card-provider">
                {agent.provider}
              </Text>
              <Text style={styles.status} numberOfLines={2} testID="agent-card-status">
                {agent.waiting ? `Needs you · ${agent.status}` : agent.status}
              </Text>
            </View>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Done"
              hitSlop={8}
              style={styles.done}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>

          {agent.controls ? (
            <ChatControls
              mode={agent.controls.mode}
              settings={agent.controls.settings}
              models={agent.controls.models}
              variant="tiles"
            />
          ) : null}

          <View style={styles.actions}>
            {lifecycle.map((a) => (
              <Pressable
                key={a.name}
                onPress={then(a.onPress)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                accessibilityState={{ disabled }}
                style={({ pressed }) => [styles.action, (pressed || disabled) && styles.dim]}
              >
                <Text
                  style={[styles.actionText, a.destructive && styles.destructive]}
                  numberOfLines={2}
                  maxFontSizeMultiplier={1.3}
                >
                  {a.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setProviders((v) => !v)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Provider"
              accessibilityValue={providerLabel ? { text: providerLabel } : undefined}
              accessibilityState={{ disabled, expanded: providers }}
              style={({ pressed }) => [styles.action, (pressed || disabled) && styles.dim]}
            >
              <Text style={styles.actionText} numberOfLines={1}>
                Provider
              </Text>
              {providerLabel ? (
                <Text style={styles.actionValue} numberOfLines={2}>
                  {providerLabel}
                </Text>
              ) : null}
            </Pressable>
          </View>
          {providers ? (
            <View style={styles.list} testID="agent-card-providers">
              {agent.providers.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={then(() => agent.switchProvider(p.id))}
                  accessibilityRole="button"
                  accessibilityLabel={p.label}
                  accessibilityState={{ selected: p.id === agent.providerId }}
                  style={styles.row}
                >
                  <Text style={styles.rowText}>{p.label}</Text>
                  {p.id === agent.providerId ? <Text style={styles.rowText}>✓</Text> : null}
                </Pressable>
              ))}
            </View>
          ) : null}

          {terminal.length > 0 ? (
            <View style={styles.list}>
              <Text style={styles.section}>Terminal</Text>
              {terminal.map((a) => (
                <Pressable
                  key={a.name}
                  onPress={then(a.onPress)}
                  accessibilityRole="button"
                  style={styles.row}
                >
                  <Text style={styles.rowText}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.list}>
            <Text style={styles.section}>Task</Text>
            {taskItems.map((item) => (
              <Pressable
                key={item.label}
                onPress={then(item.onPress)}
                accessibilityRole="button"
                style={styles.row}
              >
                <Text style={[styles.rowText, item.destructive && styles.destructive]}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </Glass>
    </Modal>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    card: {
      marginHorizontal: 12,
      maxHeight: '80%',
      borderRadius: 30,
      overflow: 'hidden'
    },
    scroll: { flexGrow: 0 },
    content: { padding: 14, gap: 12 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    noDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.muted },
    headText: { flex: 1 },
    provider: { fontSize: 17, fontWeight: '700', color: t.foreground },
    status: { fontSize: 13, color: t.mutedForeground },
    done: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
    doneText: { fontSize: 16, fontWeight: '600', color: t.primary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    action: {
      flexGrow: 1,
      flexBasis: 96,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
      paddingVertical: 8,
      borderRadius: 16,
      backgroundColor: t.surface2
    },
    dim: { opacity: 0.6 },
    actionText: { fontSize: 13, fontWeight: '600', color: t.foreground, textAlign: 'center' },
    actionValue: { fontSize: 11, color: t.mutedForeground },
    destructive: { color: t.destructive },
    list: { borderRadius: 16, backgroundColor: t.surface2, paddingHorizontal: 12 },
    section: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: t.mutedForeground,
      paddingTop: 10,
      paddingBottom: 2
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 44,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    rowText: { fontSize: 15, color: t.foreground }
  })
