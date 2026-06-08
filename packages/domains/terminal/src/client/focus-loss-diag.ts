// Root-cause attribution for the intermittent xterm focus-steal bug.
//
// The Terminal focusout diagnostic records the SYMPTOM (focus left the xterm
// helper textarea and landed on <body> while the window stayed focused). That
// tells us a steal happened, not WHY. This module captures, SYNCHRONOUSLY at the
// instant focus leaves, enough context to name the cause automatically:
//
//   - blurStack: the JS call stack at focusout. A programmatic blur()/focus(), a
//     node removal, or a React commit that toggles `display` all fire blur
//     synchronously, so their frames are on the stack here. A plain user click
//     does not leave app frames. Captured at the blur moment — a later timeout
//     would only see native dispatch frames and the settled DOM.
//   - dom snapshot: is the textarea still connected? Is an ancestor now hidden
//     (tab switch / collapse)? These split the failure into distinct classes.
//   - lastInput: the last key / pointer event app-wide and how long ago. A steal
//     with no user input in the preceding moments is a spurious/programmatic
//     navigation, not the user leaving the terminal — this is the signal that
//     separates "user switched tabs" from "the app yanked focus".
//   - focusTrail: the last N app-wide focus moves, for the lead-up sequence.
//
// classifyFocusLoss() folds the DOM + stack evidence into a single `cause` label
// so a query over the diagnostics DB groups occurrences by root cause without
// manual triage.

export interface ElementDescriptor {
  tag: string | null
  cls?: string
  id?: string | null
  testid?: string | null
  nearestPanel?: string | null
  connected?: boolean
}

export function describeEl(el: Element | null): ElementDescriptor {
  if (!el) return { tag: null }
  const panel = el.closest('[data-testid],[data-panel],[role="dialog"]')
  return {
    tag: el.tagName,
    cls: (el.className?.toString?.() ?? '').slice(0, 80),
    id: el.id || null,
    testid: el.getAttribute('data-testid'),
    nearestPanel:
      panel?.getAttribute('data-testid') ??
      panel?.getAttribute('data-panel') ??
      panel?.getAttribute('role') ??
      null,
    connected: el.isConnected
  }
}

export type HiddenReason = 'display:none' | 'visibility:hidden' | 'hidden-attr' | 'aria-hidden'

export interface HiddenAncestor extends ElementDescriptor {
  reason: HiddenReason
  depth: number
}

// Walk up from `el` to the first ancestor that visually hides it. A tab switch
// (display:none on the inactive tab panel) and a collapse both surface here;
// null means the textarea is still in a visible subtree (so a blur there is an
// in-place steal, not a hide).
export function firstHiddenAncestor(el: Element | null): HiddenAncestor | null {
  let node: Element | null = el
  let depth = 0
  while (node && depth < 40) {
    let cs: CSSStyleDeclaration | null = null
    try {
      cs = window.getComputedStyle(node)
    } catch {
      cs = null
    }
    const reason: HiddenReason | null =
      cs?.display === 'none'
        ? 'display:none'
        : cs?.visibility === 'hidden'
          ? 'visibility:hidden'
          : node.hasAttribute('hidden')
            ? 'hidden-attr'
            : node.getAttribute('aria-hidden') === 'true'
              ? 'aria-hidden'
              : null
    if (reason) return { ...describeEl(node), reason, depth }
    node = node.parentElement
    depth++
  }
  return null
}

// Element-level focusability. `inert` (on the element or any ancestor) and
// `disabled` make a node unfocusable while it stays VISIBLE and CONNECTED — so
// firstHiddenAncestor() cannot see them. This is the prime "blurred AND cannot
// refocus" mechanism and was never tested by the earlier CDP run. readOnly and
// a negative tabIndex are captured as data but do NOT block programmatic
// .focus(), so they are not treated as blockers.
export interface FocusBlocker {
  disabled: boolean
  readOnly: boolean
  inert: boolean
  tabIndex: number | null
  contentEditable: string | null
  inertAncestor: ElementDescriptor | null
}

export function describeFocusability(el: Element | null): FocusBlocker {
  const ta = el instanceof HTMLElement ? el : null
  const inertHit = el?.closest('[inert]') ?? null
  return {
    disabled: !!(ta && 'disabled' in ta && (ta as HTMLTextAreaElement).disabled),
    readOnly: !!(ta && 'readOnly' in ta && (ta as HTMLTextAreaElement).readOnly),
    inert: !!ta?.inert,
    tabIndex: ta ? ta.tabIndex : null,
    contentEditable: ta ? ta.contentEditable : null,
    inertAncestor: inertHit && inertHit !== el ? describeEl(inertHit) : null
  }
}

// Genuinely blocks a programmatic terminal.focus() (the self-heal path). Only
// disabled / inert / ancestor-inert qualify; readOnly and tabIndex<0 are still
// focusable via .focus().
export function isElementUnfocusable(fb: FocusBlocker): boolean {
  return fb.disabled || fb.inert || !!fb.inertAncestor
}

// Captured SYNCHRONOUSLY at the blur instant. Deliberately tiny: this runs on
// EVERY terminal blur (including ordinary intentional ones), so it does no
// layout reads. The stack is intrinsically synchronous; isConnected is O(1).
export interface SyncBlurCapture {
  blurAt: number
  blurStack: string
  textareaConnectedAtBlur: boolean
}

export interface BlurContext {
  blurStack: string
  // Connectivity at the blur instant vs at +300ms — an xterm re-open detaches
  // the old textarea (false at both); a transient detach would differ.
  textareaConnectedAtBlur: boolean
  textareaConnected: boolean
  terminalConnected: boolean | null
  containerConnected: boolean
  hiddenAncestor: HiddenAncestor | null
  focusBlocker: FocusBlocker
  lastKey: string | null
  sinceKeyMs: number | null
  lastPointerTarget: string | null
  sincePointerMs: number | null
  // ms since the last live xterm write (paint). The earlier CDP run found the
  // stealing blur tracks terminal OUTPUT; a small value here confirms that
  // correlation automatically. null = no output seen yet this session.
  sinceOutputMs: number | null
}

// Cheap, synchronous, runs on every blur. Only the stack (which must be grabbed
// at the synchronous moment to name the JS culprit) and an isConnected read.
// Self-guards: a stack failure degrades to '' rather than throwing on the hot
// path. The heavy DOM walk is deferred to settleBlurContext(), gated to actual
// failures.
export function captureBlurSync(textarea: Element): SyncBlurCapture {
  let blurStack = ''
  try {
    const raw = new Error('focus-loss-trace').stack ?? ''
    // Drop the Error header + this frame; keep the meaningful app frames.
    blurStack = raw.split('\n').slice(2, 16).join('\n')
  } catch {
    blurStack = ''
  }
  return {
    blurAt: performance.now(),
    blurStack,
    textareaConnectedAtBlur: textarea.isConnected
  }
}

// Build the full attribution context. Called from the gated 300ms timeout —
// i.e. ONLY for confirmed failures — so the getComputedStyle ancestor walk and
// focusability reads never run on ordinary blurs. The settled DOM state read
// here (hidden / inert persists for the 300ms) is exactly what decides "why the
// refocus could not land", and the blur-instant stack is carried in via `sync`.
export function settleBlurContext(
  textarea: Element,
  terminalEl: Element | null | undefined,
  container: Element,
  sync: SyncBlurCapture
): BlurContext {
  return {
    blurStack: sync.blurStack,
    textareaConnectedAtBlur: sync.textareaConnectedAtBlur,
    textareaConnected: textarea.isConnected,
    terminalConnected: terminalEl?.isConnected ?? null,
    containerConnected: container.isConnected,
    hiddenAncestor: firstHiddenAncestor(textarea),
    focusBlocker: describeFocusability(textarea),
    lastKey: lastInput.key,
    // Deltas are relative to the BLUR instant, not this settle time.
    sinceKeyMs: lastInput.keyAt >= 0 ? Math.round(sync.blurAt - lastInput.keyAt) : null,
    lastPointerTarget: lastInput.pointer,
    sincePointerMs: lastInput.pointerAt >= 0 ? Math.round(sync.blurAt - lastInput.pointerAt) : null,
    sinceOutputMs: lastOutputAt >= 0 ? Math.round(sync.blurAt - lastOutputAt) : null
  }
}

export type FocusLossCause =
  | 'dom-teardown'
  | 'ancestor-display-none'
  | 'ancestor-visibility-hidden'
  | 'ancestor-hidden-attr'
  | 'ancestor-aria-hidden'
  | 'element-unfocusable'
  | 'click-to-nonfocusable'
  | 'programmatic-blur'
  | 'unattributed'

// A click that lands on a non-focusable element (a layout div, a bare icon, a
// status header) clears focus to <body> within the same task via Chromium's
// focus-fixup. If a pointerdown fired within a couple frames of the blur AND focus
// went nowhere (the caller establishes that before classifying), the click IS the
// cause — empirically the single most common real-world signature.
const CLICK_BLUR_WINDOW_MS = 64

// Fold the synchronous context into one label. Order matters: a detached
// textarea is a teardown regardless of anything else; a hidden ancestor is a
// hide; an unfocusable-but-visible element (inert/disabled) is the "can't
// refocus" class; otherwise, if app frames moved focus it is a programmatic
// blur; else we genuinely cannot attribute it.
export function classifyFocusLoss(ctx: BlurContext): FocusLossCause {
  if (!ctx.textareaConnected) return 'dom-teardown'
  if (ctx.hiddenAncestor) {
    switch (ctx.hiddenAncestor.reason) {
      case 'display:none':
        return 'ancestor-display-none'
      case 'visibility:hidden':
        return 'ancestor-visibility-hidden'
      case 'hidden-attr':
        return 'ancestor-hidden-attr'
      case 'aria-hidden':
        return 'ancestor-aria-hidden'
    }
  }
  // Visible + connected but inert/disabled → the element refuses focus, so the
  // self-heal refocus cannot land. This is the prime suspect for the genuine
  // mid-typing steal and the one the earlier CDP run never checked.
  if (isElementUnfocusable(ctx.focusBlocker)) return 'element-unfocusable'
  // A pointerdown a couple frames before the blur, with focus now on <body>, means
  // the user clicked non-focusable chrome and Chromium cleared focus. This — not
  // terminal output — is what the rich captures actually show.
  if (ctx.sincePointerMs != null && ctx.sincePointerMs <= CLICK_BLUR_WINDOW_MS) {
    return 'click-to-nonfocusable'
  }
  // App frames moving focus = a programmatic blur()/focus() or a React commit. The
  // focusout handler itself ALWAYS lives in Terminal.tsx, so its frame must be
  // stripped first — otherwise every captured stack matches "Terminal" and
  // EVERYTHING is mislabelled programmatic (the bug this replaces). A native focus
  // change dispatches focusout from the event loop, leaving no app caller above us.
  const callerFrames = ctx.blurStack
    .split('\n')
    .filter((line) => line.trim() && !/onFocusOut/.test(line))
  if (
    callerFrames.some((line) =>
      /\b(blur|focus|Terminal|useTerminal|commit|HTMLElement)\b/i.test(line)
    )
  ) {
    return 'programmatic-blur'
  }
  return 'unattributed'
}

interface FocusTrailEntry {
  t: number
  type: 'in' | 'out'
  target: string
}

const focusTrail: FocusTrailEntry[] = []
const FOCUS_TRAIL_CAP = 24

const lastInput = {
  key: null as string | null,
  keyAt: -1,
  pointer: null as string | null,
  pointerAt: -1
}

let lastOutputAt = -1

// Call on each live xterm write (paint). Lets the focus-loss report state how
// recently the terminal painted — the earlier CDP run found the stealing blur
// tracks output, and this turns that correlation from a manual cross-reference
// into a field on the event.
export function noteTerminalOutput(): void {
  lastOutputAt = performance.now()
}

let installed = false

function shortDescribe(el: EventTarget | null): string {
  if (el === null) return 'null'
  if (!(el instanceof Element)) return 'non-element'
  const testid = el.getAttribute('data-testid')
  if (testid) return `${el.tagName}#${testid}`
  const cls = (el.className?.toString?.() ?? '').trim().split(/\s+/).slice(0, 2).join('.')
  return cls ? `${el.tagName}.${cls}` : el.tagName
}

// Install-once, app-wide. Records focus moves + last user input so a focus-loss
// report can attach the immediately-preceding sequence and tell user-initiated
// from spurious. Cheap: these events are infrequent, the ring is capped, and no
// handler calls preventDefault. The IPC write is still gated in main, so leaving
// this on costs only a few small array pushes.
export function ensureFocusDiagnostics(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const recordFocus = (type: 'in' | 'out', e: Event): void => {
    if (focusTrail.length >= FOCUS_TRAIL_CAP) focusTrail.shift()
    focusTrail.push({
      t: Math.round(performance.now()),
      type,
      target: shortDescribe((e as FocusEvent).target)
    })
  }
  document.addEventListener('focusin', (e) => recordFocus('in', e), true)
  document.addEventListener('focusout', (e) => recordFocus('out', e), true)
  document.addEventListener(
    'keydown',
    (e) => {
      lastInput.key = (e as KeyboardEvent).key
      lastInput.keyAt = Math.round(performance.now())
    },
    true
  )
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastInput.pointer = shortDescribe((e as PointerEvent).target)
      lastInput.pointerAt = Math.round(performance.now())
    },
    true
  )
}

export function getFocusTrail(n = 12): FocusTrailEntry[] {
  return focusTrail.slice(-n)
}

// Last app-wide key + pointer breadcrumb, with ages relative to now. Lets the
// self-heal path attribute a reclaimed blur to the click that caused it without
// the heavy settleBlurContext() DOM walk.
export function getLastInput(): {
  key: string | null
  sinceKeyMs: number | null
  pointer: string | null
  sincePointerMs: number | null
} {
  const now = performance.now()
  return {
    key: lastInput.key,
    sinceKeyMs: lastInput.keyAt >= 0 ? Math.round(now - lastInput.keyAt) : null,
    pointer: lastInput.pointer,
    sincePointerMs: lastInput.pointerAt >= 0 ? Math.round(now - lastInput.pointerAt) : null
  }
}
