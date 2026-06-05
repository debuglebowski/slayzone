/**
 * Pure decision core for conversation self-heal — the safety-critical piece.
 *
 * When a task is reopened and its stored Claude conversation id points at a
 * transcript that no longer exists on disk (a "phantom" left by an old eager
 * commit, or normal retention pruning), we want to silently reconnect it to the
 * REAL conversation rather than show a false "session expired" overlay.
 *
 * GUIDING RULE: never guess. Any ambiguity → `overlay` (honest). A missed heal is
 * fine; attaching the WRONG conversation is never acceptable. All IO (disk stats,
 * transcript parsing, "referenced by another task" lookup) happens in the caller;
 * this function is pure so the full decision matrix is unit-testable.
 *
 * Three sources of truth, in order of certainty:
 *  1. `keep`    — the stored id is confirmed real (in this task's own history, or
 *                 its transcript exists). Never touch a healthy pointer.
 *  2. `history` — fall back to the most-recent prior id WE recorded for this task
 *                 (from a real SessionStart) whose transcript still exists. Exact;
 *                 zero misattribution.
 *  3. `orphan`  — only for legacy tasks with no usable history: a disk transcript
 *                 in the task's own working dir, matched conservatively. Gated to
 *                 a near-certain single match (see `decideConversationHeal`).
 *
 * See plans/conv-id-robustness-v2.md.
 */

export interface HealTranscriptMeta {
  id: string
  /** `cwd` recorded inside the transcript (lossless — compared string-exact). */
  cwd: string
  /** Epoch-ms of the transcript's first timestamped record, or null if none. */
  firstTsMs: number | null
  /** `gitBranch` recorded inside the transcript, or null if absent. */
  gitBranch: string | null
  /** Has ≥1 real (non-sidechain) human user turn. */
  hasHumanTurn: boolean
  /** This id is referenced by SOME task (any task's conversationId / history /
   *  legacy column) — i.e. it is NOT a free orphan. */
  referenced: boolean
}

export interface HealInput {
  /** The task's currently-stored conversation id for the mode (may be null). */
  storedId: string | null
  /** Does `storedId`'s transcript exist on disk? */
  storedExists: boolean
  /** Is `storedId` in this task's own confirmed `conversationHistory`? */
  storedInHistory: boolean
  /** This task's history, MOST-RECENT-LAST, each with whether it exists on disk. */
  history: Array<{ id: string; exists: boolean }>
  task: {
    /** Exact launch cwd used for this task's terminal. */
    cwd: string
    gitBranch: string | null
    createdAtMs: number
    /** Created before the fix shipped — only legacy tasks use the orphan path. */
    isLegacy: boolean
  }
  /** All transcripts found in the task cwd's project dir (orphan candidates). */
  candidates: HealTranscriptMeta[]
  /** Max gap between task creation and the real session's first message. */
  windowMs: number
}

export type HealDecision =
  | { action: 'keep' }
  | { action: 'history'; id: string }
  | { action: 'orphan'; id: string }
  | { action: 'overlay' }

export function decideConversationHeal(input: HealInput): HealDecision {
  const { storedId, storedExists, storedInHistory, history, task, candidates, windowMs } = input

  // Nothing to resume, or the pointer is provably healthy → never touch it.
  if (!storedId) return { action: 'keep' }
  if (storedInHistory || storedExists) return { action: 'keep' }

  // Exact fallback: most-recent prior id WE recorded for this task that survives.
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.exists && h.id !== storedId) return { action: 'history', id: h.id }
  }

  // Disk-guess is legacy-only; new tasks rely on history and never reach here.
  if (!task.isLegacy) return { action: 'overlay' }

  // Option-B near-certain bar: there must be EXACTLY ONE transcript in this exact
  // cwd whose first message lands in the task's creation window — any second
  // plausible conversation in the same dir+window makes it ambiguous → overlay.
  const inWindow = (t: HealTranscriptMeta): boolean =>
    t.firstTsMs != null &&
    t.firstTsMs >= task.createdAtMs &&
    t.firstTsMs <= task.createdAtMs + windowMs
  const cwdInWindow = candidates.filter((t) => t.cwd === task.cwd && inWindow(t))
  if (cwdInWindow.length !== 1) return { action: 'overlay' }

  // The sole candidate must also be a free orphan, on the same branch, with a real
  // human turn. Unknown branch (null) fails — we don't guess across branches.
  const c = cwdInWindow[0]
  const ok =
    !c.referenced &&
    c.hasHumanTurn &&
    task.gitBranch != null &&
    c.gitBranch === task.gitBranch
  if (!ok) return { action: 'overlay' }

  return { action: 'orphan', id: c.id }
}
