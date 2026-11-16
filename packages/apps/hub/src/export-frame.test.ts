/**
 * The export frame's bootstrap (export-frame.ts), run against a stand-in window: the
 * frame keeps `allow-modals` (print() needs it), so the bootstrap takes the native
 * alert/confirm/prompt away from the document it writes (review 8, L4). The real
 * browser behaviour is e2e 207's "cannot raise alert/confirm/prompt" case.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/export-frame.test.ts
 */
import { expect, test, vi } from 'vitest'
import { EXPORT_FRAME_HTML, EXPORT_FRAME_VERSION } from './export-frame.js'

function bootstrapSource(): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(EXPORT_FRAME_HTML)
  if (!match) throw new Error('no bootstrap script in EXPORT_FRAME_HTML')
  return match[1]
}

/** Run the bootstrap with a window whose dialogs are spies, framed by a parent. */
function boot() {
  const native = {
    alert: vi.fn(),
    confirm: vi.fn(() => true),
    prompt: vi.fn(() => 'secret')
  }
  const posted: unknown[] = []
  const win: Record<string, unknown> = {
    ...native,
    parent: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: () => {}
  }
  new Function('window', bootstrapSource())(win)
  return { win, native, posted }
}

test('the bootstrap announces itself to its parent', () => {
  expect(boot().posted).toEqual([{ slayzoneExportFrame: EXPORT_FRAME_VERSION }])
})

test('alert/confirm/prompt are no-ops from the start: alert undefined, confirm false, prompt null', () => {
  const { win, native } = boot()
  const call = (name: string, ...args: unknown[]) =>
    (win[name] as (...a: unknown[]) => unknown)(...args)
  expect(call('alert', 'hi')).toBeUndefined()
  expect(call('confirm', 'ok?')).toBe(false)
  expect(call('prompt', 'password?')).toBeNull()
  expect(native.alert).not.toHaveBeenCalled()
  expect(native.confirm).not.toHaveBeenCalled()
  expect(native.prompt).not.toHaveBeenCalled()
})

test('the no-ops cannot be deleted, overwritten or redefined', () => {
  const { win, native } = boot()
  for (const name of ['alert', 'confirm', 'prompt']) {
    expect(Reflect.deleteProperty(win, name), `delete ${name}`).toBe(false)
    expect(Reflect.set(win, name, native.alert), `assign ${name}`).toBe(false)
    expect(Reflect.defineProperty(win, name, { value: native.alert }), `redefine ${name}`).toBe(
      false
    )
    expect(win[name], `${name} still ours`).not.toBe(native[name as keyof typeof native])
  }
})

// Review 9, F2: the document may navigate the frame away to a page without this lock.
// The shell takes allow-modals from any next document and treats a frame load the
// bootstrap does not vouch for as hostile; the bootstrap vouches over the private
// channel the shell sends with the document, reports a navigation it sees start, and
// then never prints. Real browsers: e2e 207's navigation cases.
type Listener = (event: unknown) => void

/** A window + document pair that runs the bootstrap through a render. */
function bootRender({
  dialogOpens = true,
  dialogLater = false
}: {
  dialogOpens?: boolean
  dialogLater?: boolean
} = {}) {
  const posted: Record<string, unknown>[] = []
  const listeners = new Map<string, Set<Listener>>()
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  const printed: Record<string, unknown>[][] = []
  const win: Record<string, unknown> = {
    alert: () => {},
    confirm: () => true,
    prompt: () => 'x',
    parent,
    length: 0,
    focus: () => {},
    // What had been posted when the dialog opened. A dialog that opens fires
    // beforeprint, and afterprint once it closes (print() blocks until then).
    print: vi.fn(() => {
      printed.push([...posted])
      if (!dialogOpens) return
      const open = () => {
        dispatch('beforeprint')
        dispatch('afterprint')
      }
      // Headless Chromium returns from print() at once and fires both right after.
      if (dialogLater) setTimeout(open, 200)
      else open()
    }),
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
    }
  }
  const dispatch = (type: string, event: unknown = {}) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
  }
  /** What `document.open()` does to a window: every listener on it is gone. */
  const eraseListeners = () => listeners.clear()
  const doc = {
    readyState: 'complete',
    images: [],
    documentElement: { getAttribute: () => null },
    open: vi.fn(() => eraseListeners()),
    write: vi.fn(),
    close: vi.fn(),
    addEventListener: () => {}
  }
  const observers: Array<() => void> = []
  class FakeMutationObserver {
    constructor(private readonly cb: () => void) {}
    observe() {
      observers.push(this.cb)
    }
  }
  new Function('window', 'document', 'MutationObserver', bootstrapSource())(
    win,
    doc,
    FakeMutationObserver
  )
  const port = { postMessage: vi.fn(), onmessage: null as null | ((e: { data: unknown }) => void) }
  const send = () =>
    dispatch('message', {
      source: parent,
      data: { slayzoneExport: 'id-1', html: '<p>x</p>', waitForReady: false, deadlineMs: 30_000 },
      ports: [port]
    })
  return { win, doc, posted, printed, port, send, dispatch, eraseListeners, observers }
}

test('the bootstrap answers pings on the channel the shell sent, before and after the document is written', () => {
  const { port, send, doc } = bootRender()
  send()
  expect(doc.write).toHaveBeenCalledWith('<p>x</p>')
  port.onmessage?.({ data: { ping: 3 } })
  expect(port.postMessage).toHaveBeenLastCalledWith({ pong: 3 })
  port.onmessage?.({ data: 'not a ping' })
  expect(port.postMessage).toHaveBeenCalledTimes(1)
})

test.each(['beforeunload', 'pagehide'])(
  'a navigation it sees start (%s) is reported at once, and nothing is printed',
  async (type) => {
    vi.useFakeTimers()
    try {
      const { win, posted, send, dispatch } = bootRender()
      send()
      dispatch(type)
      expect(posted).toContainEqual({ slayzoneExport: 'id-1', state: 'navigated' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(win.print).not.toHaveBeenCalled()
      expect(posted.some((m) => m.state === 'ready')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  }
)

test("the navigation watch comes back after the artifact's own document.open erased it", async () => {
  vi.useFakeTimers()
  try {
    const { win, posted, send, dispatch, eraseListeners, observers } = bootRender()
    send()
    // The artifact rewrites itself: every window listener is gone, the document's
    // children are replaced (a mutation the bootstrap observes).
    eraseListeners()
    for (const cb of observers) cb()
    dispatch('pagehide')
    expect(posted).toContainEqual({ slayzoneExport: 'id-1', state: 'navigated' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(win.print).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test('ready is reported in the task that opens the dialog: what prints is the bootstrap document', async () => {
  vi.useFakeTimers()
  try {
    const { win, posted, printed, send } = bootRender()
    send()
    // Settled already, but the report waits for the dialog's task: nothing of the
    // document's runs between the two.
    expect(posted.some((m) => m.state === 'ready')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(win.print).toHaveBeenCalledTimes(1)
    expect(printed[0].at(-1)).toMatchObject({
      slayzoneExport: 'id-1',
      state: 'ready',
      settled: true
    })
  } finally {
    vi.useRealTimers()
  }
})

test('a navigation the document starts while it is being written is seen too', async () => {
  vi.useFakeTimers()
  try {
    const { win, doc, posted, send, dispatch } = bootRender()
    // An inline script of the document runs inside document.write() and navigates.
    doc.write.mockImplementation(() => dispatch('beforeunload'))
    send()
    expect(posted).toContainEqual({ slayzoneExport: 'id-1', state: 'navigated' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(win.print).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

// Follow-up N1: a hand-written html report often defines its own global `print`
// (or `focus`), which replaces the window's. The bootstrap prints with the window's
// own, taken before the document is written; and a print that never opened the
// dialog fails the export instead of leaving it pending for 30 minutes.
test("the document's own print/focus do not replace the window's: the native print is called", async () => {
  vi.useFakeTimers()
  try {
    const { win, doc, posted, send } = bootRender()
    const nativePrint = win.print as ReturnType<typeof vi.fn>
    const ownPrint = vi.fn()
    // `<script>function print(m) {…} function focus() { throw … }</script>`
    doc.write.mockImplementation(() => {
      win.print = ownPrint
      win.focus = () => {
        throw new Error("focus is the report's")
      }
    })
    send()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ownPrint).not.toHaveBeenCalled()
    expect(nativePrint).toHaveBeenCalledTimes(1)
    expect(posted.filter((m) => m.state === 'error')).toEqual([])
    expect(posted).toContainEqual({ slayzoneExport: 'id-1', state: 'done' })
  } finally {
    vi.useRealTimers()
  }
})

test('a print that never opened the dialog fails the export clearly', async () => {
  vi.useFakeTimers()
  try {
    const { win, posted, send } = bootRender({ dialogOpens: false })
    send()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(win.print).toHaveBeenCalledTimes(1)
    const errors = posted.filter((m) => m.state === 'error')
    expect(errors).toHaveLength(1)
    expect(String(errors[0].message)).toMatch(/print dialog/i)
    expect(posted.some((m) => m.state === 'done')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

test('a dialog that opens reports done once, when it closes, and no error', async () => {
  vi.useFakeTimers()
  try {
    const { posted, send } = bootRender()
    send()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(posted.filter((m) => m.state === 'done')).toHaveLength(1)
    expect(posted.filter((m) => m.state === 'error')).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

test('a dialog that opens a moment after print() returns (headless Chromium) is no failure', async () => {
  vi.useFakeTimers()
  try {
    const { posted, send } = bootRender({ dialogLater: true })
    send()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posted.filter((m) => m.state === 'done')).toHaveLength(1)
    expect(posted.filter((m) => m.state === 'error')).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})
