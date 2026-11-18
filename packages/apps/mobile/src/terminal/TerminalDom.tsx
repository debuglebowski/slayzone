'use dom'

/**
 * The terminal itself: xterm.js — the terminal library desktop uses — in a web view
 * (an Expo DOM component: this file runs with React DOM inside `@expo/dom-webview`;
 * the app renders it like a native component). The rules live in `xterm-view.ts`;
 * this file wires them to the browser: the element, touch gestures, window size.
 *
 * Native → web: the imperative handle (`write`, `reset`, `resize`, `requestText`), one
 * injected script per call (`dom-sink.ts` batches them per frame) — output never goes
 * through props, which are re-sent whole on every change. The text size the user keeps
 * is a prop (`textSize`).
 * Web → native: `onReady` once this terminal exists (again after the web view
 * reloads: the native side then replays the session), `onModes` when the cursor-key
 * mode changes, `onInteract` on a touch (keeps the agent from idle-closing), `onInput`
 * with the bytes a touch scroll sends the program, `onOpenLink` with the web link a
 * tap landed on, `onTextSize` when a double tap switched the text size, `onText` with
 * the text `requestText` asked for.
 *
 * Taps (`tap-gesture.ts`): a short touch that stays put. A double tap toggles the text
 * size; a single tap on a link opens it — once no second tap followed.
 *
 * The newest line stays in view: while the view is scrolled to its end, a font or
 * size change (a zoom, the keyboard opening) keeps it there.
 *
 * Touch scroll: xterm handles a drag itself (document-level listeners) — fine for
 * its scrollback, but a drag the PROGRAM takes (mouse wheel, alternate screen) xterm
 * turns into input that read-only drops. Such a drag is kept from xterm (stopped at
 * this element) and scrolled here (`XtermView.touchScrollMove`) — unless the zoomed
 * terminal can still pan that way, which goes first.
 *
 * A DOM component file may export only its component (and types).
 */
import '@xterm/xterm/css/xterm.css'
import type { TerminalThemeColors } from '@slayzone/theme-tokens'
import { Terminal } from '@xterm/xterm'
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from 'expo/dom'
import { type Ref, useEffect, useRef } from 'react'
import { DOUBLE_TAP_MS, TapTracker } from './tap-gesture'
import type { TextSize } from './terminal-scale'
import { XtermView } from './xterm-view'

/** What the native side calls (each call crosses into the web view as JSON). */
export type TerminalDomHandle = DOMImperativeFactory & {
  write(data: string): void
  reset(): void
  resize(cols: number, rows: number): void
  /** Send the screen's (`screen`) or all the output's (`all`) text to `onText`. */
  requestText(kind: 'screen' | 'all'): void
}

/** A value a handle call carries over the bridge. */
type Arg = Parameters<DOMImperativeFactory[string]>[number]

export interface TerminalDomProps {
  colors: TerminalThemeColors
  textSize: TextSize
  onReady: () => Promise<void>
  onModes: (applicationCursorKeys: boolean) => Promise<void>
  onInteract: () => Promise<void>
  onInput: (data: string) => Promise<void>
  onOpenLink: (url: string) => Promise<void>
  onTextSize: (size: TextSize) => Promise<void>
  onText: (text: string) => Promise<void>
  ref?: Ref<TerminalDomHandle>
  dom?: DOMProps
}

/** Two fingers' distance apart. */
function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

export default function TerminalDom({
  colors,
  textSize,
  onReady,
  onModes,
  onInteract,
  onInput,
  onOpenLink,
  onTextSize,
  onText,
  ref
}: TerminalDomProps) {
  const element = useRef<HTMLDivElement>(null)
  const view = useRef<XtermView | null>(null)
  // The native side's callbacks, current in every handler; the colours and text size
  // the terminal is created with (later ones follow in their own effects).
  const callbacks = useRef({
    onReady,
    onModes,
    onInteract,
    onInput,
    onOpenLink,
    onTextSize,
    onText
  })
  const initialColors = useRef(colors)
  const initialTextSize = useRef(textSize)
  useEffect(() => {
    callbacks.current = { onReady, onModes, onInteract, onInput, onOpenLink, onTextSize, onText }
  })

  useEffect(() => {
    const host = element.current
    if (!host) return
    // Scrolled to the end: the newest line is shown, and stays shown.
    let pinned = true
    const followScroll = (): void => {
      pinned = host.scrollTop + host.clientHeight >= host.scrollHeight - 2
    }
    const keepNewest = (): void => {
      requestAnimationFrame(() => {
        if (pinned) host.scrollTop = host.scrollHeight
      })
    }
    const created = new XtermView(
      (options) => new Terminal(options),
      {
        element: host,
        viewportWidth: () => host.clientWidth,
        screenRect: () =>
          host.querySelector('.xterm-screen')?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: 0,
            height: 0
          },
        fontChanged: keepNewest
      },
      {
        onModes: (modes) => void callbacks.current.onModes(modes.applicationCursorKeys),
        onInput: (data) => void callbacks.current.onInput(data),
        onTextSize: (size) => void callbacks.current.onTextSize(size)
      },
      initialColors.current,
      initialTextSize.current
    )
    view.current = created

    let pinchFrom = 0
    const taps = new TapTracker()
    // A tapped link opens once no second tap (a double tap) followed.
    let pendingLink: ReturnType<typeof setTimeout> | null = null
    const dropPendingLink = (): void => {
      if (pendingLink !== null) clearTimeout(pendingLink)
      pendingLink = null
    }
    // This gesture's scroll goes to the program: its events never reach xterm.
    let owned = false
    let lastY = 0
    const keep = (event: TouchEvent): void => {
      if (owned) event.stopPropagation()
    }
    // The zoomed terminal is taller than the view and can still pan `dy`'s way.
    const pans = (dy: number): boolean =>
      dy > 0 ? host.scrollTop > 0 : host.scrollTop + host.clientHeight < host.scrollHeight - 1
    const touchStart = (event: TouchEvent): void => {
      void callbacks.current.onInteract()
      if (event.touches.length === 1) {
        owned = created.touchScrollStart()
        lastY = event.touches[0].clientY
        taps.start(event.touches[0].clientX, event.touches[0].clientY)
      }
      keep(event)
      if (event.touches.length === 2) {
        taps.cancel()
        pinchFrom = spread(event.touches)
        created.pinchStart()
      }
    }
    const touchMove = (event: TouchEvent): void => {
      keep(event)
      if (event.touches.length === 1) taps.move(event.touches[0].clientX, event.touches[0].clientY)
      if (event.touches.length === 1 && owned && pinchFrom === 0) {
        const touch = event.touches[0]
        const dy = touch.clientY - lastY
        lastY = touch.clientY
        if (!pans(dy)) created.touchScrollMove(dy, touch.clientX, touch.clientY)
        return
      }
      if (event.touches.length !== 2 || pinchFrom === 0) return
      event.preventDefault()
      created.pinchMove(spread(event.touches) / pinchFrom)
    }
    const touchEnd = (event: TouchEvent): void => {
      keep(event)
      if (event.touches.length > 0) return
      owned = false
      if (pinchFrom !== 0) {
        pinchFrom = 0
        taps.cancel()
        return
      }
      const touch = event.changedTouches[0]
      const tap = taps.end()
      if (tap === 'double') {
        dropPendingLink()
        created.toggleTextSize()
      } else if (tap === 'tap' && touch) {
        const link = created.linkAt(touch.clientX, touch.clientY)
        dropPendingLink()
        if (link) {
          pendingLink = setTimeout(() => {
            pendingLink = null
            void callbacks.current.onOpenLink(link)
          }, DOUBLE_TAP_MS)
        }
      }
    }
    const touchCancel = (): void => {
      owned = false
      pinchFrom = 0
      taps.cancel()
    }
    const refit = (): void => {
      created.refit()
      keepNewest()
    }
    host.addEventListener('scroll', followScroll, { passive: true })
    host.addEventListener('touchstart', touchStart, { passive: true })
    host.addEventListener('touchmove', touchMove, { passive: false })
    host.addEventListener('touchend', touchEnd)
    host.addEventListener('touchcancel', touchCancel)
    window.addEventListener('resize', refit)
    return () => {
      dropPendingLink()
      host.removeEventListener('scroll', followScroll)
      host.removeEventListener('touchstart', touchStart)
      host.removeEventListener('touchmove', touchMove)
      host.removeEventListener('touchend', touchEnd)
      host.removeEventListener('touchcancel', touchCancel)
      window.removeEventListener('resize', refit)
      view.current = null
      created.dispose()
    }
  }, [])

  useDOMImperativeHandle<TerminalDomHandle>(
    ref ?? null,
    () => ({
      write: (...args: Arg[]) => {
        view.current?.write(String(args[0]))
      },
      reset: () => {
        view.current?.reset()
      },
      resize: (...args: Arg[]) => {
        view.current?.resize(Number(args[0]), Number(args[1]))
      },
      requestText: (...args: Arg[]) => {
        const current = view.current
        if (current)
          void callbacks.current.onText(current.text(args[0] === 'all' ? 'all' : 'screen'))
      }
    }),
    []
  )

  // Once per page load, after the handle is registered with the native side (the
  // effect above this one posts it).
  useEffect(() => {
    void callbacks.current.onReady()
  }, [])

  useEffect(() => {
    view.current?.setTheme(colors)
  }, [colors])

  useEffect(() => {
    view.current?.setTextSize(textSize)
  }, [textSize])

  return (
    <div
      ref={element}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'auto',
        touchAction: 'pan-x pan-y',
        backgroundColor: colors.background
      }}
    />
  )
}
