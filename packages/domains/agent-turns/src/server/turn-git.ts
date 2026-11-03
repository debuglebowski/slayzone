/**
 * `@slayzone/agent-turns/turn-git`: the git work behind agent turns — the boundary's
 * snapshot/dedupe/prune and the list's realpath + filter — as ONE table keyed like
 * {@link turnGitContract}. The hub runs it in-process when no computer holds the
 * checkout; the computer's `git.turnOp` handler runs the same table on its own disk.
 *
 * Lean by contract: git + fs only — no DB (the hub sends the rows the filter needs).
 */
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { AgentTurnRange } from '../shared/types'
import {
  deleteTurnRef,
  diffIsEmpty,
  diffIsEmptyCached,
  getHeadSha,
  listTreeBlobsCached,
  listTurnFilesCached,
  listWorkingChangedFiles,
  snapshotWorktree
} from './git-snapshot'

const s = z.string()

export const turnGitContract = {
  /** The checkout's canonical path ON ITS MACHINE (realpath, else as given). */
  canonical: z.object({ repoPath: s }),
  /** The list's filter + rethread over the hub's rows (see {@link filterAndRethread}). */
  filterTurns: z.object({ repoPath: s, rows: z.array(z.record(z.string(), z.unknown())) }),
  snapshot: z.object({ repoPath: s, turnId: s }),
  deleteTurnRef: z.object({ repoPath: s, turnId: s }),
  diffIsEmpty: z.object({ repoPath: s, from: s, to: s, cached: z.boolean().optional() })
} as const

export type TurnGitOpName = keyof typeof turnGitContract
export type TurnGitOpInput<K extends TurnGitOpName> = z.infer<(typeof turnGitContract)[K]>

export function isTurnGitOpName(name: string): name is TurnGitOpName {
  return Object.hasOwn(turnGitContract, name)
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

/**
 * Filter rules:
 *  1. Drop turns whose `head_sha_at_snap` is NULL (legacy row whose migration
 *     backfill failed — can't reason about it).
 *  2. Drop turns whose `prev_sha..snap_sha` is an empty diff (legacy / dedupe
 *     bypass / collapsed range).
 *  3. **Consumed check** (replaces the old strict `head_sha_at_snap == HEAD`
 *     equality). For every file the turn touched, compare the blob at that
 *     path in `tree(head_sha_at_snap)` vs `tree(HEAD)`. If *every* touched
 *     file's blob differs (or one side absent and the other defined), the
 *     work landed in HEAD's history → drop. If *any* file's blob is
 *     unchanged between snap-time HEAD and current HEAD, the file was never
 *     touched by intervening commits → that part of the turn's work is
 *     still pending → keep. Survives rebase / merge / squash / amend /
 *     external commits, where strict HEAD equality over-fires and orphans
 *     turns whose work is uncommitted.
 *  4. Drop turns whose changed files have zero overlap with the current
 *     working tree changes — a turn whose files are fully reverted (without
 *     a commit) no longer corresponds to anything in `git status`.
 *
 * Re-thread `prev_snapshot_sha` so dropped turns don't leave dangling SHAs:
 * each surviving row's prev points at the prior surviving row's snapshot, so
 * consecutive diffs remain meaningful.
 */
export async function filterAndRethread(
  repoPath: string,
  rows: AgentTurnRange[]
): Promise<AgentTurnRange[]> {
  const [workingSet, headSha] = await Promise.all([
    listWorkingChangedFiles(repoPath),
    getHeadSha(repoPath)
  ])
  const out: AgentTurnRange[] = []
  let prevSha: string | null = null
  // Fail-closed: if `git rev-parse HEAD` failed (broken repo, perms, etc.) we
  // can't safely classify any row as fresh, so drop everything. Better an empty
  // turn list than ghost turns from random history.
  if (headSha === null) return out
  const headBlobs = await listTreeBlobsCached(repoPath, headSha)
  // Same fail-closed posture for HEAD's tree: if ls-tree fails we can't
  // distinguish landed vs pending.
  if (headBlobs === null) return out
  for (const r of rows) {
    // Rule 1: legacy NULL drop (head_sha_at_snap backfill failed).
    if (r.head_sha_at_snap === null) continue
    const from = prevSha
    if (from !== null && (await diffIsEmptyCached(repoPath, from, r.snapshot_sha))) {
      // Dropped: keep prevSha — next surviving row will diff against the older base.
      continue
    }
    if (
      from === null &&
      (await diffIsEmptyCached(repoPath, `${r.snapshot_sha}^`, r.snapshot_sha))
    ) {
      // First turn but identical to its parent (HEAD-at-snap-time) — no real changes. Drop.
      continue
    }
    const fromForFiles = from ?? `${r.snapshot_sha}^`
    const turnFiles = await listTurnFilesCached(repoPath, fromForFiles, r.snapshot_sha)
    // Rule 3: consumed check. Fail-closed when head-at-snap tree is unreadable
    // (commit GC'd, repo corruption): drop, matching the getHeadSha-null
    // posture above.
    const headAtSnapBlobs = await listTreeBlobsCached(repoPath, r.head_sha_at_snap)
    if (headAtSnapBlobs === null) continue
    if (turnFiles.length > 0) {
      const consumed = turnFiles.every((f) => {
        const hb = headBlobs.get(f)
        const sb = headAtSnapBlobs.get(f)
        // Both undefined (file absent at both points) → unchanged → pending.
        // Both defined and equal → unchanged → pending. Otherwise → changed
        // (incl. created or deleted between then and now) → that file's work
        // is reflected in HEAD's history.
        return hb !== sb
      })
      if (consumed) continue
    }
    // Rule 4: file-overlap with working tree.
    if (!turnFiles.some((f) => workingSet.has(f))) {
      // Turn's files no longer present in working tree changes — drop, keep prevSha.
      continue
    }
    out.push({ ...r, prev_snapshot_sha: from })
    prevSha = r.snapshot_sha
  }
  return out
}

export const turnGitImpls = {
  canonical: (i: TurnGitOpInput<'canonical'>) => canonical(i.repoPath),
  filterTurns: (i: TurnGitOpInput<'filterTurns'>) =>
    filterAndRethread(i.repoPath, i.rows as unknown as AgentTurnRange[]),
  snapshot: (i: TurnGitOpInput<'snapshot'>) => snapshotWorktree(i.repoPath, i.turnId),
  deleteTurnRef: (i: TurnGitOpInput<'deleteTurnRef'>) => deleteTurnRef(i.repoPath, i.turnId),
  diffIsEmpty: (i: TurnGitOpInput<'diffIsEmpty'>) =>
    i.cached ? diffIsEmptyCached(i.repoPath, i.from, i.to) : diffIsEmpty(i.repoPath, i.from, i.to)
} satisfies { [K in TurnGitOpName]: (input: TurnGitOpInput<K>) => Promise<unknown> }

export type TurnGitOpResult<K extends TurnGitOpName> = Awaited<ReturnType<(typeof turnGitImpls)[K]>>

/** Run one op on THIS machine, its input validated against the contract first. */
export function runTurnGitOpLocally<K extends TurnGitOpName>(
  op: K,
  input: TurnGitOpInput<K>
): Promise<TurnGitOpResult<K>> {
  const parsed = turnGitContract[op].parse(input) as TurnGitOpInput<K>
  return (turnGitImpls[op] as unknown as (i: TurnGitOpInput<K>) => Promise<TurnGitOpResult<K>>)(
    parsed
  )
}
