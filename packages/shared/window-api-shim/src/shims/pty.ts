// cap-shell-3 — real pty via multi-remote TerminalHost.
//
// Each `create({sessionId,…})` call allocates a fresh TerminalHost remote.
// The browser-side SlayzoneShellUI accepts N receivers and tears them down
// on disconnect (= dtor kills the sidecar pty). The shim tracks sessionId →
// {remote, observerRouter} and fans OnOutput / OnExit to shim-level
// dispatchers that PtyContext already subscribes to.
//
// Session-id mismatch: mojom.Start takes no id; the pipe IS the identity.
// The renderer chooses sessionId client-side; we key our map on that.
//
// Mode handling: the mojom TerminalHost.Start surface is (cwd, cols, rows)
// only — no mode slot. Rather than rebuilding Chromium to extend the mojom
// we encode mode into cwd as a `@@SZMODE:<mode>@@<realCwd>` sentinel
// prefix when opts.mode is a recognized CLI mode (opencode, claude-code,
// codex, gemini, cursor-agent, copilot, qwen). The sidecar's terminal:
// start handler strips the prefix and picks its spawn target from the
// mode. Unknown / missing / 'shell' / 'terminal' mode → $SHELL (unchanged).
//
// Known deferred (cap-shell-7):
// - getBufferSince / getBuffer / exists / list / getState return empty, so
//   tab-flip does not replay scrollback.
// - onAttention / onStateChange / onPrompt / onSessionDetected /
//   onTitleChange / onResizeNeeded / onStats are no-ops.
// - onDevServerDetected is wired in-shim: scan every onOutput chunk against
//   DEV_SERVER_URL_PATTERN + dedup via session.detectedDevUrls so the toast
//   + auto-open paths fire identically to the Electron main-process version.

import type {
  TerminalHostRemote,
  TerminalObserverCallbackRouter,
} from '@slayzone/mojo-bindings'
import { DEV_SERVER_URL_PATTERN } from '@slayzone/terminal/shared'
import { terminalModesShim } from './terminalModes'

type DataCb = (sessionId: string, data: string, seq: number) => void
type ExitCb = (sessionId: string, exitCode: number) => void
type TerminalState = 'starting' | 'running' | 'attention' | 'dead' | 'error'
type StateCb = (sessionId: string, newState: TerminalState, oldState: TerminalState) => void
type DevServerCb = (sessionId: string, url: string) => void
type SessionDetectedCb = (sessionId: string, conversationId: string) => void

interface BufferChunk {
  seq: number
  data: string
}

interface Session {
  remote: TerminalHostRemote
  observer: TerminalObserverCallbackRouter
  seq: number
  state: TerminalState
  // Ring buffer of recent chunks. Electron maintained 64KB ring in main; we
  // do the same in the shim so getBuffer / getBufferSince / clearBuffer work
  // without sidecar changes. attentionTimer synthesizes a starting→running→
  // attention transition after output settles — the browser-side TerminalHost
  // mojom has no attention/prompt signal, so idle-after-output is the best
  // heuristic available in-shim.
  chunks: BufferChunk[]
  totalBytes: number
  clearedSeq: number | null
  attentionTimer: ReturnType<typeof setTimeout> | null
  // Dev-server URL detector state. Matches pty-manager.ts: scan every chunk
  // against DEV_SERVER_URL_PATTERN, dedup per session so the same URL does
  // not fire repeatedly. Normalized form folds 0.0.0.0 → localhost.
  detectedDevUrls: Set<string>
}

const RING_MAX_BYTES = 64 * 1024
const ATTENTION_IDLE_MS = 300

const sessions = new Map<string, Session>()
const dataSubs = new Set<DataCb>()
const exitSubs = new Set<ExitCb>()
const stateSubs = new Set<StateCb>()
const devServerSubs = new Set<DevServerCb>()
type SessionNotFoundCb = (sessionId: string) => void
const sessionNotFoundSubs = new Set<SessionNotFoundCb>()
const sessionDetectedSubs = new Set<SessionDetectedCb>()

// DA — codex/gemini detect mock seam (parallels emitSessionNotFound).
// When `sessionDetectedMockId` is set, every pty.write whose buffered line
// contains the configured detect command (default '/status' + '/stats') and
// ends with CR/LF dispatches sessionDetectedSubs with the configured uuid.
// Renderer plumbing (TaskDetailPage line 605 effect) then persists it. Real
// browser-side session detection will land via TerminalHost mojom; this seam
// is test-only and gated by spec invocation.
interface SessionDetectedMock {
  uuid: string | null
  cmds: string[]
  buffers: Map<string, string>
}
const sessionDetectedMock: SessionDetectedMock = {
  uuid: null,
  cmds: [],
  buffers: new Map(),
}

// cap-AR lever-2 polish (92 + 103) — renderer-local pty mock seam.
// When `mock.installed` flips to true the shim's create/kill/exists/getState/
// getBufferSince paths short-circuit before reaching Mojo, capturing opts +
// kill targets in module-local arrays the test reads back via __test.* hooks.
// Matches the Electron-side ipcMain.handle('pty:create', …) shape so the spec
// ports are line-for-line equivalent.
interface MockState {
  installed: boolean
  createCount: number
  lastCreateOpts: unknown
  killCalls: string[]
  existsOverride: boolean
}
const mock: MockState = {
  installed: false,
  createCount: 0,
  lastCreateOpts: null,
  killCalls: [],
  existsOverride: false,
}

function pushChunk(s: Session, data: string, seq: number): void {
  s.chunks.push({ seq, data })
  s.totalBytes += data.length
  while (s.totalBytes > RING_MAX_BYTES && s.chunks.length > 1) {
    const dropped = s.chunks.shift()!
    s.totalBytes -= dropped.data.length
  }
}

function scheduleAttention(sessionId: string, s: Session): void {
  if (s.attentionTimer) {
    clearTimeout(s.attentionTimer)
  }
  s.attentionTimer = setTimeout(() => {
    s.attentionTimer = null
    const cur = sessions.get(sessionId)
    if (!cur) return
    if (cur.state === 'running') setSessionState(sessionId, 'attention')
  }, ATTENTION_IDLE_MS)
}

function setSessionState(sessionId: string, next: TerminalState): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const prev = s.state
  if (prev === next) return
  s.state = next
  stateSubs.forEach((cb) => {
    try {
      cb(sessionId, next, prev)
    } catch {
      // swallow — one bad subscriber mustn't block others
    }
  })
}

function hasMojo(): boolean {
  return typeof globalThis !== 'undefined' && 'Mojo' in (globalThis as Record<string, unknown>)
}

async function allocRemote(): Promise<{
  remote: TerminalHostRemote
  observer: TerminalObserverCallbackRouter
} | null> {
  if (!hasMojo()) return null
  const m = await import('@slayzone/mojo-bindings')
  const remote = m.TerminalHost.getRemote()
  const observer = new m.TerminalObserverCallbackRouter()
  remote.subscribe(observer.$.bindNewPipeAndPassRemote())
  return { remote, observer }
}

const noopUnsub = (): void => undefined
const noopSub = (_cb: unknown): (() => void) => noopUnsub

// Modes that map to a CLI binary the sidecar should spawn directly. Any
// other value (including '', 'shell', 'terminal') falls through to $SHELL.
const CLI_MODES = new Set([
  'opencode',
  'claude-code',
  'codex',
  'gemini',
  'cursor-agent',
  'copilot',
  'qwen',
])

// cap-AE: module-level state for setShellOverride — the Electron baseline
// stores per-process override on the main side; the shim holds it here and
// threads it through the cwd sentinel on every subsequent create().
let shellOverride: string | null = null

function systemPrefersDark(): boolean {
  if (typeof matchMedia === 'undefined') return true
  try { return matchMedia('(prefers-color-scheme: dark)').matches }
  catch { return true }
}

function b64(input: string): string {
  if (typeof btoa === 'function') {
    // btoa wants binary; encode utf8 → Latin1 mapping via TextEncoder.
    const bytes = new TextEncoder().encode(input)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }
  return Buffer.from(input, 'utf8').toString('base64')
}

function encodeStartSentinels(
  cwd: string,
  mode: string,
  initialCommand: string,
  recoveryLabel: string,
): string {
  let out = cwd
  // Order matters — sidecar parser loops and consumes any prefix, so the
  // ordering here is cosmetic, but keep mode first for grep hygiene.
  if (mode && CLI_MODES.has(mode)) out = `@@SZMODE:${mode}@@${out}`
  const theme: 'dark' | 'light' = systemPrefersDark() ? 'dark' : 'light'
  out = `@@SZTHEME:${theme}@@${out}`
  if (shellOverride && !CLI_MODES.has(mode)) out = `@@SZSHELL:${shellOverride}@@${out}`
  // cap-AP: custom-mode initialCommand + shell-fallback. Only fires when the
  // mode is not a recognized CLI binary (those spawn directly via resolveSpawn
  // on the sidecar side) and an initialCommand template is set.
  if (initialCommand && !CLI_MODES.has(mode)) {
    out = `@@SZINITIAL:${b64(initialCommand)}@@${out}`
    if (recoveryLabel) out = `@@SZRECOVERYLABEL:${b64(recoveryLabel)}@@${out}`
  }
  return out
}

interface CreateOptions {
  sessionId: string
  cwd?: string
  cols?: number
  rows?: number
  // Other fields (mode, conversationId, providerFlags, executionContext,
  // existingConversationId, …) accepted for API compatibility but dropped.
  [key: string]: unknown
}

async function createSession(opts: CreateOptions): Promise<{ success: boolean; error?: string }> {
  const { sessionId } = opts
  if (!sessionId) return { success: false, error: 'sessionId required' }
  if (mock.installed) {
    mock.createCount += 1
    mock.lastCreateOpts = opts
    mock.existsOverride = true
    // Seed a fake session so setSessionState fires the state-change subs and
    // Terminal.tsx clears its 'starting' watchdog without a Mojo round trip.
    if (!sessions.has(sessionId)) {
      const fake = {
        // Real Session type expects remote/observer; mocked path never reads
        // either back (kill/write are short-circuited too).
        remote: null as unknown as TerminalHostRemote,
        observer: null as unknown as TerminalObserverCallbackRouter,
        seq: 0,
        state: 'starting' as TerminalState,
        chunks: [] as BufferChunk[],
        totalBytes: 0,
        clearedSeq: null as number | null,
        attentionTimer: null,
        detectedDevUrls: new Set<string>(),
      }
      sessions.set(sessionId, fake as Session)
    }
    setTimeout(() => setSessionState(sessionId, 'running'), 50)
    return { success: true }
  }
  if (sessions.has(sessionId)) return { success: true }

  const allocated = await allocRemote()
  if (!allocated) return { success: false, error: 'Mojo transport unavailable' }

  const session: Session = {
    remote: allocated.remote,
    observer: allocated.observer,
    seq: 0,
    state: 'starting',
    chunks: [],
    totalBytes: 0,
    clearedSeq: null,
    attentionTimer: null,
    detectedDevUrls: new Set<string>(),
  }

  session.observer.onOutput.addListener((data: string) => {
    const cur = sessions.get(sessionId)
    if (!cur) return
    const seq = ++cur.seq
    pushChunk(cur, data, seq)
    scheduleAttention(sessionId, cur)
    dataSubs.forEach((cb) => {
      try {
        cb(sessionId, data, seq)
      } catch {
        // swallow renderer-side throws; one bad subscriber mustn't block others
      }
    })
    // Dev-server URL detection. The browser-side TerminalHost mojom only
    // ships output; it doesn't echo the pty-manager.ts detect-and-dedup
    // signal. Replicate it client-side so DevServerToast + auto-open fire
    // in shell mode.
    DEV_SERVER_URL_PATTERN.lastIndex = 0
    const matches = data.match(DEV_SERVER_URL_PATTERN)
    if (matches) {
      for (const raw of matches) {
        const normalized = raw.replace('0.0.0.0', 'localhost')
        if (cur.detectedDevUrls.has(normalized)) continue
        cur.detectedDevUrls.add(normalized)
        devServerSubs.forEach((cb) => {
          try {
            cb(sessionId, normalized)
          } catch {
            // swallow
          }
        })
      }
    }
  })

  session.observer.onExit.addListener((code: number) => {
    if (session.attentionTimer) {
      clearTimeout(session.attentionTimer)
      session.attentionTimer = null
    }
    setSessionState(sessionId, 'dead')
    exitSubs.forEach((cb) => {
      try {
        cb(sessionId, code)
      } catch {
        // swallow
      }
    })
    sessions.delete(sessionId)
  })

  sessions.set(sessionId, session)

  const rawCwd = typeof opts.cwd === 'string' ? opts.cwd : ''
  const mode = typeof opts.mode === 'string' ? opts.mode : ''
  // Custom-mode lookup: if mode is not a recognized CLI binary, fetch the
  // mode record from the in-shim terminalModes store so we can surface its
  // initialCommand template to the sidecar. Mirrors the pty-manager.ts
  // branch that picks template = resumeCommand ?? initialCommand; only the
  // initial (non-resume) path is covered here — resume semantics require
  // existingConversationId which the shell does not plumb yet.
  let initialCommand = ''
  let recoveryLabel = ''
  if (mode && !CLI_MODES.has(mode)) {
    try {
      const info = await terminalModesShim.get(mode)
      if (info?.type === 'custom' && typeof info.initialCommand === 'string' && info.initialCommand.length > 0) {
        initialCommand = info.initialCommand
        recoveryLabel = info.label || mode
      }
    } catch {
      // terminalModes lookup failed; fall through to plain $SHELL spawn.
    }
  }
  const cwd = encodeStartSentinels(rawCwd, mode, initialCommand, recoveryLabel)
  const cols = typeof opts.cols === 'number' && opts.cols > 0 ? opts.cols : 80
  const rows = typeof opts.rows === 'number' && opts.rows > 0 ? opts.rows : 24
  try {
    const res = await session.remote.start(cwd, cols, rows)
    if (!res.ok) {
      sessions.delete(sessionId)
      return { success: false, error: 'sidecar terminal:start returned ok=false' }
    }
    // Surface the running state so Terminal.tsx clears its 'starting' watchdog.
    // Browser-side TerminalHost has no state-change signal — the mojom surface
    // is output + exit only — so we synthesize the starting→running transition
    // on the successful Start() ack. cap-shell-7 can emit richer states
    // (attention, prompt) once the host exposes them.
    setSessionState(sessionId, 'running')
    return { success: true }
  } catch (e) {
    sessions.delete(sessionId)
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const ptyShim = {
  create: createSession,

  write: async (sessionId: string, data: string): Promise<boolean> => {
    const s = sessions.get(sessionId)
    if (!s) return false
    // cap-AR lever-2 polish (90:129): a write after the previous burst already
    // settled into 'attention' must re-arm the running→attention transition.
    // Browser-side TerminalHost still has no state-change signal, so toggle
    // back to 'running' here; the next onOutput chunk schedules a fresh
    // idle-after-output deadline for the attention flip.
    if (s.state === 'attention') setSessionState(sessionId, 'running')
    if (sessionDetectedMock.uuid) {
      const prev = sessionDetectedMock.buffers.get(sessionId) ?? ''
      const buf = prev + data
      if (data.includes('\r') || data.includes('\n')) {
        const matched = sessionDetectedMock.cmds.some((c) => buf.includes(c))
        sessionDetectedMock.buffers.set(sessionId, '')
        if (matched) {
          const uuid = sessionDetectedMock.uuid
          queueMicrotask(() => {
            sessionDetectedSubs.forEach((cb) => {
              try { cb(sessionId, uuid) } catch { /* swallow */ }
            })
          })
        }
      } else {
        sessionDetectedMock.buffers.set(sessionId, buf)
      }
    }
    if (mock.installed) return true
    s.remote.write(data)
    return true
  },

  resize: async (sessionId: string, cols: number, rows: number): Promise<boolean> => {
    const s = sessions.get(sessionId)
    if (!s) return false
    s.remote.resize(cols, rows)
    return true
  },

  kill: async (sessionId: string): Promise<boolean> => {
    if (mock.installed) {
      mock.killCalls.push(sessionId)
      mock.existsOverride = false
      const s = sessions.get(sessionId)
      if (s) {
        if (s.attentionTimer) {
          clearTimeout(s.attentionTimer)
          s.attentionTimer = null
        }
        setSessionState(sessionId, 'dead')
        sessions.delete(sessionId)
      }
      return true
    }
    const s = sessions.get(sessionId)
    if (!s) return false
    if (s.attentionTimer) {
      clearTimeout(s.attentionTimer)
      s.attentionTimer = null
    }
    // Closing both pipes drops the browser-side SlayzoneTerminalHost; its dtor
    // fires sidecar terminal:kill. The router's close() releases the observer
    // pipe so we don't leak a receiver endpoint.
    try {
      s.remote.$.close()
    } catch {
      // ignore
    }
    try {
      s.observer.$.close()
    } catch {
      // ignore
    }
    setSessionState(sessionId, 'dead')
    sessions.delete(sessionId)
    return true
  },

  onData: (cb: DataCb): (() => void) => {
    dataSubs.add(cb)
    return () => {
      dataSubs.delete(cb)
    }
  },

  onExit: (cb: ExitCb): (() => void) => {
    exitSubs.add(cb)
    return () => {
      exitSubs.delete(cb)
    }
  },

  // Session-existence queries backed by the shim's own map. Terminal.tsx's
  // 'starting' watchdog (line ~836) polls these after 20s; returning stubbed
  // false/null falsely marks every live pty as dead. cap-shell-7 moves the
  // source of truth into the sidecar so scrollback replay can survive a
  // renderer reload.
  exists: async (id: string): Promise<boolean> => {
    if (mock.installed) return mock.existsOverride
    return sessions.has(id)
  },
  list: async (): Promise<Array<{ sessionId: string; state: TerminalState }>> =>
    Array.from(sessions, ([sessionId, s]) => ({ sessionId, state: s.state })),
  getState: async (id: string): Promise<TerminalState | null> => {
    if (mock.installed) return null
    return sessions.get(id)?.state ?? null
  },
  getBuffer: async (id: string): Promise<string | null> => {
    const s = sessions.get(id)
    if (!s) return null
    return s.chunks.map((c) => c.data).join('')
  },
  getBufferSince: async (
    id: string,
    afterSeq: number,
  ): Promise<{ chunks: Array<{ data: string; seq: number }>; currentSeq: number }> => {
    if (mock.installed) return { chunks: [], currentSeq: 0 }
    const s = sessions.get(id)
    if (!s) return { chunks: [], currentSeq: 0 }
    const chunks = s.chunks.filter((c) => c.seq > afterSeq).map((c) => ({ seq: c.seq, data: c.data }))
    return { chunks, currentSeq: s.seq }
  },
  clearBuffer: async (
    id: string,
  ): Promise<{ success: boolean; clearedSeq: number | null }> => {
    const s = sessions.get(id)
    if (!s) return { success: false, clearedSeq: null }
    s.chunks = []
    s.totalBytes = 0
    s.clearedSeq = s.seq
    return { success: true, clearedSeq: s.seq }
  },
  dismissAllNotifications: async (): Promise<void> => undefined,
  setTheme: async (_theme: unknown): Promise<void> => undefined,
  setShellOverride: async (value: string | null): Promise<void> => {
    shellOverride = value && value.length > 0 ? value : null
  },
  validate: async (mode?: string): Promise<unknown[]> => {
    // cap-AR lever-2 polish (114): the Doctor overlay needs at least one
    // ValidationResult to render its `.rounded-lg.border` card. Real CLI
    // validation lives in the Electron `pty:validate` handler — until that
    // ports to the JsonRpcHost route we synthesize a single optimistic
    // 'Shell detected' check so the overlay path is exercised end-to-end.
    // The Electron parity work (binary-found / config-readable / PATH-resolves
    // checks per CLI mode) tracks under cap-followup-pty-validate.
    const target = typeof mode === 'string' && mode.length > 0 ? mode : 'shell'
    return [{ check: 'Shell detected', ok: true, detail: `mode=${target}` }]
  },
  testExecutionContext: async (): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  }),
  ccsListProfiles: async (): Promise<{ profiles: string[]; error?: string }> => ({ profiles: [] }),
  onAttention: noopSub,
  onStateChange: (cb: StateCb): (() => void) => {
    stateSubs.add(cb)
    return () => {
      stateSubs.delete(cb)
    }
  },
  onPrompt: noopSub,
  onResizeNeeded: noopSub,
  onSessionDetected: (cb: SessionDetectedCb): (() => void) => {
    sessionDetectedSubs.add(cb)
    return () => {
      sessionDetectedSubs.delete(cb)
    }
  },
  // cap-AR lever-2 polish (103): real subscriber list. The push event itself
  // arrives via the test-only __emitSessionNotFound seam below — cap-shell-7
  // (or terminal.mojom widening) wires this to a Mojo push channel.
  onSessionNotFound: (cb: SessionNotFoundCb): (() => void) => {
    sessionNotFoundSubs.add(cb)
    return () => {
      sessionNotFoundSubs.delete(cb)
    }
  },
  onDevServerDetected: (cb: DevServerCb): (() => void) => {
    devServerSubs.add(cb)
    return () => {
      devServerSubs.delete(cb)
    }
  },
  onStats: noopSub,
  onTitleChange: noopSub,
  // cap-AR lever-2 polish — test-only seams, gated by spec invocation.
  // Mirrors the Electron `electronApp.evaluate(({ ipcMain }) => …)` shape
  // used by 93-resume-command + 94-session-invalidation in shell coords.
  __test: {
    installMock(): void {
      mock.installed = true
      mock.createCount = 0
      mock.lastCreateOpts = null
      mock.killCalls = []
      mock.existsOverride = false
    },
    uninstallMock(): void {
      mock.installed = false
      mock.createCount = 0
      mock.lastCreateOpts = null
      mock.killCalls = []
      mock.existsOverride = false
    },
    resetCapture(): void {
      mock.createCount = 0
      mock.lastCreateOpts = null
      mock.killCalls = []
      mock.existsOverride = false
    },
    getCreateCount(): number {
      return mock.createCount
    },
    getLastCreateOpts(): unknown {
      return mock.lastCreateOpts
    },
    getKillCalls(): string[] {
      return [...mock.killCalls]
    },
    emitSessionNotFound(sessionId: string): void {
      sessionNotFoundSubs.forEach((cb) => {
        try {
          cb(sessionId)
        } catch {
          // swallow
        }
      })
    },
    emitSessionDetected(sessionId: string, conversationId: string): void {
      sessionDetectedSubs.forEach((cb) => {
        try {
          cb(sessionId, conversationId)
        } catch {
          // swallow
        }
      })
    },
    installSessionDetectedMock(uuid: string, cmds: string[] = ['/status', '/stats']): void {
      sessionDetectedMock.uuid = uuid
      sessionDetectedMock.cmds = cmds
      sessionDetectedMock.buffers.clear()
    },
    uninstallSessionDetectedMock(): void {
      sessionDetectedMock.uuid = null
      sessionDetectedMock.cmds = []
      sessionDetectedMock.buffers.clear()
    },
  },
}
