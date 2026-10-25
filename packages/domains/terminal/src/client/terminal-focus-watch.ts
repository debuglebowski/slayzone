import type { RefObject } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { useTRPCClient } from '@slayzone/transport/client'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'
import {
  ensureFocusDiagnostics,
  captureBlurSync,
  settleBlurContext,
  classifyFocusLoss,
  describeEl,
  getFocusTrail,
  getLastInput
} from './focus-loss-diag'
import { isEarlyInputCapturing } from './early-input'

interface FocusLossWatchOptions {
  container: HTMLElement
  terminalRef: RefObject<XTerm | null>
  ptyStateRef: RefObject<TerminalState>
  sessionId: string
  mode: TerminalMode
  trpcClient: ReturnType<typeof useTRPCClient>
}

/**
 * DIAGNOSTIC (gated by the diagnostics config in main; off → no-op): catch the
 * intermittent focus-theft regression where the xterm helper textarea blurs
 * and focus does NOT return shortly after, while the OS window is still
 * focused — i.e. an in-app steal, not the user switching apps. Records WHERE
 * focus landed so a prod repro names the culprit, and self-heals a blur to
 * <body>. Self-healed blurs (focus returns to this terminal) and window-blur
 * (alt-tab) are ignored; throttled. Returns the cleanup.
 */
export function watchTerminalFocusLoss({
  container,
  terminalRef,
  ptyStateRef,
  sessionId,
  mode,
  trpcClient
}: FocusLossWatchOptions): () => void {
  // App-wide focus trail + last-input breadcrumb (install-once). Powers the
  // root-cause attribution attached to the report below.
  ensureFocusDiagnostics()

  const REPORT_THROTTLE_MS = 3000
  let lastReportAt = 0
  let lastHealAt = 0

  const ownsHelperTextarea = (el: EventTarget | null): boolean =>
    el instanceof Element &&
    el.classList.contains('xterm-helper-textarea') &&
    !!terminalRef.current?.element?.contains(el)

  const onFocusOut = (e: FocusEvent): void => {
    if (!ownsHelperTextarea(e.target)) return
    const textarea = e.target as Element
    const immediate = e.relatedTarget as Element | null
    // Cheap synchronous capture (stack + isConnected only). Runs on every
    // blur, so it does no layout work and self-guards. The 300ms gate then
    // decides if this blur was actually the failure worth the heavy walk.
    let sync
    try {
      sync = captureBlurSync(textarea)
    } catch {
      return // capture itself failed — nothing safe to report
    }
    // FAST self-heal. Clicking non-focusable app chrome (tree status headers,
    // layout divs, bare icons) clears focus to <body> via Chromium's focus-fixup,
    // leaving the terminal unfocused until the user clicks back in — the actual
    // bug behind the reports. Reclaim it on the next task: sub-frame, no
    // perceptible blur, no lost keystrokes. Gated hard so legitimate moves are
    // untouched — only when focus went NOWHERE (a move to a real control is
    // intentional) and the window still has focus (not alt-tab). terminalRef
    // .focus() no-ops on a hidden/inert/detached textarea, so genuine
    // "can't refocus" failures still fall through to the 300ms reporter below.
    window.setTimeout(() => {
      try {
        const active = document.activeElement
        if (ownsHelperTextarea(active)) return // already healed natively
        if (!document.hasFocus()) return // alt-tab / window blur
        const wentNowhere =
          active == null || active === document.body || active === document.documentElement
        if (!wentNowhere) return // focus moved to a real control — leave it
        // Blurred on purpose for a terminal being created (Cmd+Shift+N): focus
        // belongs to that one, not back here.
        if (isEarlyInputCapturing()) return
        if (!textarea.isConnected) return // torn down — let the reporter classify it
        const landedBefore = describeEl(active)
        terminalRef.current?.focus()
        if (!ownsHelperTextarea(document.activeElement)) return // hidden/inert → real failure
        const now = performance.now()
        if (now - lastHealAt < REPORT_THROTTLE_MS) return
        lastHealAt = now
        void trpcClient.diagnostics.recordClientEvent
          .mutate({
            event: 'terminal.focus_self_healed',
            level: 'info',
            sessionId,
            message: `xterm focus reclaimed after stray blur to <body> (mode=${mode})`,
            payload: {
              mode,
              ptyState: ptyStateRef.current,
              landedBefore,
              lastInput: getLastInput()
            }
          })
          .catch(() => {
            // A dropped diagnostic (sidecar down, or the call still in flight at
            // teardown) beats an unhandled rejection inside the focus path.
          })
      } catch {
        /* self-heal must never break the terminal */
      }
    }, 0)
    window.setTimeout(() => {
      // Wrap the whole confirm+report path: a capture bug must never throw on
      // a timer (lost signal + noisy console) — degrade to a marker event.
      try {
        const active = document.activeElement
        if (ownsHelperTextarea(active)) return // self-healed → not a failure
        if (!document.hasFocus()) return // alt-tab / window blur → not in-app
        // Only the observed failure signature: focus went NOWHERE (body/root)
        // → the user "must click again". Intentional moves to another control
        // (editor, sidebar, dialog input) land on a real focusable and are NOT
        // this bug — skip them to keep the signal clean.
        const wentNowhere =
          active == null || active === document.body || active === document.documentElement
        if (!wentNowhere) return
        const now = performance.now()
        if (now - lastReportAt < REPORT_THROTTLE_MS) return
        lastReportAt = now
        // Heavy DOM walk happens HERE — only for confirmed failures.
        const ctx = settleBlurContext(textarea, terminalRef.current?.element, container, sync)
        const cause = classifyFocusLoss(ctx)
        void trpcClient.diagnostics.recordClientEvent
          .mutate({
            event: 'terminal.focus_lost_no_refocus',
            level: 'warn',
            sessionId,
            message: `xterm lost focus and did not refocus within 300ms (mode=${mode}, cause=${cause})`,
            payload: {
              mode,
              ptyState: ptyStateRef.current,
              // Automatic root-cause classification + the evidence behind it.
              cause,
              blurStack: ctx.blurStack,
              // Connectivity at the blur instant (cheap, blur-time signal).
              domAtBlur: { textareaConnected: ctx.textareaConnectedAtBlur },
              // Settled DOM state at +300ms — what decides "why couldn't it
              // refocus": teardown / tab-hide / inert-or-disabled / in-place.
              dom: {
                textareaConnected: ctx.textareaConnected,
                terminalConnected: ctx.terminalConnected,
                containerConnected: ctx.containerConnected,
                hiddenAncestor: ctx.hiddenAncestor,
                focusBlocker: ctx.focusBlocker
              },
              // How recently the terminal painted — confirms/refutes the
              // output-correlation the earlier CDP run observed.
              sinceOutputMs: ctx.sinceOutputMs,
              // Was a real user action close before the steal? No recent input
              // → spurious/programmatic navigation, not the user leaving.
              lastInput: {
                key: ctx.lastKey,
                sinceKeyMs: ctx.sinceKeyMs,
                pointerTarget: ctx.lastPointerTarget,
                sincePointerMs: ctx.sincePointerMs
              },
              focusTrail: getFocusTrail(),
              landedOn: describeEl(active),
              immediateRelated: describeEl(immediate),
              visibility: document.visibilityState,
              // hibernate-warn countdown overlay (Moon icon) lives in the
              // TerminalStarter wrapper (sibling of <Terminal>), so look up to
              // the nearest positioned ancestor, not inside our own container.
              countdownVisible: !!(
                container.closest('div.relative') ?? container.parentElement
              )?.querySelector('.animate-pulse')
            }
          })
          .catch(() => {
            // Same as above: reporting the failure must not itself become one.
          })
      } catch (err) {
        // Never lose the signal to a capture bug — emit a minimal marker so
        // the failure itself is visible in the diagnostics stream.
        try {
          void trpcClient.diagnostics.recordClientEvent
            .mutate({
              event: 'terminal.focus_lost_no_refocus',
              level: 'warn',
              sessionId,
              message: `focus-loss capture failed (mode=${mode})`,
              payload: {
                mode,
                cause: 'capture-error',
                captureError: String((err as Error)?.message ?? err),
                blurStack: sync.blurStack
              }
            })
            .catch(() => {
              // Last-resort marker — if even this cannot be delivered, drop it.
            })
        } catch {
          /* give up silently — diagnostics must never break the terminal */
        }
      }
    }, 300)
  }

  container.addEventListener('focusout', onFocusOut, true)
  return () => container.removeEventListener('focusout', onFocusOut, true)
}
