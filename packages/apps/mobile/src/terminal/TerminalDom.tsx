'use dom'

/**
 * The terminal itself: xterm.js — the terminal library desktop uses — in a web view
 * (an Expo DOM component: this file runs with React DOM inside `@expo/dom-webview`;
 * the app renders it like a native component). The rules live in `xterm-view.ts`;
 * this file wires them to the browser: the element, touch gestures, window size.
 *
 * Native → web: the imperative handle (`write`, `reset`, `resize`), one injected
 * script per call (`dom-sink.ts` batches them per frame) — output never goes through
 * props, which are re-sent whole on every change.
 * Web → native: `onReady` once this terminal exists (again after the web view
 * reloads: the native side then replays the session), `onModes` when the cursor-key
 * mode changes, `onInteract` on a touch (keeps the agent from idle-closing).
 *
 * A DOM component file may export only its component (and types).
 */
import '@xterm/xterm/css/xterm.css'
import type { TerminalThemeColors } from '@slayzone/theme-tokens'
import { Terminal } from '@xterm/xterm'
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from 'expo/dom'
import { type Ref, useEffect, useRef } from 'react'
import { XtermView } from './xterm-view'

/** What the native side calls (each call crosses into the web view as JSON). */
export type TerminalDomHandle = DOMImperativeFactory & {
  write(data: string): void
  reset(): void
  resize(cols: number, rows: number): void
}

/** A value a handle call carries over the bridge. */
type Arg = Parameters<DOMImperativeFactory[string]>[number]

export interface TerminalDomProps {
  colors: TerminalThemeColors
  onReady: () => Promise<void>
  onModes: (applicationCursorKeys: boolean) => Promise<void>
  onInteract: () => Promise<void>
  ref?: Ref<TerminalDomHandle>
  dom?: DOMProps
}

/** Two fingers' distance apart. */
function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

const DOUBLE_TAP_MS = 300

export default function TerminalDom({
  colors,
  onReady,
  onModes,
  onInteract,
  ref
}: TerminalDomProps) {
  const element = useRef<HTMLDivElement>(null)
  const view = useRef<XtermView | null>(null)
  // The native side's callbacks, current in every handler; the colours the terminal
  // is created with (later ones follow in their own effect).
  const callbacks = useRef({ onReady, onModes, onInteract })
  const initialColors = useRef(colors)
  useEffect(() => {
    callbacks.current = { onReady, onModes, onInteract }
  })

  useEffect(() => {
    const host = element.current
    if (!host) return
    const created = new XtermView(
      (options) => new Terminal(options),
      {
        element: host,
        viewportWidth: () => host.clientWidth,
        screenWidth: () => host.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0
      },
      { onModes: (modes) => void callbacks.current.onModes(modes.applicationCursorKeys) },
      initialColors.current
    )
    view.current = created

    let pinchFrom = 0
    let lastTap = 0
    const touchStart = (event: TouchEvent): void => {
      void callbacks.current.onInteract()
      if (event.touches.length === 2) {
        pinchFrom = spread(event.touches)
        created.pinchStart()
      }
    }
    const touchMove = (event: TouchEvent): void => {
      if (event.touches.length !== 2 || pinchFrom === 0) return
      event.preventDefault()
      created.pinchMove(spread(event.touches) / pinchFrom)
    }
    const touchEnd = (event: TouchEvent): void => {
      if (event.touches.length > 0) return
      if (pinchFrom !== 0) {
        pinchFrom = 0
        return
      }
      const now = Date.now()
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0
        created.toggleZoom()
      } else lastTap = now
    }
    const refit = (): void => created.refit()
    host.addEventListener('touchstart', touchStart, { passive: true })
    host.addEventListener('touchmove', touchMove, { passive: false })
    host.addEventListener('touchend', touchEnd)
    window.addEventListener('resize', refit)
    return () => {
      host.removeEventListener('touchstart', touchStart)
      host.removeEventListener('touchmove', touchMove)
      host.removeEventListener('touchend', touchEnd)
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
