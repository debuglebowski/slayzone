import type { SlayzoneDb } from '@slayzone/platform'
import {
  recordPendingSpawn as recordPendingSpawnDb,
  prunePendingSpawns as prunePendingSpawnsDb,
  bindSessionToTask as bindSessionToTaskDb
} from '@slayzone/task/server'
import type { TerminalMode, TerminalModeInfo } from '@slayzone/terminal/shared'
import { buildMcpEnv as buildMcpEnvDb } from '../mcp-env'

/**
 * Hub/runner split (wave 1): the PTY runtime's DB touchpoints, pulled behind
 * ops interfaces so the exec-side call sites (pty-manager, and pty-store's
 * spawn paths) reference an interface instead of raw SQL. The `createDb*`
 * factories are the default implementations — they run the SAME queries the
 * call sites ran before, so behavior is byte-for-byte unchanged.
 *
 * Decoupling depth is deliberately staged: pty-manager no longer holds a db
 * handle at all (only the ledger; wave 2 swaps in a remote-backed impl via
 * `setPtySessionLedger` without touching call sites). pty-store still holds
 * the raw db — its `PtySpawnLookups` impl is db-backed and built once at
 * composition (`createPtyOps`), and `terminal_modes` CRUD stays on raw db by
 * design (hub data, not exec-side runtime state). Wave 2 adds the lookups
 * injection seam when the runner actually loses its local DB.
 */

/**
 * Session-provenance ledger consumed by createPty. Ordering contract
 * (session-provenance race): `recordPendingSpawn` MUST be awaited before the
 * agent process starts, `prunePendingSpawns` is fire-and-forget on exit, and
 * `bindSessionToTask` fires only when adopting a pre-warmed pooled agent.
 */
export interface PtySessionLedger {
  /** Spawn-intent anchor — durable BEFORE the child process can race ahead. */
  recordPendingSpawn(args: {
    taskId: string
    mode: string
    /** `null` = fresh spawn without a pre-minted id (agent mints its own). */
    expectedSessionId: string | null
    usedResume: boolean
  }): Promise<void>
  /** Drop pending rows for (taskId, mode) — called on PTY exit, best-effort. */
  prunePendingSpawns(scope: { taskId: string; mode: string }): Promise<number>
  /** Bind a pooled agent session to a task+tab (set-once). True if it bound. */
  bindSessionToTask(args: { sessionId: string; taskId: string; tabId: string }): Promise<boolean>
  /** Task-scoped MCP env for agent subprocesses (SLAYZONE_TASK_ID etc.). */
  buildMcpEnv(taskId: string | undefined, mode?: TerminalMode): Promise<Record<string, string>>
}

/** Default local-DB ledger — same SQL as before the split (task/server ops + mcp-env). */
export function createDbPtySessionLedger(db: SlayzoneDb): PtySessionLedger {
  return {
    recordPendingSpawn: (args) => recordPendingSpawnDb(db, args),
    prunePendingSpawns: (scope) => prunePendingSpawnsDb(db, scope),
    bindSessionToTask: (args) => bindSessionToTaskDb(db, args),
    buildMcpEnv: (taskId, mode) => buildMcpEnvDb(db, taskId, mode)
  }
}

/**
 * Spawn-time reads consumed by pty-store's `ptyCreate`/`ptyValidate`: resolve
 * the terminal mode row (templates, patterns, flags) and the task's project
 * (warm-pool claim key).
 */
export interface PtySpawnLookups {
  getTerminalMode(id: string): Promise<TerminalModeInfo | null>
  getTaskProjectId(taskId: string): Promise<string | null>
  /**
   * Hub/runner split (wave 2, Model A): the runner a task's PTY should spawn on,
   * or `null` for hub-local (today's only path). The db default ALWAYS returns
   * null; a later wave injects a runner-aware impl via `setPtySpawnLookups` so
   * `ptyCreate` can route the spawn (and gate warm-pool adoption to local).
   */
  resolveRunnerId(taskId: string): Promise<string | null>
}

/** Map a raw `terminal_modes` row to the shared TerminalModeInfo shape. */
export function mapModeRow(row: any): TerminalModeInfo {
  let usageConfig = null
  if (row.usage_config) {
    try {
      usageConfig = JSON.parse(row.usage_config)
    } catch {
      /* ignore corrupt */
    }
  }
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    initialCommand: row.initial_command,
    resumeCommand: row.resume_command,
    headlessCommand: row.headless_command ?? null,
    defaultFlags: row.default_flags,
    enabled: Boolean(row.enabled),
    isBuiltin: Boolean(row.is_builtin),
    order: row.order,
    patternWorking: row.pattern_working,
    patternError: row.pattern_error,
    usageConfig
  }
}

/** Default local-DB lookups — same SQL the ptyCreate/ptyValidate sites ran inline. */
export function createDbPtySpawnLookups(db: SlayzoneDb): PtySpawnLookups {
  return {
    getTerminalMode: async (id) => {
      const row = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
      return row ? mapModeRow(row) : null
    },
    getTaskProjectId: async (taskId) => {
      const row = (await db
        .prepare('SELECT project_id FROM tasks WHERE id = ?')
        .get(taskId)) as { project_id?: string } | undefined
      return row?.project_id ?? null
    },
    // Hub-local by default — no runner assignment exists yet. Wave 2's
    // runner-aware lookups impl overrides this via `setPtySpawnLookups`.
    resolveRunnerId: async () => null
  }
}
