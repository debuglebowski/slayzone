import { getPtyHostBridge, type PtySessionWindow } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import {
  createPty,
  writePty,
  submitPty,
  resizePty,
  getPtySize,
  killPty,
  touchPty,
  interruptPty,
  prioritizePty,
  ackEnsureAlive,
  hasLivePty,
  getBuffer,
  clearBuffer,
  getBufferSince,
  watchPtyOutput,
  listPtys,
  getState,
  setDatabase,
  setTerminalTheme,
  testExecutionContext,
  setPtyCreateCapture,
  takePtyCreateOpts,
  takePtyKillCalls,
  type PtyCreateResult
} from './pty-manager'
import { listSessions, getSessionState, listChatSessionEntries } from './session-registry'
import { createDbPtySpawnLookups, mapAgentRow, type PtySpawnLookups } from './pty-data-ops'
import type { TaskSessionStore } from './task-session-store'
import { claimWarmShell, getWarmStatus, setProjectTabCounts } from './warm-process-manager'
import { resolveSpawnTarget } from './spawn-target'
import { getPtyBackend, onPtyBackendChange } from './pty-backend'
import { createKeyedSerializer } from './keyed-serializer'
import { createUnattachedSessions, type UnattachedLaunchResolver } from './unattached-sessions'
import { runDoctor } from './runtime-doctor'
import { getAdapter, type ExecutionContext } from '../adapters'
import type {
  AgentId,
  AgentDefinition,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput
} from '@slayzone/terminal-contracts'
import { DEFAULT_AGENTS } from '@slayzone/terminal-contracts'
import { parseShellArgs } from '../adapters/flag-parser'
import { resolveUserShell, setShellOverride } from '@slayzone/platform'

/**
 * Whether a command's binary is on PATH where agents start — the caller's computer
 * (the hub wires `exec.run`). None wired: "connect a computer"; the hub's own PATH
 * says nothing about that machine.
 */
export type TerminalCommandProbe = (
  bin: string
) => Promise<{ found: boolean; path?: string; error?: string }>
let commandProbe: TerminalCommandProbe = async () => refuseNoComputer({ op: 'agents.test' })
export function setTerminalCommandProbe(next: TerminalCommandProbe | null): void {
  commandProbe = next ?? (async () => refuseNoComputer({ op: 'agents.test' }))
}

/**
 * Injectable spawn-time lookups (hub/computer split, wave 2, Model A). Default
 * `null` → each `createPtyOps` builds the db-backed impl below, so behavior is
 * byte-identical. A later wave calls `setPtySpawnLookups` at boot (BEFORE
 * `createPtyOps`) to route spawn-time reads — including `resolveComputerId` —
 * through the hub RPC. Swap only at a boot quiesce point (no in-flight spawn).
 */
let injectedSpawnLookups: PtySpawnLookups | null = null
export function setPtySpawnLookups(lookups: PtySpawnLookups | null): void {
  injectedSpawnLookups = lookups
}

export interface PtyCreateOpts {
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: AgentId
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
  cols?: number
  rows?: number
  /** The creating tab is on screen: its agent starts first (see `CreatePtyOptions.foreground`). */
  foreground?: boolean
  /**
   * Hub-internal (never from a client — the router drops it): take over the session
   * the computer already runs under this id instead of starting one. See
   * `CreatePtyOptions.attach` and ./unattached-sessions.
   */
  attach?: { computerId: string; spawnId: string }
}

/**
 * How a tab's agent is launched, from the hub's records — the composition root
 * wires it (the task domain resolves tasks and tabs). Unset: sessions a previous
 * hub run left on a computer are surfaced, not adopted.
 */
let unattachedLaunchResolver: UnattachedLaunchResolver | null = null
export function setUnattachedLaunchResolver(next: UnattachedLaunchResolver | null): void {
  unattachedLaunchResolver = next
}

/**
 * Transport-agnostic PTY operations (IPC → tRPC migration, slice 3 / P17).
 *
 * Single implementation of every `pty:*` / `agents*` / `session:*` /
 * `chat:list` handler body, so the IPC handlers (`registerPtyHandlers`) and the
 * tRPC `pty` router both delegate here — no duplicated logic while both
 * transports coexist (renderer cutover is slice 5). Mirrors the chat/task
 * `createXOps` pattern; injected into the transport layer via `setPtyDeps`.
 *
 * `warmSetProjectTabCounts` is per-window state: the IPC handler keys it by
 * `event.sender.id`, the tRPC proc by `ctx.windowId` (same webContents id).
 * Window-close cleanup is the hub's: it clears a window's counts once that
 * window's last `/trpc` socket stays closed (apps/hub warm-window-sockets.ts).
 */
export function createPtyOps(db: SlayzoneDb, taskStore: TaskSessionStore) {
  // Wires the pty-manager's session ledger (hub/computer wave 1: the runtime's
  // DB touchpoints go through an injected ops interface, db-backed by default;
  // the task-side ledger writes go through the task-owned `taskStore`).
  setDatabase(db, taskStore)
  // Spawn-time reads (mode row, task→project, computer assignment) — same queries,
  // behind the seam. Injectable (wave 2) so a computer-aware impl can replace the
  // db default; unset → the db-backed impl (byte-identical). The agents
  // CRUD below stays on the raw db: that's hub data.
  const lookups = injectedSpawnLookups ?? createDbPtySpawnLookups(db)

  // Agent definitions CRUD
  const agentsList = async (): Promise<AgentDefinition[]> => {
    const rows = await db.prepare('SELECT * FROM agents ORDER BY "order" ASC').all()
    return rows.map(mapAgentRow)
  }

  const agentsTest = async (
    command: string
  ): Promise<{ ok: boolean; error?: string; detail?: string }> => {
    const parts = parseShellArgs(command)
    const bin = parts[0]
    if (!bin) return { ok: false, error: 'No command provided' }
    // On the computer agents start on; no computer = the refusal, not "not found".
    const probed = await commandProbe(bin)
    return probed.found
      ? { ok: true, detail: probed.path ?? '' }
      : { ok: false, error: 'Command not found', detail: probed.error ?? '' }
  }

  const agentsGet = async (id: string): Promise<AgentDefinition | null> => {
    const row = await db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    return row ? mapAgentRow(row) : null
  }

  const agentsCreate = async (input: CreateAgentDefinitionInput): Promise<AgentDefinition> => {
    const id = input.id
    await db
      .prepare(
        `
      INSERT INTO agents (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order", pattern_working, pattern_error, usage_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        input.label,
        input.type,
        input.initialCommand ?? null,
        input.resumeCommand ?? null,
        input.headlessCommand ?? null,
        input.defaultFlags ?? null,
        input.enabled !== false ? 1 : 0,
        input.order ?? 0,
        input.patternWorking ?? null,
        input.patternError ?? null,
        input.usageConfig ? JSON.stringify(input.usageConfig) : null
      )
    const row = await db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    return mapAgentRow(row)
  }

  const agentsUpdate = async (
    id: string,
    updates: UpdateAgentDefinitionInput
  ): Promise<AgentDefinition | null> => {
    const builtinRow = (await db.prepare('SELECT is_builtin FROM agents WHERE id = ?').get(id)) as
      | { is_builtin: number }
      | undefined
    const isBuiltin = Boolean(builtinRow?.is_builtin)

    const sets: string[] = []
    const params: unknown[] = []

    if (updates.label !== undefined && !isBuiltin) {
      sets.push('label = ?')
      params.push(updates.label)
    }
    if (updates.type !== undefined && !isBuiltin) {
      sets.push('type = ?')
      params.push(updates.type)
    }
    if (updates.initialCommand !== undefined && !isBuiltin) {
      sets.push('initial_command = ?')
      params.push(updates.initialCommand)
    }
    if (updates.resumeCommand !== undefined && !isBuiltin) {
      sets.push('resume_command = ?')
      params.push(updates.resumeCommand ?? null)
    }
    if (updates.headlessCommand !== undefined) {
      sets.push('headless_command = ?')
      params.push(updates.headlessCommand ?? null)
    }
    if (updates.defaultFlags !== undefined) {
      sets.push('default_flags = ?')
      params.push(updates.defaultFlags)
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(updates.enabled ? 1 : 0)
    }
    if (updates.order !== undefined) {
      sets.push(' "order" = ?')
      params.push(updates.order)
    }
    if (updates.patternWorking !== undefined) {
      sets.push('pattern_working = ?')
      params.push(updates.patternWorking ?? null)
    }
    if (updates.patternError !== undefined) {
      sets.push('pattern_error = ?')
      params.push(updates.patternError ?? null)
    }
    if (updates.usageConfig !== undefined) {
      sets.push('usage_config = ?')
      params.push(updates.usageConfig ? JSON.stringify(updates.usageConfig) : null)
    }

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      params.push(id)
      await db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const updatedRow = await db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    return updatedRow ? mapAgentRow(updatedRow) : null
  }

  const agentsDelete = async (id: string): Promise<boolean> => {
    const deleteRow = (await db.prepare('SELECT is_builtin FROM agents WHERE id = ?').get(id)) as
      | { is_builtin: number }
      | undefined
    if (deleteRow?.is_builtin) {
      return false // Built-in modes cannot be deleted
    }
    await db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    return true
  }

  const agentsRestoreDefaults = async (): Promise<void> => {
    const insertSql = `
        INSERT OR IGNORE INTO agents (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `
    const ops = DEFAULT_AGENTS.map((mode) => ({
      type: 'run' as const,
      sql: insertSql,
      params: [
        mode.id,
        mode.label,
        mode.type,
        mode.initialCommand ?? null,
        mode.resumeCommand ?? null,
        mode.headlessCommand ?? null,
        mode.defaultFlags ?? null,
        mode.enabled ? 1 : 0,
        mode.order
      ]
    }))
    await db.batchTxn(ops)
  }

  const agentsResetToDefaultState = async (): Promise<void> => {
    const insertSql = `
        INSERT INTO agents (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `
    const ops = [
      { type: 'run' as const, sql: 'DELETE FROM agents', params: [] as unknown[] },
      ...DEFAULT_AGENTS.map((mode) => ({
        type: 'run' as const,
        sql: insertSql,
        params: [
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.headlessCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        ] as unknown[]
      }))
    ]
    await db.batchTxn(ops)
  }

  /**
   * Create a PTY. `win` is supplied by the IPC handler from the invoking
   * `event.sender`; the tRPC path omits it and we fall back to the focused/first
   * window (PTY output now fans out via `ptyEvents`, so the window is only
   * needed for legacy `redirectSessionWindow()` codepaths).
   */
  // One start or adoption per session id at a time: a tab's start and the hub's
  // adoption of that tab's running agent never interleave (review H2) — the later one
  // sees what the earlier one registered (and binds to it, never replaces it).
  const oneAtATime = createKeyedSerializer()
  const ptyCreate = (
    opts: PtyCreateOpts,
    win?: PtySessionWindow | null
  ): Promise<PtyCreateResult> => oneAtATime(opts.sessionId, () => ptyCreateNow(opts, win))

  const ptyCreateNow = async (
    opts: PtyCreateOpts,
    win?: PtySessionWindow | null
  ): Promise<PtyCreateResult> => {
    const host = getPtyHostBridge()
    const targetWin = win ?? host.getFocusedWindow() ?? host.getAllWindows()[0]
    if (!targetWin) return { success: false, error: 'No window found' }

    let providerArgs: string[] = []
    try {
      providerArgs = parseShellArgs(opts.providerFlags)
    } catch (err) {
      console.warn('[pty:create] Invalid provider flags, ignoring:', (err as Error).message)
    }

    // Look up mode info to get type, templates, and default flags
    const modeId = opts.mode || 'claude-code'

    const modeInfo = (await lookups.getAgent(modeId)) ?? undefined

    // Warm-process pool: if a warm agent was reserved for THIS task at create (it
    // booted with the task's id) and the spawn matches it (default mode,
    // project-root cwd, fresh start, same flags, same computer), adopt it instead of
    // cold-spawning. A miss is silent — createPty cold-spawns exactly as before.
    //
    // Claiming is gated on a RESOLVED computer, the inverse of the old rule. It used
    // to fire only when `computerId == null`, because the pool was hub-local — which
    // meant the hub booted the agent itself in precisely the case that is supposed
    // to raise "no computer available". The pool now lives on the computer, so a claim
    // needs a computer rather than the absence of one.
    let warmClaim: ReturnType<typeof claimWarmShell> = null
    // The computer, project and folder, decided here on the hub (spawn-target.ts).
    // `projectId` also travels in the spawn spec so the computer can use its own
    // record when the hub knows no folder (see PtySpawnSpec.projectId).
    const { taskId, projectId, computerId, cwd } = await resolveSpawnTarget(
      opts.sessionId,
      opts.cwd,
      {
        ...lookups,
        resolveComputerId: (taskId) =>
          lookups.resolveComputerId(taskId, {
            mode: modeId,
            conversationId: opts.existingConversationId
          })
      }
    )
    if (opts.attach && computerId !== opts.attach.computerId) {
      // The task runs on another computer now: its tab is not this process's to own.
      return {
        success: false,
        code: 'attach-refused',
        attachRefusal: 'task-elsewhere',
        error: `The task runs on another computer now (${computerId ?? 'none'}).`
      }
    }
    if (taskId && !opts.attach) {
      if (computerId != null) {
        warmClaim = claimWarmShell({
          taskId,
          mode: modeId,
          cwd,
          resuming: !!opts.existingConversationId,
          computerId,
          // The warm agent baked the mode's default flags; only adopt it when
          // this spawn's flags match (else cold-spawn with the right flags).
          flags: opts.providerFlags ?? null
        })
      }
    }

    return createPty({
      win: targetWin,
      sessionId: opts.sessionId,
      computerId,
      projectId,
      cwd,
      conversationId: opts.conversationId,
      existingConversationId: opts.existingConversationId,
      mode: modeId as AgentId,
      initialPrompt: opts.initialPrompt,
      providerArgs,
      executionContext: opts.executionContext,
      type: modeInfo?.type,
      initialCommand: modeInfo?.initialCommand,
      resumeCommand: modeInfo?.resumeCommand,
      defaultFlags: modeInfo?.defaultFlags,
      patternWorking: modeInfo?.patternWorking,
      patternError: modeInfo?.patternError,
      cols: opts.cols,
      rows: opts.rows,
      foreground: opts.foreground === true,
      adoptPty: warmClaim ?? undefined,
      ...(opts.attach ? { attach: opts.attach } : {})
    })
  }

  // Sessions a previous hub run left running on a computer: adopted into their
  // tabs, or surfaced (./unattached-sessions). Follows whichever backend is installed.
  const unattached = createUnattachedSessions({
    backend: getPtyBackend,
    resolve: (target) => unattachedLaunchResolver?.(target) ?? Promise.resolve(null),
    create: (launch) =>
      ptyCreate({
        sessionId: launch.sessionId,
        cwd: launch.cwd,
        mode: launch.mode as AgentId,
        providerFlags: launch.providerFlags ?? null,
        executionContext: (launch.executionContext ?? null) as ExecutionContext | null,
        attach: launch.attach
      })
  })
  unattached.start()
  onPtyBackendChange(() => unattached.start())
  const unattachedList = () => unattached.list()
  const unattachedAttach = (computerId: string, sessionId: string) =>
    unattached.attach(computerId, sessionId)
  const unattachedKill = (computerId: string, sessionId: string) =>
    unattached.kill(computerId, sessionId)
  const onUnattachedChange = (cb: () => void) => unattached.onChange(cb)

  const ptyTestExecutionContext = (context: ExecutionContext) => testExecutionContext(context)
  const ptyWrite = (sessionId: string, data: string, writeId?: string) =>
    writePty(sessionId, data, writeId)
  const ptySubmit = (sessionId: string, text: string) => submitPty(sessionId, text)
  const ptyResize = (sessionId: string, cols: number, rows: number) =>
    resizePty(sessionId, cols, rows)
  const ptyGetSize = (sessionId: string) => getPtySize(sessionId)
  // Every "new conversation / new process" flow (restart, reset, respawn, Start fresh,
  // changed flags) kills the tab's session before starting it again. With nothing
  // tracked here, the agent the computer still runs from a previous hub run is what
  // must end — else the new start would take that old agent over (review M2).
  const ptyKill = async (sessionId: string): Promise<boolean> => {
    if (killPty(sessionId)) return true
    const outcome = await unattached.killBySession(sessionId)
    // Attached while this waited: it is the tab's session now — end it as such.
    if (outcome === 'attached') return killPty(sessionId)
    return outcome === 'stopped'
  }
  const ptyTouch = (sessionId: string) => touchPty(sessionId)
  const ptyInterrupt = (sessionId: string) => interruptPty(sessionId)
  const ptyPrioritize = (sessionId: string) => prioritizePty(sessionId)
  const ptyAckEnsureAlive = (reqId: number, result: 'ok' | 'already-alive' | 'error') =>
    ackEnsureAlive(reqId, result)
  // Live, not merely registered: an exited session lingers ~100ms to drain its
  // output, and every caller of `exists` is deciding whether to write or respawn.
  const ptyExists = (sessionId: string) => hasLivePty(sessionId)
  const ptyGetBuffer = (sessionId: string) => getBuffer(sessionId)
  const ptyClearBuffer = (sessionId: string) => clearBuffer(sessionId)
  const ptyGetBufferSince = (sessionId: string, afterSeq: number) =>
    getBufferSince(sessionId, afterSeq)
  const ptyList = () => listPtys()
  const ptyWatchOutput = (target: readonly string[] | 'all') => watchPtyOutput(target)
  const chatList = () => listChatSessionEntries()
  const ptyGetState = (sessionId: string) => getState(sessionId)
  const sessionList = () => listSessions()
  const sessionGetState = (sessionId: string) => getSessionState(sessionId)
  const ptySetTheme = (theme: {
    foreground: string
    background: string
    cursor: string
    ansi?: readonly string[]
  }) => setTerminalTheme(theme)

  /** Doctor. With `taskId`, the computer that task's agents start on answers for
   *  itself — node-pty, shell, binaries (runtime-doctor.ts). */
  const ptyValidate = async (mode: AgentId, taskId?: string) => {
    const modeInfo = (await lookups.getAgent(mode)) ?? undefined
    const adapter = getAdapter({
      mode,
      type: modeInfo?.type,
      patterns: {
        working: modeInfo?.patternWorking,
        error: modeInfo?.patternError
      }
    })
    const requirements = adapter.doctorRequirements ?? []
    // A plain shell needs nothing checked (and Doctor is not offered for one).
    if (requirements.length === 0) return []
    return runDoctor({
      requirements,
      computerId: taskId ? await lookups.resolveComputerId(taskId) : null,
      backend: getPtyBackend(),
      // The shell pty-manager will ask the computer to spawn (the override, if set).
      shell: resolveUserShell()
    })
  }

  const ptySetShellOverride = (value: string | null) => setShellOverride(value)

  // Warm-process gate: a window's full per-project open-task-tab snapshot.
  // Idempotent (full snapshot each time) so dropped messages self-heal.
  const warmSetProjectTabCounts = (windowId: number, counts: Record<string, number>): void =>
    setProjectTabCounts(windowId, counts)

  return {
    agentsList,
    agentsTest,
    agentsGet,
    agentsCreate,
    agentsUpdate,
    agentsDelete,
    agentsRestoreDefaults,
    agentsResetToDefaultState,
    ptyCreate,
    unattachedList,
    unattachedAttach,
    unattachedKill,
    onUnattachedChange,
    setCreateCapture: setPtyCreateCapture,
    takeCreateOpts: takePtyCreateOpts,
    takeKillCalls: takePtyKillCalls,
    warmStatus: getWarmStatus,
    ptyTestExecutionContext,
    ptyWrite,
    ptySubmit,
    ptyResize,
    ptyGetSize,
    ptyKill,
    ptyTouch,
    ptyInterrupt,
    ptyPrioritize,
    ptyAckEnsureAlive,
    ptyExists,
    ptyGetBuffer,
    ptyClearBuffer,
    ptyGetBufferSince,
    ptyWatchOutput,
    ptyList,
    chatList,
    ptyGetState,
    sessionList,
    sessionGetState,
    ptySetTheme,
    ptyValidate,
    ptySetShellOverride,
    warmSetProjectTabCounts
  }
}
