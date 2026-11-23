/**
 * A terminal agent's session on the phone: its live output in the terminal (xterm.js
 * in a web view, `TerminalDom`), and the phone's way to type into it — a key bar
 * (Esc, Ctrl, Tab, arrows, Enter, digits) and a text field. Must sit inside the
 * session's hub's `HubScope`.
 *
 * - Output: `TerminalFeed` (subscribe → attach → dedupe → catch up), started once the
 *   data subscription runs AND the web view's terminal exists; a reloaded web view
 *   gets the session replayed. Rendered at the session's size, never resized; the
 *   text size (readable — wider sessions pan — or fit to width) is the user's, kept on
 *   this device (`terminal-prefs.ts`; a double tap in the terminal switches it too).
 * - Says what an empty terminal means: connecting, the agent not running (nothing
 *   written), the computer offline (output resumes when it is back), or a failed load
 *   (with Retry).
 * - Input: key bar → `pty.write` (Esc and Ctrl+C also `pty.interrupt`, as desktop),
 *   and so does a touch scroll the program takes (wheel / arrow bytes from the view) —
 *   all through the controller's ordered writer; text → `pty.submit` (the agent's own
 *   submit, which knows its Enter), an empty send presses Enter. OSC strings are
 *   stripped from typed text, as desktop strips them from its terminal's input.
 *   Ctrl is sticky: tapped, the next character typed goes as Ctrl+it. Arrows repeat
 *   while held.
 * - Keyboard: the key bar and the field ride above it (`KeyboardAvoidingView`; the web
 *   view refits to the smaller area and keeps its newest line in view). Return sends
 *   and keeps the keyboard up, and the terminal is a web view (a touch there does not
 *   blur the field), so closing it is explicit: the Hide button beside Send while
 *   typing, or touching the terminal.
 * - A tapped web link opens in the browser; the screen's or all the output's text can
 *   be shared (iOS's share sheet has Copy) — `TerminalViewHandle`.
 * - Presence: `pty.touch` when opened and, at most every 4s (desktop's throttle), on
 *   interaction — the idle-close timer must not put an agent the user is watching
 *   to sleep.
 * - Direct link (docs/direct-link.md): while the session's computer is reachable
 *   from the phone, output, catch-up and key-bar bytes go straight to it and the hub
 *   stops relaying this session; each switch catches up gap-free (`TerminalFeed`).
 *   Submit, interrupt and touch stay hub calls.
 */
import { ENTER, stripOscReplies } from '@slayzone/terminal-contracts'
import { useDirectLease, useSubscription } from '@slayzone/transport/client'
import { type ComponentRef, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { openWebLink } from '../chat/Markdown'
import { useKeyboardOverlap } from '../chat/use-keyboard'
import { copyText, shareText } from '../chat/message-text'
import { type ChromeColors, useTerminalColors, useTheme, useThemeVariant } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { type BarKey, ctrlChar, KEY_BAR, type KeyModes, KeyRepeater, keyBytes } from './key-bar'
import TerminalDom, { type TerminalDomHandle } from './TerminalDom'
import { TerminalController } from './terminal-controller'
import type { FeedStatus } from './terminal-feed'
import { terminalPrefsFile } from './terminal-prefs-file'
import { phoneGrid, type TextSize } from './terminal-scale'
import { useNativeMounted } from './use-native-mounted'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Chrome glyphs and labels grow with Dynamic Type, but not past what the bar holds. */
const MAX_CHROME_SCALE = 1.4

/** What the agent panel does with the terminal (its ⋯ menu, its Start). */
export interface TerminalViewHandle {
  /**
   * The grid a terminal the phone starts should have: this terminal's area at the
   * readable font (keyboard closed). Undefined until it was measured.
   */
  grid(): { cols: number; rows: number } | undefined
  /** Copy or share the screen's (`screen`) or all the output's (`all`) text. */
  exportText(kind: 'screen' | 'all', how: 'copy' | 'share'): void
  /** The text size shown (and kept on this device). */
  textSize(): TextSize
  toggleTextSize(): void
}

export function TerminalView({
  sessionId,
  taskId,
  live,
  computerName,
  notRunningHint,
  stateLoading = false,
  onHandle
}: {
  sessionId: string
  /** The task the session belongs to: the direct link's computer target. */
  taskId: string
  live: boolean
  /** The name of the computer the task runs on, for "<name> is offline". */
  computerName?: string | null
  /** What to do about an agent that is not running (after "The agent isn't running."). */
  notRunningHint?: string
  /** The hub's agent states are not in yet: `live` false means "not known", not "stopped". */
  stateLoading?: boolean
  /**
   * Given the terminal's handle (null when it goes) — the panel's way to act on it
   * from its handlers. A prop rather than a `ref`: the holder reads it in handlers only.
   */
  onHandle?: (handle: TerminalViewHandle | null) => void
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const theme = useTheme()
  const variant = useThemeVariant()
  const colors = useTerminalColors()
  const styles = makeStyles(theme)
  const [modes, setModes] = useState<KeyModes>({ applicationCursorKeys: false })
  const [status, setStatus] = useState<FeedStatus>({
    phase: 'attaching',
    exists: false,
    error: null,
    output: false
  })
  const [text, setText] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [textSize, setTextSize] = useState<TextSize>(() => terminalPrefsFile.load().textSize)
  const [repeater] = useState(() => new KeyRepeater())
  useEffect(() => () => repeater.release(), [repeater])

  const terminal = useRef<TerminalDomHandle>(null)
  // The web view mounts one render later (`useNativeMounted`: expo's mount-time call
  // into it must not run before its native view exists).
  const webMounted = useNativeMounted()
  const controller = useMemo(
    () => new TerminalController(sessionId, client, setStatus),
    [client, sessionId]
  )
  useEffect(() => {
    controller.attachTerminal(terminal)
    return () => controller.dispose()
  }, [controller])

  // The direct link to the session's computer, when reachable; `live` wakes it (the
  // hub can only issue for a running session).
  const { lease: direct, lost: directLost } = useDirectLease(
    client,
    { kind: 'pty', sessionId, taskId },
    live
  )
  useEffect(() => {
    controller.setDirect(direct?.client ?? null, directLost)
    if (!direct) return
    const sub = direct.client.pty.onData.subscribe(
      { sessionId },
      {
        onStarted: () => controller.subscriptionStarted(),
        onData: (event) => controller.feed.data(event.seq, event.data),
        // The grant ended or the process exited: back to the hub relay.
        onError: directLost,
        onComplete: directLost
      }
    )
    return () => sub.unsubscribe()
  }, [controller, direct, directLost, sessionId])

  // The hub relays this session only while it is not on the direct link.
  useSubscription(
    trpc.pty.onData.subscriptionOptions(
      { sessionIds: [sessionId] },
      {
        enabled: !direct,
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
  // The session's computer went offline / came back: its output lives there.
  useSubscription(
    trpc.pty.onOutputAvailability.subscriptionOptions(undefined, {
      onData: (event) => {
        if (event.sessionId === sessionId) void controller.feed.computerAvailable(event.available)
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
    write()
      .then((accepted) => {
        if (accepted === false) throw new Error('The terminal could not accept input')
      })
      .catch((error: unknown) => {
        setSendError(messageOf(error))
        if (restore) setText((current) => (current ? `${restore}\n${current}` : restore))
      })
  }

  /** Bytes for the agent, in the order typed (key bar, Ctrl+letter, touch scroll). */
  const write = (data: string): void => {
    if (!live) return
    touch()
    send(() => controller.write(data))
  }

  const press = (key: BarKey): void => {
    if (!live) return
    if (key.modifier) {
      setCtrlArmed((armed) => !armed)
      return
    }
    setCtrlArmed(false)
    touch()
    const data = keyBytes(key, modes)
    send(async () => {
      if (!(await controller.write(data))) return false
      if (key.interrupts) await client.pty.interrupt.mutate({ sessionId })
    })
  }

  const changeText = (next: string): void => {
    if (ctrlArmed) {
      setCtrlArmed(false)
      // One character typed after Ctrl: it goes as Ctrl+it, not into the field.
      if (next.length === text.length + 1 && next.startsWith(text)) {
        const bytes = ctrlChar(next.slice(-1))
        if (bytes !== null) {
          write(bytes)
          return
        }
      }
    }
    setText(next)
  }

  const submit = (): void => {
    if (!live) return
    touch()
    const value = stripOscReplies(text)
    setText('')
    if (value.length > 0) send(() => client.pty.submit.mutate({ sessionId, text: value }), text)
    else send(() => controller.write(ENTER))
  }

  const keepTextSize = (size: TextSize): void => {
    setTextSize(size)
    terminalPrefsFile.save({ textSize: size })
  }

  // The area the terminal had with the keyboard closed: what a phone-started agent's
  // grid is sized to (`grid`).
  const area = useRef<{ width: number; height: number } | null>(null)
  const measureArea = (event: LayoutChangeEvent): void => {
    if (Keyboard.isVisible()) return
    const { width, height } = event.nativeEvent.layout
    area.current = { width, height }
  }

  useEffect(() => {
    if (!onHandle) return
    onHandle({
      grid: () => {
        const measured = area.current
        return (measured && phoneGrid(measured.width, measured.height)) ?? undefined
      },
      exportText: (kind, how) => {
        textAction.current = how
        terminal.current?.requestText(kind)
      },
      textSize: () => textSize,
      toggleTextSize: () => keepTextSize(textSize === 'readable' ? 'fit' : 'readable')
    })
    return () => onHandle(null)
  })

  // What the text the terminal sends back is for (set by `exportText`, in a handler).
  const textAction = useRef<'copy' | 'share'>('share')
  const exportTextNow = async (text: string): Promise<void> => {
    if (text.trim().length === 0) return
    if (textAction.current === 'copy') copyText(text)
    else shareText(text)
  }

  const rootRef = useRef<ComponentRef<typeof View>>(null)
  const keyboard = useKeyboardOverlap(rootRef)
  // Short windows keep the shortcuts beside the composer so output stays visible.
  const inlineKeys = keyboard.bottom > 0 && (keyboard.availableHeight ?? Infinity) < 144

  let overlay = null
  if (status.phase === 'attaching') {
    overlay = (
      <View style={styles.overlay} accessible accessibilityLabel="Connecting to the agent">
        <ActivityIndicator color={colors.foreground} />
      </View>
    )
  } else if (status.phase === 'error') {
    overlay = (
      <View style={styles.overlay}>
        <Text style={styles.overlayTitle}>Couldn’t load the agent’s output.</Text>
        {status.error ? (
          <Text style={styles.overlayDetail} numberOfLines={3}>
            {status.error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading the output"
          onPress={() => controller.retry()}
          style={({ pressed }) => [styles.retry, pressed && styles.keyPressed]}
        >
          <Text style={styles.retryText} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
            Retry
          </Text>
        </Pressable>
      </View>
    )
  } else if (status.phase === 'offline') {
    overlay = (
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.overlayTitle} accessibilityLiveRegion="polite">
          {computerName
            ? `${computerName} is offline. Its output resumes when it’s back.`
            : 'The computer running this agent is offline. Its output resumes when it’s back.'}
        </Text>
      </View>
    )
  } else if (!live && !stateLoading && !status.output) {
    overlay = (
      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.overlayTitle}>
          {notRunningHint
            ? `The agent isn’t running. ${notRunningHint}`
            : 'The agent isn’t running.'}
        </Text>
      </View>
    )
  }

  return (
    <View
      ref={rootRef}
      onLayout={keyboard.onLayout}
      style={[styles.root, { paddingBottom: keyboard.bottom }]}
      testID="terminal-view"
    >
      <View
        style={[styles.terminal, { backgroundColor: colors.background }]}
        onLayout={measureArea}
        testID="terminal-area"
      >
        {webMounted ? (
          <TerminalDom
            ref={terminal}
            colors={colors}
            textSize={textSize}
            onReady={() => controller.terminalReady()}
            onModes={async (applicationCursorKeys) => setModes({ applicationCursorKeys })}
            onInteract={async () => {
              Keyboard.dismiss()
              touch()
            }}
            onInput={async (data) => write(data)}
            onOpenLink={async (url) => openWebLink(url)}
            onTextSize={async (size) => keepTextSize(size)}
            onText={exportTextNow}
            dom={{ style: styles.web, scrollEnabled: false, bounces: false }}
          />
        ) : null}
        {overlay}
      </View>
      {sendError ? <Text style={styles.problem}>Not sent: {sendError}</Text> : null}
      <View testID="terminal-controls" style={inlineKeys ? styles.inlineControls : undefined}>
        <ScrollView
          testID="terminal-shortcuts"
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={[styles.keys, inlineKeys && styles.inlineKeys]}
          contentContainerStyle={[styles.keysContent, inlineKeys && styles.inlineKeysContent]}
        >
          {KEY_BAR.map((key) => {
            const armed = key.modifier === true && ctrlArmed
            return (
              <Pressable
                key={key.id}
                accessibilityRole="button"
                accessibilityLabel={key.accessibilityLabel}
                accessibilityState={{ disabled: !live, selected: armed }}
                disabled={!live}
                onPress={key.repeats ? undefined : () => press(key)}
                onPressIn={key.repeats ? () => repeater.press(() => press(key)) : undefined}
                onPressOut={key.repeats ? () => repeater.release() : undefined}
                style={({ pressed }) => [
                  styles.key,
                  inlineKeys && styles.inlineKey,
                  (pressed || armed) && styles.keyPressed
                ]}
              >
                <Text
                  style={[styles.keyLabel, !live && styles.disabled]}
                  maxFontSizeMultiplier={MAX_CHROME_SCALE}
                >
                  {key.label}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
        <View style={[styles.inputRow, inlineKeys && styles.inlineInputRow]}>
          <TextInput
            accessibilityLabel="Message to the agent"
            style={[styles.input, inlineKeys && styles.inlineInput]}
            value={text}
            onChangeText={changeText}
            onSubmitEditing={submit}
            editable={live}
            placeholder={live ? (ctrlArmed ? 'Ctrl + a letter' : 'Message') : 'Not running'}
            placeholderTextColor={theme.mutedForeground}
            multiline
            submitBehavior="submit"
            returnKeyType="send"
            autoCapitalize="sentences"
            autoCorrect
            spellCheck
            keyboardAppearance={variant}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
          />
          {typing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hide keyboard"
              onPress={() => Keyboard.dismiss()}
              style={styles.textButton}
            >
              <Text style={styles.hide} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
                Hide
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={submit}
            style={styles.textButton}
          >
            <Text
              style={[styles.send, !live && styles.disabled]}
              maxFontSizeMultiplier={MAX_CHROME_SCALE}
            >
              Send
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    terminal: { flex: 1 },
    web: { flex: 1 },
    overlay: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: 24
    },
    overlayTitle: { color: t.foreground, fontSize: 15, textAlign: 'center' },
    overlayDetail: { color: t.mutedForeground, fontSize: 12, textAlign: 'center' },
    retry: {
      minHeight: 44,
      minWidth: 88,
      paddingHorizontal: 16,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.muted
    },
    retryText: { fontSize: 15, fontWeight: '600', color: t.foreground },
    problem: { color: t.destructive, fontSize: 12, paddingHorizontal: 12, paddingVertical: 4 },
    keys: {
      flexGrow: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.surface1
    },
    inlineControls: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface1 },
    inlineKeys: { width: '33%', flexShrink: 0, borderTopWidth: 0 },
    inlineKeysContent: { alignItems: 'center', paddingVertical: 2 },
    inlineKey: { minHeight: 36 },
    keysContent: { paddingHorizontal: 8, paddingVertical: 4, gap: 6 },
    key: {
      minWidth: 44,
      minHeight: 44,
      paddingHorizontal: 10,
      borderRadius: 6,
      backgroundColor: t.muted,
      alignItems: 'center',
      justifyContent: 'center'
    },
    keyPressed: { backgroundColor: t.accent },
    keyLabel: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    disabled: { color: t.mutedForeground },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: t.surface1
    },
    inlineInputRow: { flex: 1, minWidth: 0, paddingVertical: 0, paddingHorizontal: 6 },
    inlineInput: { minWidth: 0, minHeight: 36, maxHeight: 44, paddingTop: 4, paddingBottom: 4 },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      fontSize: 15,
      color: t.foreground,
      backgroundColor: t.background,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 10,
      paddingTop: 10,
      paddingBottom: 10,
      textAlignVertical: 'top'
    },
    textButton: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 6,
      alignItems: 'center',
      justifyContent: 'center'
    },
    hide: { fontSize: 15, color: t.mutedForeground },
    send: { fontSize: 15, fontWeight: '600', color: t.foreground }
  })
