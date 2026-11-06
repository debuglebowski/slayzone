/**
 * Keeps the hub's copy of project folders (`project_placements`) and each
 * computer's own record (`computer.projects.json`) in step.
 *
 * Two entry points, both run under one lock per computer so they never interleave:
 *
 *  - {@link ComputerProjectSync.onConnect}: the ordered sequence every computer
 *    goes through when it connects. It replaces three independent `void` calls
 *    that used to race — a refresh could delete a folder a delivery had just
 *    confirmed, and a delivery could reach the computer before its allowed roots
 *    were widened and be refused for good.
 *  - {@link ComputerProjectSync.setFolder}: a user (or `projects.create`) choosing a
 *    project's folder on a computer.
 *
 * The connect sequence:
 *  1. refresh the copy from the computer's own report (it is the authority);
 *  2. local computer: widen its allowed roots to cover its folders. The desktop app
 *     had no jail before folders were routed through the local computer, so a
 *     project outside `$HOME` would otherwise stop working;
 *  3. deliver every row the computer has not confirmed, one at a time — including
 *     the `pending` rows migration v176 made from the legacy `projects.path`;
 *  4. give projects with no default computer this one, when it holds their folder;
 *  5. tell clients, once, if anything changed.
 *
 * Delivery tells a refusal from a failure. The computer saying no (folder missing,
 * or outside its allowed roots) is an answer and is recorded. A timeout, a
 * disconnect, or a store still loading is not — the row stays as it was and the
 * next connect tries again.
 *
 * @module hub/computer-project-sync
 */

import { LOCAL_COMPUTER_WORK_ROOTS_KEY } from '@slayzone/settings-core/server'
import { isAbsolute } from 'node:path'
import { resolveWorktreeBasePathTemplate } from '@slayzone/worktrees/shared'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  deletePlacement,
  getPlacement,
  listPlacements,
  recordComputerProjectPaths,
  setPlacement,
  type PlacementRow
} from '@slayzone/computers/server'
import { USABLE_PLACEMENT_STATUSES, type PlacementStatus } from '@slayzone/computers/shared'
import { ComputerTransportErrorCodes, RpcError } from '@slayzone/computer-transport/shared'
import {
  isCoveredByRoots,
  missingRootsForFolders,
  missingRootsForProjects
} from './local-computer-roots'

/** Hub setting: the local computer's roots added for work folders (M6). */
const WORK_ROOTS_KEY = LOCAL_COMPUTER_WORK_ROOTS_KEY

/** The computer calls this module makes. */
export interface ComputerFolderOps {
  listRoots(computerId: string): Promise<{ roots: readonly string[] }>
  setAllowedRoots(computerId: string, roots: string[]): Promise<unknown>
  pathExists(computerId: string, path: string): Promise<boolean>
  setProjectPath(computerId: string, projectId: string, path: string): Promise<{ path: string }>
  forgetProjectPath(computerId: string, projectId: string): Promise<void>
  /** The computer's own report: every folder it has recorded for this hub. */
  listProjectPaths(computerId: string): Promise<ReadonlyArray<{ projectId: string; path: string }>>
}

export interface ComputerProjectSyncDeps {
  db: SlayzoneDb
  ops: ComputerFolderOps
  /** The supervised local computer — the only one whose roots the hub may widen. */
  localComputerId: string
  /**
   * The subset of `projectIds` this computer may hold (T-19: a computer only ever
   * learns its owner's projects). Every id on a hub without login.
   */
  servedProjects(computerId: string, projectIds: readonly string[]): Promise<string[]>
  /** Clients should reload projects. */
  onChanged(): void
  /** Diagnostics. */
  record(event: { level: 'info' | 'warn'; event: string; message: string; payload: object }): void
}

/** What a user-initiated folder change ended as. */
export interface SetFolderResult {
  path: string
  status: PlacementStatus
}

export interface ComputerProjectSync {
  onConnect(computerId: string): Promise<void>
  /**
   * The worktree base setting or an automation's folder changed: register the local
   * computer's work folders again (M6). Best-effort: an offline computer is widened on
   * its next connect.
   */
  localWorkFoldersChanged(): Promise<void>
  /**
   * Record `path` as this project's folder on this computer.
   *
   * - recorded on the computer → `ready` (with the computer's real path);
   * - the folder does not exist there → `missing`, the same "Project path not
   *   found" state a missing folder has always produced;
   * - the computer cannot be reached → `pending`, delivered on its next connect;
   * - the computer refuses it (outside its allowed roots) → throws the refusal, and
   *   nothing is recorded: the user is looking at the dialog and can pick again.
   */
  setFolder(computerId: string, projectId: string, path: string): Promise<SetFolderResult>
  /**
   * Forget this project's folder on this computer. The folder itself is untouched.
   * Never fails on an unreachable computer: the row turns `forgotten` (hidden from
   * clients) and the computer is told on its next connect.
   */
  forgetFolder(computerId: string, projectId: string): Promise<void>
}

/** The computer said no by its own policy (T-27) — an answer, not a failure. */
export function isRefusedByComputer(err: unknown): boolean {
  return err instanceof RpcError && err.code === ComputerTransportErrorCodes.refusedByComputer
}

/** Rows the computer has not confirmed: delivered (again) on every connect. */
const UNCONFIRMED: readonly PlacementStatus[] = ['pending', 'missing', 'refused']

export function createComputerProjectSync(deps: ComputerProjectSyncDeps): ComputerProjectSync {
  const { db, ops } = deps
  const locks = new Map<string, Promise<unknown>>()

  /** Run `fn` after everything already queued for this computer. */
  function withLock<T>(computerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(computerId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.catch(() => undefined)
    locks.set(computerId, settled)
    // Drop the entry once nothing newer has queued behind it.
    void settled.then(() => {
      if (locks.get(computerId) === settled) locks.delete(computerId)
    })
    return next
  }

  const isLocal = (computerId: string): boolean => computerId === deps.localComputerId

  async function refresh(computerId: string): Promise<void> {
    const reported = await ops.listProjectPaths(computerId)
    const served = new Set(
      await deps.servedProjects(
        computerId,
        reported.map((r) => r.projectId)
      )
    )
    await recordComputerProjectPaths(
      db,
      computerId,
      reported.filter((r) => served.has(r.projectId))
    )
  }

  /**
   * Folders the local computer works in besides project folders, as the desktop did
   * with no jail (M6): the worktree base each local project resolves to when the
   * setting names one (the default, a sibling, is covered by the project's parent),
   * and each automation action's own absolute folder (a `{{…}}` one resolves to a
   * project's folder, already covered).
   */
  async function localWorkFolders(computerId: string): Promise<string[]> {
    const folders: string[] = []
    const template = (
      await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'worktree_base_path'")
    )?.value?.trim()
    if (template) {
      for (const r of await listPlacements(db)) {
        if (r.computer_id !== computerId || !r.path) continue
        const base = resolveWorktreeBasePathTemplate(template, r.path)
        if (base && isAbsolute(base)) folders.push(base)
      }
    }
    for (const a of await db.all<{ actions: string }>('SELECT actions FROM automations')) {
      let actions: unknown
      try {
        actions = JSON.parse(a.actions)
      } catch {
        continue
      }
      if (!Array.isArray(actions)) continue
      for (const action of actions) {
        const cwd = (action as { params?: { cwd?: unknown } })?.params?.cwd
        if (typeof cwd === 'string' && !cwd.includes('{{') && isAbsolute(cwd)) folders.push(cwd)
      }
    }
    return folders
  }

  /**
   * Roots this sync added for work folders (not for projects, never the user's own),
   * so they can be removed again when no work folder needs them (final review round
   * 2, low M6). Kept in the hub's settings: it survives a restart, and only the
   * supervised local computer is ever widened.
   */
  async function readTracked(): Promise<Record<string, string[]>> {
    const raw = (
      await db.get<{ value: string }>(`SELECT value FROM settings WHERE key = '${WORK_ROOTS_KEY}'`)
    )?.value
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {}
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string[]>)
        : {}
    } catch {
      return {}
    }
  }

  // Keyed by computer id. That is no guard across machines (the local computer's id
  // is the same everywhere): the key is machine-local instead — never exported, and
  // ignored on import (`isMachineLocalSetting`, R3-2).
  async function trackedWorkRoots(computerId: string): Promise<string[]> {
    const list = (await readTracked())[computerId]
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string') : []
  }

  async function saveTrackedWorkRoots(computerId: string, roots: readonly string[]): Promise<void> {
    const all = await readTracked()
    all[computerId] = [...new Set(roots)]
    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${WORK_ROOTS_KEY}', ?)`, [
      JSON.stringify(all)
    ])
  }

  /**
   * Folders the local computer's live tasks work in — worktrees and base dirs of
   * tasks on it, or on no computer in a project placed on it. They never add a root
   * (each was covered when it was made); they only keep a work-folder root from being
   * removed while still in use (final review round 3, R3-1). A soft-deleted task
   * counts too: its worktree stays on disk and a restore only clears `deleted_at`,
   * so the root is released only once the row is purged (round 4, R4-1).
   */
  async function foldersInUse(computerId: string): Promise<string[]> {
    const rows = await db.all<{ worktree_path: string | null; base_dir: string | null }>(
      `SELECT worktree_path, base_dir FROM tasks t
        WHERE (t.computer_id = ? OR (t.computer_id IS NULL AND EXISTS (
            SELECT 1 FROM project_placements pp
             WHERE pp.project_id = t.project_id AND pp.computer_id = ?)))`,
      [computerId, computerId]
    )
    const folders: string[] = []
    for (const r of rows) {
      for (const f of [r.worktree_path, r.base_dir]) {
        if (f && isAbsolute(f)) folders.push(f)
      }
    }
    return folders
  }

  /**
   * Widen the local computer's allowed roots to cover these folders. With
   * `workFolders` (the full current list), work-folder roots no longer needed are
   * removed too, and `paths` must then be every local project folder: a project that
   * sat under a removed root gets its own again.
   */
  async function widenRoots(
    computerId: string,
    paths: readonly string[],
    workFolders?: readonly string[]
  ): Promise<void> {
    if (!isLocal(computerId)) return
    if (paths.length === 0 && !workFolders) return
    const { roots } = await ops.listRoots(computerId)
    let base: readonly string[] = roots
    let stale: string[] = []
    let keptTracked: string[] = []
    if (workFolders) {
      // Folders in use keep their root too (R3-1): a task worktree created under an
      // earlier worktree base still lives there after the setting changes.
      const needed = missingRootsForFolders(
        [...workFolders, ...(await foldersInUse(computerId))],
        []
      )
      // Only roots this sync added (a root the user already had covered the folder,
      // so it was never added or tracked) and the computer still has.
      const tracked = (await trackedWorkRoots(computerId)).filter((r) => roots.includes(r))
      stale = tracked.filter((r) => !needed.some((n) => isCoveredByRoots(n, [r])))
      keptTracked = tracked.filter((r) => !stale.includes(r))
      base = roots.filter((r) => !stale.includes(r))
    }
    const fromProjects = missingRootsForProjects(paths, base)
    const fromFolders = workFolders
      ? missingRootsForFolders(workFolders, [...base, ...fromProjects])
      : []
    const additions = [...fromProjects, ...fromFolders]
    if (workFolders) await saveTrackedWorkRoots(computerId, [...keptTracked, ...fromFolders])
    if (additions.length === 0 && stale.length === 0) return
    await ops.setAllowedRoots(computerId, [...base, ...additions])
    if (stale.length > 0) {
      deps.record({
        level: 'info',
        event: 'computer.roots_narrowed',
        message: `local computer allowed roots: ${stale.length} work folder root(s) no longer needed`,
        payload: { computerId, removed: stale }
      })
    }
    if (additions.length === 0) return
    deps.record({
      level: 'info',
      event: 'computer.roots_widened',
      message: `local computer allowed roots widened for ${additions.length} project folder(s)`,
      payload: { computerId, additions }
    })
  }

  /**
   * Hand one folder to the computer. Returns its answer, or null when it could not
   * be asked. Writes nothing to the hub's copy — callers decide what to record.
   */
  async function ask(
    computerId: string,
    projectId: string,
    path: string
  ): Promise<SetFolderResult | null> {
    try {
      // The computer's `setPath` checks its allowed roots, not existence — ask first,
      // or a folder that is not there would be recorded as if it were.
      if (!(await ops.pathExists(computerId, path))) return { path, status: 'missing' }
      const recorded = await ops.setProjectPath(computerId, projectId, path)
      return { path: recorded.path, status: 'ready' }
    } catch (err) {
      return isRefusedByComputer(err) ? { path, status: 'refused' } : null
    }
  }

  /** Make projects with no default computer use this one when it holds their folder. */
  async function backfillDefaults(computerId: string): Promise<number> {
    const candidates = await db.all<{ id: string }>(
      `SELECT p.id FROM projects p
         JOIN project_placements c ON c.project_id = p.id AND c.computer_id = ?
        WHERE p.default_computer_id IS NULL
          AND c.status IN (${USABLE_PLACEMENT_STATUSES.map(() => '?').join(', ')})`,
      [computerId, ...USABLE_PLACEMENT_STATUSES]
    )
    if (candidates.length === 0) return 0
    const served = await deps.servedProjects(
      computerId,
      candidates.map((c) => c.id)
    )
    let changed = 0
    for (const projectId of served) {
      const res = (await db.run(
        `UPDATE projects SET default_computer_id = ? WHERE id = ? AND default_computer_id IS NULL`,
        [computerId, projectId]
      )) as { changes: number }
      changed += res.changes
    }
    return changed
  }

  /** One step of the connect sequence. A failed step is reported; the next still runs. */
  async function step<T>(
    computerId: string,
    name: string,
    run: () => Promise<T>
  ): Promise<T | null> {
    try {
      return await run()
    } catch (err) {
      deps.record({
        level: 'warn',
        event: `computer.project_sync.${name}_failed`,
        message: err instanceof Error ? err.message : String(err),
        payload: { computerId }
      })
      return null
    }
  }

  return {
    localWorkFoldersChanged() {
      const local = deps.localComputerId
      return withLock(local, async () => {
        const projectFolders = (await listPlacements(db))
          .filter((r) => r.computer_id === local)
          .map((r) => r.path)
        await widenRoots(local, projectFolders, await localWorkFolders(local)).catch(
          () => undefined
        )
      })
    },

    onConnect(computerId) {
      return withLock(computerId, async () => {
        const before = snapshot(await listPlacements(db), computerId)
        let defaultsChanged = 0

        await step(computerId, 'refresh', () => refresh(computerId))
        if (isLocal(computerId)) {
          await step(computerId, 'widen', async () =>
            widenRoots(
              computerId,
              (await listPlacements(db))
                .filter((r) => r.computer_id === computerId)
                .map((r) => r.path),
              await localWorkFolders(computerId)
            )
          )
        }
        await step(computerId, 'deliver', async () => {
          const rows = (await listPlacements(db)).filter(
            (r) => r.computer_id === computerId && UNCONFIRMED.includes(r.status)
          )
          // T-19: a computer only ever learns its owner's projects — also a row
          // written without asking (migration v176 cannot know owners).
          const served = new Set(
            await deps.servedProjects(
              computerId,
              rows.map((r) => r.project_id)
            )
          )
          const unconfirmed = rows.filter((r) => served.has(r.project_id))
          for (const row of unconfirmed) {
            const answer = await ask(computerId, row.project_id, row.path)
            if (answer) await setPlacement(db, { computerId, projectId: row.project_id, ...answer })
          }
          // Folders cleared while the computer was unreachable: tell it now.
          const forgotten = (await listPlacements(db)).filter(
            (r) => r.computer_id === computerId && r.status === 'forgotten'
          )
          for (const row of forgotten) {
            const told = await ops.forgetProjectPath(computerId, row.project_id).then(
              () => true,
              () => false
            )
            if (told) await deletePlacement(db, computerId, row.project_id)
          }
        })
        defaultsChanged =
          (await step(computerId, 'backfill', () => backfillDefaults(computerId))) ?? 0

        const after = snapshot(await listPlacements(db), computerId)
        if (before !== after || defaultsChanged > 0) deps.onChanged()
      })
    },

    setFolder(computerId, projectId, path) {
      return withLock(computerId, async () => {
        // Best-effort: an offline computer cannot be widened, and still gets the
        // folder as `pending`.
        await widenRoots(computerId, [path]).catch(() => undefined)
        const answer = await ask(computerId, projectId, path)
        if (answer?.status === 'refused') {
          // Nothing recorded, and any folder already set stays: the user is choosing
          // right now and can pick another one.
          throw new RpcError(
            ComputerTransportErrorCodes.refusedByComputer,
            `'${path}' is outside the folders this computer allows`
          )
        }
        const recorded = answer ?? { path, status: 'pending' as const }
        if (recorded.status === 'missing') {
          // The project's folder there is now this missing one: the computer must not
          // keep starting agents in its old folder. Best-effort — an unreachable
          // computer is reconciled on its next connect.
          await ops.forgetProjectPath(computerId, projectId).catch(() => undefined)
        }
        await setPlacement(db, { computerId, projectId, ...recorded })
        deps.onChanged()
        return recorded
      })
    },

    forgetFolder(computerId, projectId) {
      return withLock(computerId, async () => {
        const told = await ops.forgetProjectPath(computerId, projectId).then(
          () => true,
          () => false
        )
        if (told) {
          await deletePlacement(db, computerId, projectId)
        } else {
          // Unreachable: cleared for clients now, and the computer is told on its next
          // connect (until then its report cannot bring the folder back).
          const current = await getPlacement(db, projectId, computerId)
          if (current)
            await setPlacement(db, {
              computerId,
              projectId,
              path: current.path,
              status: 'forgotten'
            })
        }
        deps.onChanged()
      })
    }
  }
}

/** A comparable fingerprint of one computer's rows, to tell whether a sync changed any. */
function snapshot(rows: readonly PlacementRow[], computerId: string): string {
  return JSON.stringify(
    rows.filter((r) => r.computer_id === computerId).map((r) => [r.project_id, r.path, r.status])
  )
}
