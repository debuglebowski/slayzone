import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { app, BrowserWindow, Notification, nativeTheme } from 'electron'
import { homedir, platform, userInfo } from 'os'
import type { Database } from 'better-sqlite3'
import { DEV_SERVER_URL_PATTERN } from '@slayzone/terminal/shared'
import type { TerminalState, PtyInfo, BufferSinceResult } from '@slayzone/terminal/shared'
import { getDiagnosticsConfig, recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import { RingBuffer, type BufferChunk } from './ring-buffer'
import { getAdapter, type TerminalMode, type TerminalAdapter, type SpawnConfig, type ActivityState, type ErrorInfo, type ExecutionContext } from './adapters'
import { interpolateTemplate } from './adapters/template-interpolation'
import { StateMachine, activityToTerminalState } from './state-machine'
import { quoteForShell, buildExecCommand, resolveUserShell, getShellStartupArgs } from './shell-env'

// Database reference for notifications
let db: Database | null = null

export function setDatabase(database: Database): void {
  db = database
}

// Hold references to active notifications keyed by sessionId so we can dismiss them
const activeNotifications = new Map<string, Notification>()

function dismissNotification(sessionId: string): void {
  const existing = activeNotifications.get(sessionId)
  if (existing) {
    existing.close()
    activeNotifications.delete(sessionId)
  }
}

export function dismissAllNotifications(): void {
  for (const [, n] of activeNotifications) {
    n.close()
  }
  activeNotifications.clear()
}

function showTaskAttentionNotification(sessionId: string): void {
  if (!db) return

  // Check if desktop notifications are enabled
  const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('notificationPanelState') as { value: string } | undefined
  if (settingsRow?.value) {
    try {
      const state = JSON.parse(settingsRow.value)
      if (!state.desktopEnabled) return
    } catch {
      return
    }
  } else {
    return // No settings = disabled by default
  }

  dismissNotification(sessionId)

  const session = sessions.get(sessionId)
  const taskId = session?.taskId ?? taskIdFromSessionId(sessionId)
  const taskRow = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined
  if (taskRow?.title) {
    let label = 'Terminal'
    const modeInfo = db.prepare('SELECT label FROM terminal_modes WHERE id = ?').get(session?.mode ?? '') as { label: string } | undefined
    if (modeInfo) {
      label = modeInfo.label
    }
    
    const notification = new Notification({
      title: taskRow.title,
      body: `${label} needs attention`
    })
    activeNotifications.set(sessionId, notification)
    const cleanup = (): void => { activeNotifications.delete(sessionId) }
    notification.on('click', () => {
      cleanup()
      app.focus({ steal: true })
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('app:open-task', taskId)
      }
    })
    notification.on('close', cleanup)
    notification.show()
  }
}

export type { BufferChunk }

interface PtySession {
  win: BrowserWindow
  pty: pty.IPty
  sessionId: string
  taskId: string
  mode: TerminalMode
  adapter: TerminalAdapter
  checkingForSessionError?: boolean
  buffer: RingBuffer
  lastOutputTime: number
  state: TerminalState
  // CLI state tracking
  activity: ActivityState
  error: ErrorInfo | null
  // /status monitoring
  inputBuffer: string
  watchingForSessionId: boolean
  statusOutputBuffer: string
  statusWatchTimeout?: NodeJS.Timeout
  sessionIdAutoDetectTimer?: NodeJS.Timeout
  // Dev server URL dedup
  detectedDevUrls: Set<string>
  // Pending partial escape sequence from previous onData chunk
  syncQueryPending: string
}

export type { PtyInfo }

const sessions = new Map<string, PtySession>()
const stateMachine = new StateMachine((sessionId, newState, oldState) => {
  const session = sessions.get(sessionId)
  if (!session) return
  // Sync session.state for debounced transitions (timer fires after transitionState returns)
  session.state = newState
  emitStateChange(session, sessionId, newState, oldState)
})

// Maximum buffer size (5MB) per session
const MAX_BUFFER_SIZE = 5 * 1024 * 1024

// Idle timeout in milliseconds (60 seconds)
const IDLE_TIMEOUT_MS = 60 * 1000

// Check interval for idle sessions (10 seconds)
const IDLE_CHECK_INTERVAL_MS = 10 * 1000
const STARTUP_TIMEOUT_MS = 10 * 1000
const FAST_EXIT_FALLBACK_WINDOW_MS = 2000
const SESSION_ID_WATCH_TIMEOUT_MS = 5000
// Delay after first PTY output before auto-sending session detection command
const SESSION_ID_AUTO_DETECT_DELAY_MS = 3000

// Reference to main window for sending idle events
let mainWindow: BrowserWindow | null = null

// Interval reference for idle checker
let idleCheckerInterval: NodeJS.Timeout | null = null

function taskIdFromSessionId(sessionId: string): string {
  return sessionId.split(':')[0] || sessionId
}

// Theme colors used to respond to OSC 10/11/12 color queries synchronously.
// Set by the renderer via pty:set-theme IPC whenever the theme changes.
interface TerminalTheme { foreground: string; background: string; cursor: string }
let currentTerminalTheme: TerminalTheme = { foreground: '#ffffff', background: '#000000', cursor: '#ffffff' }

export function setTerminalTheme(theme: TerminalTheme): void {
  currentTerminalTheme = theme
}

function hexToOscRgb(hex: string): string {
  const r = hex.slice(1, 3)
  const g = hex.slice(3, 5)
  const b = hex.slice(5, 7)
  return `rgb:${r}${r}/${g}${g}/${b}${b}`
}

// Filter out terminal escape sequences that cause issues
function filterBufferData(data: string): string {
  return data
    // Strip title-setting (0,1,2) and clipboard (52) OSC sequences
    .replace(/\x1b\](?:[012]|52)[;][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Filter underline from ANY SGR sequence (handles combined codes like ESC[1;4m)
    // Claude Code outputs these and they persist incorrectly in xterm.js
    .replace(/\x1b\[([0-9;:]*)m/g, (_match, params) => {
      if (!params) return '\x1b[m'
      // Split only by semicolon - colon is subparameter separator (4:3 = curly underline)
      const filtered = params.split(';')
        .filter((p: string) => p !== '4' && !p.startsWith('4:'))
        .join(';')
      return filtered ? `\x1b[${filtered}m` : ''
    })
}

// Intercept timing-critical terminal queries synchronously in the PTY onData handler.
// CPR/DA/DSR must be answered before the program proceeds to readline mode.
// An async renderer round-trip would arrive too late — the response bytes would then
// appear as garbage text in the user's prompt.
// OSC color queries (10/11/12) are also handled here using the cached theme.
//
// Split sequences: OSC/CSI sequences can arrive split across two onData calls.
// session.syncQueryPending carries any trailing incomplete sequence to the next call.
function interceptSyncQueries(session: PtySession, data: string): string {
  // Prepend any incomplete sequence carried from the previous chunk
  let input = session.syncQueryPending + data
  session.syncQueryPending = ''

  let response = ''

  // DA1 — Primary Device Attributes
  input = input.replace(/\x1b\[0?c/g, () => { response += '\x1b[?62;4;22c'; return '' })
  // DA2 — Secondary Device Attributes
  input = input.replace(/\x1b\[>0?c/g, () => { response += '\x1b[>0;10;1c'; return '' })
  // DSR — Device Status Report
  input = input.replace(/\x1b\[5n/g, () => { response += '\x1b[0n'; return '' })
  // CPR — Cursor Position. Respond with row=1 col=1. Programs (readline) use CPR mainly
  // to check if the cursor is at col=1 before drawing a prompt. In practice the terminal
  // is at col=1 at this point (startup output ends with a newline).
  input = input.replace(/\x1b\[6n/g, () => { response += '\x1b[1;1R'; return '' })

  // OSC 10/11/12 — Foreground / Background / Cursor color queries.
  // Answered using the theme last set by the renderer via pty:set-theme.
  input = input.replace(/\x1b\]10;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]10;${hexToOscRgb(currentTerminalTheme.foreground)}\x07`
    return ''
  })
  input = input.replace(/\x1b\]11;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]11;${hexToOscRgb(currentTerminalTheme.background)}\x07`
    return ''
  })
  input = input.replace(/\x1b\]12;\?(?:\x07|\x1b\\)/g, () => {
    response += `\x1b]12;${hexToOscRgb(currentTerminalTheme.cursor)}\x07`
    return ''
  })

  if (response) {
    session.pty.write(response)
  }

  // Check for a trailing incomplete OSC or CSI sequence that may complete in the next chunk.
  // OSC: ESC ] <body> — body ends with BEL or ST (ESC \). Trailing ESC alone could be ST start.
  // CSI: ESC [ <params> — ends with a letter in range @–~.
  const partial = input.match(/\x1b(?:\][^\x07\x1b]*\x1b?|\[[0-9;:>]*)?$/)
  if (partial?.[0]) {
    session.syncQueryPending = partial[0]
    input = input.slice(0, -partial[0].length)
  }

  return input
}

function stripAnsiForSessionParse(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[()][AB012]/g, '') // Character set sequences
}

// Emit state change via IPC
function emitStateChange(session: PtySession, sessionId: string, newState: TerminalState, oldState: TerminalState): void {
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.state_change',
    sessionId,
    taskId: taskIdFromSessionId(sessionId),
    message: `${oldState} -> ${newState}`,
    payload: {
      oldState,
      newState
    }
  })

  if (oldState === 'running' && newState === 'attention') {
    showTaskAttentionNotification(sessionId)
  } else if (oldState === 'attention' && newState !== 'attention') {
    dismissNotification(sessionId)
  }
  if (session.win && !session.win.isDestroyed()) {
    try {
      session.win.webContents.send('pty:state-change', sessionId, newState, oldState)
      if (newState === 'attention') {
        session.win.webContents.send('pty:attention', sessionId)
      }
    } catch { /* Window destroyed */ }
  }
}

// Delegate state transitions to the extracted state machine
// (asymmetric debounce: immediate for 'running', 500ms for running→attention, 100ms for others)
function transitionState(sessionId: string, newState: TerminalState): void {
  const session = sessions.get(sessionId)
  if (!session) return
  // Keep session.state in sync for code that reads it directly
  stateMachine.setState(sessionId, session.state)
  stateMachine.transition(sessionId, newState)
  // Update session.state from state machine (immediate transitions update synchronously)
  session.state = stateMachine.getState(sessionId) ?? session.state
}

// Check for inactive sessions and transition state (fallback timeout)
function checkInactiveSessions(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    const timeout = session.adapter.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    const inactiveTime = now - session.lastOutputTime
    if (inactiveTime >= timeout && session.state === 'running') {
      session.activity = 'attention'
      transitionState(sessionId, 'attention')
    }
  }
}

// Start the inactivity checker interval
export function startIdleChecker(win: BrowserWindow): void {
  mainWindow = win
  if (idleCheckerInterval) {
    clearInterval(idleCheckerInterval)
  }
  idleCheckerInterval = setInterval(checkInactiveSessions, IDLE_CHECK_INTERVAL_MS)
}

// Stop the inactivity checker
export function stopIdleChecker(): void {
  if (idleCheckerInterval) {
    clearInterval(idleCheckerInterval)
    idleCheckerInterval = null
  }
  mainWindow = null
}

// ---------------------------------------------------------------------------
// Execution context: transport wrapping for docker/ssh
// ---------------------------------------------------------------------------

interface TransportSpawn {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

function buildTransportSpawn(
  ctx: ExecutionContext | null | undefined,
  cwd: string,
  env: Record<string, string>,
  adapterEnv: Record<string, string>,
  mcpEnv: Record<string, string>
): TransportSpawn | null {
  if (!ctx || ctx.type === 'host') return null // use default spawn path

  if (ctx.type === 'docker') {
    const workdir = ctx.workdir || cwd
    const containerShell = ctx.shell || '/bin/bash'
    const dockerArgs = ['exec', '-it']

    // Forward adapter + MCP env vars via -e flags
    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      dockerArgs.push('-e', `${k}=${v}`)
    }
    // Rewrite MCP host so CLI can reach the host's MCP server from inside container
    dockerArgs.push('-e', 'SLAYZONE_MCP_HOST=host.docker.internal')
    dockerArgs.push('-w', workdir, '--', ctx.container, containerShell, '-i', '-l')

    return { file: 'docker', args: dockerArgs, cwd: homedir(), env }
  }

  if (ctx.type === 'ssh') {
    const workdir = ctx.workdir || cwd
    const remoteShell = ctx.shell || '/bin/bash'
    const mcpPort = (globalThis as Record<string, unknown>).__mcpPort as number | undefined

    const sshArgs = ['-t']
    // Reverse port forward so remote CLI can reach host MCP server
    if (mcpPort) {
      sshArgs.push('-R', `${mcpPort}:localhost:${mcpPort}`)
    }
    sshArgs.push('--', ctx.target)

    // Build remote command: cd + export env + launch shell
    const parts: string[] = [`cd ${quoteForShell(workdir)}`]
    for (const [k, v] of Object.entries({ ...adapterEnv, ...mcpEnv })) {
      parts.push(`export ${k}=${quoteForShell(v)}`)
    }
    if (mcpPort) {
      parts.push(`export SLAYZONE_MCP_HOST=localhost`)
    }
    parts.push(`${quoteForShell(remoteShell)} -i -l`)
    sshArgs.push(parts.join(' && '))

    return { file: 'ssh', args: sshArgs, cwd: homedir(), env }
  }

  return null
}

export function testExecutionContext(
  context: ExecutionContext
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (context.type === 'host') {
      resolve({ success: true })
      return
    }

    const cmd = context.type === 'docker' ? 'docker' : 'ssh'
    const args = context.type === 'docker'
      ? ['exec', '--', context.container, 'echo', 'ok']
      : ['-o', 'ConnectTimeout=5', '--', context.target, 'echo', 'ok']

    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      if (err) {
        resolve({ success: false, error: (err as Error).message })
      } else {
        resolve({ success: true })
      }
    })
  })
}

export interface CreatePtyOptions {
  win: BrowserWindow
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  providerArgs?: string[]
  executionContext?: ExecutionContext | null
  type?: string
  initialCommand?: string | null
  resumeCommand?: string | null
  defaultFlags?: string | null
  patternAttention?: string | null
  patternWorking?: string | null
  patternError?: string | null
}

export async function createPty(opts: CreatePtyOptions): Promise<{ success: boolean; error?: string }> {
  const { win, sessionId, cwd, conversationId, existingConversationId, mode, initialPrompt, providerArgs, executionContext, type, initialCommand, resumeCommand, defaultFlags, patternAttention, patternWorking, patternError } = opts
  const taskId = taskIdFromSessionId(sessionId)
  const createStartedAt = Date.now()
  let spawnAttempt: { shell: string; shellArgs: string[]; hasPostSpawnCommand: boolean } | null = null
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.create',
    sessionId,
    taskId,
    payload: {
      mode: mode ?? null,
      type: type ?? null,
      initialCommand: initialCommand ?? null,
      resumeCommand: resumeCommand ?? null,
      defaultFlags: defaultFlags ?? null,
      patternAttention: patternAttention ?? null,
      patternWorking: patternWorking ?? null,
      patternError: patternError ?? null,
      providerArgs: providerArgs ?? [],
      hasConversationId: Boolean(conversationId),
      hasExistingConversationId: Boolean(existingConversationId)
    }
  })

  // Kill existing if any
  if (sessions.has(sessionId)) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.replace_existing',
      sessionId,
      taskId
    })
    killPty(sessionId)
  }

  try {
    const terminalMode = mode || 'claude-code'
    const adapter = getAdapter({
      mode: terminalMode,
      type,
      patterns: { attention: patternAttention, working: patternWorking, error: patternError }
    })
    const resuming = !!existingConversationId
    const effectiveConversationId = existingConversationId || conversationId

    // Pick template: resume if resuming and resume_command exists, otherwise initial
    const template = (resuming && resumeCommand) ? resumeCommand : (initialCommand || undefined)

    // Build spawn config via template interpolation
    const shell = resolveUserShell()
    const shellConfig = { shell, args: getShellStartupArgs(shell) }
    let postSpawnCommand: string | undefined
    if (template) {
      const binary = interpolateTemplate({
        template,
        conversationId: effectiveConversationId || undefined,
        flags: providerArgs ?? [],
        initialPrompt: initialPrompt || undefined
      })
      const allArgs = [...binary.args]
      if (binary.initialPrompt) allArgs.push(binary.initialPrompt)
      postSpawnCommand = buildExecCommand(binary.name, allArgs)
    }
    const spawnConfig: SpawnConfig = { ...shellConfig, postSpawnCommand }

    spawnAttempt = {
      shell: spawnConfig.shell,
      shellArgs: spawnConfig.args,
      hasPostSpawnCommand: Boolean(spawnConfig.postSpawnCommand)
    }
    recordDiagnosticEvent({
      level: 'info',
      source: 'pty',
      event: 'pty.spawn_config',
      sessionId,
      taskId,
      payload: {
        launchStrategy: spawnConfig.postSpawnCommand ? 'shell_exec' : 'direct_shell',
        shell: spawnConfig.shell,
        shellArgs: spawnConfig.args,
        hasPostSpawnCommand: Boolean(spawnConfig.postSpawnCommand)
      }
    })

    // Inject MCP env vars so AI terminals know their task and MCP server
    const mcpEnv: Record<string, string> = {}
    if (taskId) mcpEnv.SLAYZONE_TASK_ID = taskId
    const mcpPort = (globalThis as Record<string, unknown>).__mcpPort as number | undefined
    if (mcpPort) mcpEnv.SLAYZONE_MCP_PORT = String(mcpPort)

    const baseEnv = {
      ...process.env,
      USER: process.env.USER || process.env.USERNAME || userInfo().username,
      HOME: process.env.HOME || homedir(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLORFGBG: nativeTheme.shouldUseDarkColors ? '15;0' : '0;15',
      TERM_BACKGROUND: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    } as Record<string, string>

    // Check for docker/ssh transport wrapping
    const transport = buildTransportSpawn(
      executionContext,
      cwd || homedir(),
      baseEnv,
      spawnConfig.env ?? {},
      mcpEnv
    )

    const spawnOptions = {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: transport ? transport.cwd : (cwd || homedir()),
      env: transport ? transport.env : {
        ...baseEnv,
        ...spawnConfig.env,
        ...mcpEnv
      } as Record<string, string>
    }

    const spawnFile = transport ? transport.file : spawnConfig.shell
    const initialArgs = transport ? [...transport.args] : [...spawnConfig.args]

    // When a post-spawn command is present, pass it via -c flag instead of
    // writing to stdin after a delay.  This prevents shell init prompts
    // (e.g. oh-my-zsh update [Y/n]) from consuming/corrupting the command.
    const directExec = !transport && !!spawnConfig.postSpawnCommand && platform() !== 'win32'
    if (directExec) {
      initialArgs.push('-c', spawnConfig.postSpawnCommand!)
    }

    const canRetryInteractiveOnly = !transport && initialArgs.includes('-i') && initialArgs.includes('-l')
    let usedArgs = [...initialArgs]
    let usedFallback = false
    const spawnStartTs = Date.now()
    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(spawnFile, initialArgs, spawnOptions)
    } catch (err) {
      // Fallback for shells that reject login flag combinations (host only).
      if (!canRetryInteractiveOnly) throw err
      usedArgs = initialArgs.filter((arg) => arg !== '-l')
      ptyProcess = pty.spawn(spawnFile, usedArgs, spawnOptions)
      usedFallback = true
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'pty.spawn_fallback',
        sessionId,
        taskId: taskIdFromSessionId(sessionId),
        message: (err as Error).message,
        payload: {
          shell: spawnConfig.shell,
          fromArgs: initialArgs,
          toArgs: usedArgs
        }
      })
    }
    const shellSpawnMs = Date.now() - spawnStartTs

    sessions.set(sessionId, {
      win,
      pty: ptyProcess,
      sessionId,
      taskId,
      mode: terminalMode,
      adapter,
      // Only check for session errors if we're trying to resume
      checkingForSessionError: resuming,
      buffer: new RingBuffer(MAX_BUFFER_SIZE),
      lastOutputTime: Date.now(),
      state: 'starting',
      // CLI state tracking
      activity: 'unknown',
      error: null,
      // /status monitoring
      inputBuffer: '',
      watchingForSessionId: false,
      statusOutputBuffer: '',
      // Dev server URL dedup
      detectedDevUrls: new Set(),
      syncQueryPending: ''
    })
    stateMachine.register(sessionId, 'starting')
    let firstOutputTs: number | null = null
    let commandDispatchedTs: number | null = null
    let startupTimeout: NodeJS.Timeout | undefined
    let earlyExitWatchdog: NodeJS.Timeout | undefined

    const clearStartupTimeout = (): void => {
      if (!startupTimeout) return
      clearTimeout(startupTimeout)
      startupTimeout = undefined
    }

    const clearEarlyExitWatchdog = (): void => {
      if (!earlyExitWatchdog) return
      clearTimeout(earlyExitWatchdog)
      earlyExitWatchdog = undefined
    }

    const finalizeSessionExit = (exitCode: number): void => {
      clearStartupTimeout()
      clearEarlyExitWatchdog()
      // Clear auto-detect timer if pending
      const exitSession = sessions.get(sessionId)
      if (exitSession?.sessionIdAutoDetectTimer) {
        clearTimeout(exitSession.sessionIdAutoDetectTimer)
      }
      dismissNotification(sessionId)
      transitionState(sessionId, 'dead')
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.exit',
        sessionId,
        taskId: taskIdFromSessionId(sessionId),
        payload: {
          exitCode
        }
      })
      // Delay session cleanup so any trailing onData events (buffered in the PTY fd)
      // can still be processed and forwarded to the renderer before we drop the session.
      setTimeout(() => {
        sessions.delete(sessionId)
      }, 100)
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('pty:exit', sessionId, exitCode)
        } catch {
          // Window destroyed, ignore
        }
      }
    }

    const armStartupTimeout = (target: pty.IPty): void => {
      clearStartupTimeout()
      startupTimeout = setTimeout(() => {
        const live = sessions.get(sessionId)
        if (!live || live.pty !== target || firstOutputTs !== null) return
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.startup_timeout',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: {
            timeoutMs: STARTUP_TIMEOUT_MS,
            shell: spawnConfig.shell,
            shellArgs: usedArgs,
            launchStrategy: spawnConfig.postSpawnCommand ? 'shell_exec' : 'direct_shell'
          }
        })
        try {
          target.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, STARTUP_TIMEOUT_MS)
    }

    const schedulePostSpawnCommand = (target: pty.IPty): void => {
      if (!spawnConfig.postSpawnCommand) return
      // When using -c (directExec), the command is already in the shell args —
      // no need to write to stdin.
      if (directExec) {
        commandDispatchedTs = Date.now()
        return
      }
      // Fallback for Windows: delay to let shell initialize
      setTimeout(() => {
        const live = sessions.get(sessionId)
        if (!live || live.pty !== target) return
        commandDispatchedTs = Date.now()
        target.write(`${spawnConfig.postSpawnCommand}\r`)
      }, 250)
    }

    // Transition out of 'starting' once setup completes
    // (pty.spawn is synchronous, so process is already running)
    setImmediate(() => {
      const session = sessions.get(sessionId)
      if (session?.state === 'starting') {
        session.activity = 'attention'
        transitionState(sessionId, 'attention')
      }
    })

    const attachPtyHandlers = (target: pty.IPty): void => {
      // Forward data to renderer
      target.onData((data0) => {
        if (firstOutputTs === null) {
          firstOutputTs = Date.now()
          clearStartupTimeout()
          recordDiagnosticEvent({
            level: 'info',
            source: 'pty',
            event: 'pty.startup_timing',
            sessionId,
            taskId: taskIdFromSessionId(sessionId),
            payload: {
              shellSpawnMs,
              firstOutputMs: firstOutputTs - createStartedAt,
              firstOutputAfterCommandMs: commandDispatchedTs ? firstOutputTs - commandDispatchedTs : null,
              usedFallback,
              shell: spawnConfig.shell,
              shellArgs: usedArgs
            }
          })

          // Auto-detect session ID from disk for providers that support it.
          // Avoids injecting commands into the terminal — reads session files
          // that the CLI creates on startup (e.g. ~/.codex/sessions/).
          if (adapter.detectSessionFromDisk && !resuming) {
            const timer = setTimeout(async () => {
              const sess = sessions.get(sessionId)
              if (!sess || sess.pty !== target) return

              try {
                const detected = await adapter.detectSessionFromDisk!(createStartedAt, cwd)
                if (!detected) return
                const liveSess = sessions.get(sessionId)
                if (!liveSess || liveSess.pty !== target) return

                recordDiagnosticEvent({
                  level: 'info',
                  source: 'pty',
                  event: 'pty.conversation_detected',
                  sessionId,
                  taskId: taskIdFromSessionId(sessionId),
                  payload: { conversationId: detected, method: 'disk' }
                })
                if (!win.isDestroyed()) {
                  try {
                    win.webContents.send('pty:session-detected', sessionId, detected)
                  } catch {
                    // Window destroyed, ignore
                  }
                }
              } catch {
                // Filesystem detection failed — banner fallback still available
              }
            }, SESSION_ID_AUTO_DETECT_DELAY_MS)

            const sess = sessions.get(sessionId)
            if (sess) sess.sessionIdAutoDetectTimer = timer
          }
        }
        // Only process if session still exists (prevents data leaking after kill)
        const session = sessions.get(sessionId)
        if (!session || session.pty !== target) {
          recordDiagnosticEvent({
            level: 'warn',
            source: 'pty',
            event: 'pty.data_without_session',
            sessionId,
            taskId: taskIdFromSessionId(sessionId),
            payload: {
              length: data0.length
            }
          })
          return
        }

        // Intercept all terminal queries synchronously before data reaches the renderer.
        // An async renderer round-trip would arrive too late — once readline is active,
        // late response bytes appear as garbage text in the user's prompt.
        const data = interceptSyncQueries(session, data0)

        // Append to buffer for history restoration (filter problematic sequences)
        const seq = session.buffer.append(filterBufferData(data))
        // Track current seq for IPC emission
        const currentSeq = seq

        // Use adapter for activity detection
        const detectedActivity = session.adapter.detectActivity(data, session.activity)

      // Update idle tracking: for transitionOnInput adapters (full-screen TUIs that
      // redraw constantly), only update on meaningful activity detection. Otherwise
      // the idle timer never fires because lastOutputTime keeps refreshing.
      if (!session.adapter.transitionOnInput || detectedActivity) {
        session.lastOutputTime = Date.now()
      }

      if (detectedActivity) {
        session.activity = detectedActivity
        // Clear error state on valid activity (recovery from error)
        if (session.error && detectedActivity !== 'unknown') {
          session.error = null
        }
        // Map activity to TerminalState for backward compatibility
        const newState = activityToTerminalState(detectedActivity)
        if (newState) transitionState(sessionId, newState)
      } else if (session.state === 'starting') {
        // No spinner detected from 'starting' - assume attention (Claude showing prompt)
        session.activity = 'attention'
        transitionState(sessionId, 'attention')
      }
      // Note: Don't auto-transition from 'attention' to 'running' on any output.
      // Claude CLI outputs cursor/ANSI codes while waiting. Let detectActivity
      // handle the transition when it sees actual work (spinner chars).

      // Use adapter for error detection
      const detectedError = session.adapter.detectError(data)
      if (detectedError) {
        session.error = detectedError
        session.checkingForSessionError = false
        transitionState(sessionId, 'error')
        recordDiagnosticEvent({
          level: 'error',
          source: 'pty',
          event: 'pty.adapter_error',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          message: detectedError.message,
          payload: {
            code: detectedError.code,
            rawLength: data.length
          }
        })
        if (!win.isDestroyed() && detectedError.code === 'SESSION_NOT_FOUND') {
          try {
            win.webContents.send('pty:session-not-found', sessionId)
          } catch {
            // Window destroyed, ignore
          }
        }
      }

      // Check for prompts
      const prompt = session.adapter.detectPrompt(data)
      if (prompt && !win.isDestroyed()) {
        try {
          win.webContents.send('pty:prompt', sessionId, prompt)
        } catch {
          // Window destroyed, ignore
        }
      }

      if (!win.isDestroyed()) {
        try {
          // Filter problematic sequences before sending to renderer
          const cleanData = filterBufferData(data)
          win.webContents.send('pty:data', sessionId, cleanData, currentSeq)
        } catch {
          // Window destroyed between check and send, ignore
        }
      }

      // Detect dev server URLs (localhost/127.0.0.1/0.0.0.0 with port)
      DEV_SERVER_URL_PATTERN.lastIndex = 0
      const urlMatches = data.match(DEV_SERVER_URL_PATTERN)
      if (urlMatches && !win.isDestroyed()) {
        for (const url of urlMatches) {
          const normalized = url.replace('0.0.0.0', 'localhost')
          if (!session.detectedDevUrls.has(normalized)) {
            session.detectedDevUrls.add(normalized)
            try {
              win.webContents.send('pty:dev-server-detected', sessionId, normalized)
            } catch {
              // Window destroyed, ignore
            }
          }
        }
      }

      // Parse conversation ID from /status output
      if (session.watchingForSessionId) {
        session.statusOutputBuffer += data

        const normalizedStatusOutput = stripAnsiForSessionParse(session.statusOutputBuffer)
        const labeledSessionMatch = normalizedStatusOutput.match(
          /(?:^|\n)\s*session:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/im
        )
        const uuidMatch = labeledSessionMatch ?? normalizedStatusOutput.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        )
        if (uuidMatch) {
          const detectedConversationId = uuidMatch[1] ?? uuidMatch[0]
          recordDiagnosticEvent({
            level: 'info',
            source: 'pty',
            event: 'pty.conversation_detected',
            sessionId,
            taskId: taskIdFromSessionId(sessionId),
            payload: {
              conversationId: detectedConversationId
            }
          })
          if (!win.isDestroyed()) {
            try {
              win.webContents.send('pty:session-detected', sessionId, detectedConversationId)
            } catch {
              // Window destroyed, ignore
            }
          }
          session.watchingForSessionId = false
          session.statusOutputBuffer = ''
          if (session.statusWatchTimeout) {
            clearTimeout(session.statusWatchTimeout)
            session.statusWatchTimeout = undefined
          }
        }
      }

        const config = getDiagnosticsConfig()
        recordDiagnosticEvent({
          level: 'debug',
          source: 'pty',
          event: 'pty.data',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: config.includePtyOutput
            ? { length: data.length, data }
            : { length: data.length, included: false }
        })
      })

      target.onExit(({ exitCode }) => {
        clearStartupTimeout()
        clearEarlyExitWatchdog()

        const session = sessions.get(sessionId)
        if (!session || session.pty !== target) return

        const canAsyncFallback = canRetryInteractiveOnly && !usedFallback && firstOutputTs === null && (Date.now() - createStartedAt) <= FAST_EXIT_FALLBACK_WINDOW_MS
        if (canAsyncFallback) {
          const fallbackArgs = initialArgs.filter((arg) => arg !== '-l')
          try {
            const fallbackPty = pty.spawn(spawnConfig.shell, fallbackArgs, spawnOptions)
            usedArgs = fallbackArgs
            usedFallback = true
            ptyProcess = fallbackPty
            session.pty = fallbackPty
            recordDiagnosticEvent({
              level: 'warn',
              source: 'pty',
              event: 'pty.spawn_fallback',
              sessionId,
              taskId: taskIdFromSessionId(sessionId),
              message: `Fast exit (${String(exitCode)}) without output; retrying without -l`,
              payload: {
                shell: spawnConfig.shell,
                fromArgs: initialArgs,
                toArgs: fallbackArgs,
                reason: 'fast_exit_no_output'
              }
            })
            armStartupTimeout(fallbackPty)
            attachPtyHandlers(fallbackPty)
            schedulePostSpawnCommand(fallbackPty)
            return
          } catch (fallbackErr) {
            recordDiagnosticEvent({
              level: 'error',
              source: 'pty',
              event: 'pty.spawn_fallback_failed',
              sessionId,
              taskId: taskIdFromSessionId(sessionId),
              message: (fallbackErr as Error).message,
              payload: {
                shell: spawnConfig.shell,
                attemptedArgs: fallbackArgs
              }
            })
          }
        }

        finalizeSessionExit(exitCode)
      })
    }

    attachPtyHandlers(ptyProcess)
    armStartupTimeout(ptyProcess)
    schedulePostSpawnCommand(ptyProcess)
    // Recover from rare race where an ultra-fast child can exit before handlers are attached.
    earlyExitWatchdog = setTimeout(() => {
      const session = sessions.get(sessionId)
      if (!session || firstOutputTs !== null) return
      const pid = session.pty.pid
      if (typeof pid !== 'number' || pid <= 0) {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.missed_exit_recovered',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: { reason: 'invalid_pid' }
        })
        finalizeSessionExit(-1)
        return
      }
      try {
        process.kill(pid, 0)
      } catch {
        recordDiagnosticEvent({
          level: 'warn',
          source: 'pty',
          event: 'pty.missed_exit_recovered',
          sessionId,
          taskId: taskIdFromSessionId(sessionId),
          payload: { reason: 'pid_not_running', pid }
        })
        finalizeSessionExit(-1)
      }
    }, 300)

    // Stop checking for session errors after 5 seconds
    if (resuming) {
      setTimeout(() => {
        const session = sessions.get(sessionId)
        if (session) {
          session.checkingForSessionError = false
        }
      }, 5000)
    }

    return { success: true }
  } catch (error) {
    const err = error as Error
    recordDiagnosticEvent({
      level: 'error',
      source: 'pty',
      event: 'pty.create_failed',
      sessionId,
      taskId: taskIdFromSessionId(sessionId),
      message: err.message,
      payload: {
        stack: err.stack ?? null,
        launchStrategy: spawnAttempt?.hasPostSpawnCommand ? 'shell_exec' : 'direct_shell',
        shell: spawnAttempt?.shell ?? null,
        shellArgs: spawnAttempt?.shellArgs ?? null
      }
    })
    return { success: false, error: err.message }
  }
}


export function writePty(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false

  // Buffer input to detect commands
  session.inputBuffer += data

  // On Enter: transition TUI to 'working' if adapter opts in
  const hasNewline = data.includes('\r') || data.includes('\n')
  if (hasNewline) {
    if (session.adapter.transitionOnInput && session.inputBuffer.trim().length > 0 && session.state !== 'running') {
      session.activity = 'working'
      session.lastOutputTime = Date.now() // reset idle timer from input submission
      transitionState(sessionId, 'running')
    }
    const cmd = session.adapter.sessionIdCommand ?? '/status'
    if (session.inputBuffer.includes(cmd)) {
      if (session.statusWatchTimeout) {
        clearTimeout(session.statusWatchTimeout)
        session.statusWatchTimeout = undefined
      }
      session.watchingForSessionId = true
      session.statusOutputBuffer = ''

      // Stop watching after timeout
      session.statusWatchTimeout = setTimeout(() => {
        if (session.watchingForSessionId) {
          session.watchingForSessionId = false
          session.statusOutputBuffer = ''
          session.statusWatchTimeout = undefined
        }
      }, SESSION_ID_WATCH_TIMEOUT_MS)
    }
    session.inputBuffer = '' // reset on enter
  }

  session.pty.write(data)
  return true
}

export function resizePty(sessionId: string, cols: number, rows: number): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  // Validate bounds to prevent crashes
  const safeCols = Math.max(1, Math.min(cols, 500))
  const safeRows = Math.max(1, Math.min(rows, 500))
  try {
    session.pty.resize(safeCols, safeRows)
  } catch (error) {
    // PTY fd may be invalid if process died — non-fatal
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.resize_failed',
      sessionId,
      taskId: taskIdFromSessionId(sessionId),
      message: (error as Error).message
    })
    return false
  }
  return true
}

export function killPty(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'pty',
      event: 'pty.kill_missing',
      sessionId,
      taskId: taskIdFromSessionId(sessionId)
    })
    return false
  }
  recordDiagnosticEvent({
    level: 'info',
    source: 'pty',
    event: 'pty.kill',
    sessionId,
    taskId: session.taskId
  })
  // Clear any pending timeouts to prevent orphaned callbacks
  if (session.statusWatchTimeout) {
    clearTimeout(session.statusWatchTimeout)
  }
  if (session.sessionIdAutoDetectTimer) {
    clearTimeout(session.sessionIdAutoDetectTimer)
  }
  // Clear state debounce timer
  stateMachine.unregister(sessionId)
  // Dismiss any lingering desktop notification
  dismissNotification(sessionId)
  // Delete from map FIRST so onData handlers exit early during kill
  sessions.delete(sessionId)
  // Use SIGKILL (9) to forcefully terminate - SIGTERM may not kill child processes
  session.pty.kill('SIGKILL')
  return true
}

export function hasPty(sessionId: string): boolean {
  return sessions.has(sessionId)
}

export function getBuffer(sessionId: string): string | null {
  const session = sessions.get(sessionId)
  return session?.buffer.toString() ?? null
}

export function clearBuffer(sessionId: string): { success: boolean; clearedSeq: number | null } {
  const session = sessions.get(sessionId)
  if (!session) return { success: false, clearedSeq: null }

  const clearedSeq = session.buffer.getCurrentSeq()
  session.buffer.clear()
  return { success: true, clearedSeq }
}

export function getBufferSince(sessionId: string, afterSeq: number): BufferSinceResult | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return {
    chunks: session.buffer.getChunksSince(afterSeq),
    currentSeq: session.buffer.getCurrentSeq()
  }
}

export function listPtys(): PtyInfo[] {
  const result: PtyInfo[] = []
  for (const [sessionId, session] of sessions) {
    result.push({
      sessionId,
      taskId: session.taskId,
      lastOutputTime: session.lastOutputTime,
      state: session.state
    })
  }
  return result
}

export function getState(sessionId: string): TerminalState | null {
  const session = sessions.get(sessionId)
  return session?.state ?? null
}

export function killAllPtys(): void {
  for (const [taskId] of sessions) {
    killPty(taskId)
  }
}

export function killPtysByTaskId(taskId: string): void {
  const toKill = [...sessions.entries()]
    .filter(([, session]) => session.taskId === taskId)
    .map(([sessionId]) => sessionId)
  for (const sessionId of toKill) {
    killPty(sessionId)
  }
}
