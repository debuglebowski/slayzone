/**
 * A terminal agent's session on the phone: its live output in the terminal (xterm.js
 * in a web view, `TerminalDom`), and the phone's way to type into it — a key bar
 * (Esc, Ctrl, Tab, arrows, Enter, digits) and a text field. Must sit inside the
 * session's hub's `HubScope`.
 *
 * - Output: `TerminalFeed` (subscribe → attach → dedupe → catch up), started once the
 *   data subscription runs AND the web view's terminal exists; a reloaded web view
 *   gets the session replayed. Rendered at the session's size, never resized.
 * - Input: key bar → `pty.write` (Esc and Ctrl+C also `pty.interrupt`, as desktop);
 *   text → `pty.submit` (the agent's own submit, which knows its Enter), an empty
 *   send presses Enter. OSC strings are stripped from typed text, as desktop strips
 *   them from its terminal's input.
 * - Presence: `pty.touch` when opened and, at most every 4s (desktop's throttle), on
 *   interaction — the idle-close timer must not put an agent the user is watching
 *   to sleep.
 */
import { ENTER, stripOscReplies } from '@slayzone/terminal-contracts'
import { useSubscription } from '@slayzone/transport/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { type ChromeColors, useTerminalColors, useTheme } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { type BarKey, KEY_BAR, type KeyModes, keyBytes } from './key-bar'
import TerminalDom, { type TerminalDomHandle } from './TerminalDom'
import { TerminalController } from './terminal-controller'
import type { FeedStatus } from './terminal-feed'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function TerminalView({ sessionId, live }: { sessionId: string; live: boolean }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const theme = useTheme()
  const colors = useTerminalColors()
  const styles = makeStyles(theme)
  const [modes, setModes] = useState<KeyModes>({ applicationCursorKeys: false })
  const [status, setStatus] = useState<FeedStatus>({
    phase: 'attaching',
    exists: false,
    error: null
  })
  const [text, setText] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)

  const terminal = useRef<TerminalDomHandle>(null)
  const controller = useMemo(
    () => new TerminalController(sessionId, client, setStatus),
    [client, sessionId]
  )
  useEffect(() => {
    controller.attachTerminal(terminal)
    return () => controller.dispose()
  }, [controller])

  useSubscription(
    trpc.pty.onData.subscriptionOptions(
      { sessionIds: [sessionId] },
      {
        onStarted: () => controller.subscriptionStarted(),
        onData: (event) => {
          if (event.sessionId === sessionId) controller.feed.data(event.seq, event.data)
        }
      }
    )
  )
  useSubscription(
    trpc.pty.onResize.subscriptionOptions(undefined, {
      onData: (event) => {
        if (event.sessionId === sessionId) controller.feed.resize(event.cols, event.rows)
      }
    })
  )

  // Opened (or the agent came up while open): the user is here.
  useEffect(() => {
    if (live) controller.touch(true)
  }, [live, controller])
  const touch = (): void => {
    if (live) controller.touch(false)
  }

  const send = (write: () => Promise<unknown>, restore?: string): void => {
    setSendError(null)
    write().catch((error: unknown) => {
      setSendError(messageOf(error))
      if (restore) setText(restore)
    })
  }

  const press = (key: BarKey): void => {
    if (!live) return
    touch()
    const data = keyBytes(key, modes)
    send(async () => {
      await client.pty.write.mutate({ sessionId, data })
      if (key.interrupts) await client.pty.interrupt.mutate({ sessionId })
    })
  }

  const submit = (): void => {
    if (!live) return
    touch()
    const value = stripOscReplies(text)
    setText('')
    if (value.length > 0) send(() => client.pty.submit.mutate({ sessionId, text: value }), value)
    else send(() => client.pty.write.mutate({ sessionId, data: ENTER }))
  }

  return (
    <View style={styles.root}>
      <View style={[styles.terminal, { backgroundColor: colors.background }]}>
        <TerminalDom
          ref={terminal}
          colors={colors}
          onReady={() => controller.terminalReady()}
          onModes={async (applicationCursorKeys) => setModes({ applicationCursorKeys })}
          onInteract={async () => touch()}
          dom={{ style: styles.web, scrollEnabled: false, bounces: false }}
        />
        {status.phase === 'error' ? (
          <Text style={styles.problem} numberOfLines={2}>
            {status.error}
          </Text>
        ) : null}
      </View>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.keys}
        contentContainerStyle={styles.keysContent}
      >
        {KEY_BAR.map((key) => (
          <Pressable
            key={key.id}
            accessibilityRole="button"
            accessibilityLabel={key.accessibilityLabel}
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={() => press(key)}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          >
            <Text style={[styles.keyLabel, !live && styles.disabled]}>{key.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {sendError ? <Text style={styles.problem}>Not sent: {sendError}</Text> : null}
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel="Message to the agent"
          style={styles.input}
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          editable={live}
          placeholder={live ? 'Message' : 'Not running'}
          placeholderTextColor={theme.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          blurOnSubmit={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !live }}
          disabled={!live}
          onPress={submit}
          hitSlop={8}
        >
          <Text style={[styles.send, !live && styles.disabled]}>Send</Text>
        </Pressable>
      </View>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    terminal: { flex: 1 },
    web: { flex: 1 },
    problem: { color: t.destructive, fontSize: 12, paddingHorizontal: 12, paddingVertical: 4 },
    keys: {
      flexGrow: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.surface1
    },
    keysContent: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
    key: {
      minWidth: 40,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: t.muted,
      alignItems: 'center'
    },
    keyPressed: { backgroundColor: t.accent },
    keyLabel: { fontSize: 14, color: t.foreground, fontWeight: '500' },
    disabled: { color: t.mutedForeground },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: t.surface1
    },
    input: {
      flex: 1,
      fontSize: 15,
      color: t.foreground,
      backgroundColor: t.background,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 10,
      paddingVertical: 8
    },
    send: { fontSize: 15, fontWeight: '600', color: t.foreground }
  })
