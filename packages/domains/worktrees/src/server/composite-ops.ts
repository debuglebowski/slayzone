/**
 * Composite git operations — multi-step orchestrations + AI-backed flows that
 * are NOT 1:1 wrappers over a single git command. Extracted so the legacy IPC
 * handlers (handlers.ts) and the tRPC worktrees router share ONE implementation
 * (no drift while both transports coexist). Plus the copy/submodule behavior
 * resolvers, which the worktree-creation flow depends on.
 */
import { readdir, stat as fsStat } from 'fs/promises'
import path from 'path'
import type { SlayzoneDb } from '@slayzone/platform'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { WorktreeCopyBehavior, WorktreeSubmoduleInit } from '@slayzone/projects/shared'
import {
  isGitRepo,
  detectWorktrees,
  createWorktree,
  runWorktreeSetupScript,
  copyIgnoredFiles,
  initSubmodules,
  hasUncommittedChanges,
  startMergeNoCommit
} from './git-worktree'
import { ensureColors } from './color-registry'
import { runAiCommand } from './merge-ai'
import type {
  CreateWorktreeOpts,
  CreateWorktreePhase,
  WorktreeSubmoduleResult,
  MergeWithAIResult,
  ConflictAnalysis
} from '../shared/types'

// ── Child-repo detection (cached + concurrent-call deduped) ──────────────────
const CHILD_REPO_CACHE_MAX = 50
const CHILD_REPO_CACHE_TTL = 30_000 // 30s
const childRepoCache = new Map<
  string,
  { repos: { name: string; path: string }[]; timestamp: number }
>()
const pendingDetections = new Map<string, Promise<{ name: string; path: string }[]>>()

function evictStaleRepoCache(): void {
  if (childRepoCache.size <= CHILD_REPO_CACHE_MAX) return
  const now = Date.now()
  for (const [key, entry] of childRepoCache) {
    if (now - entry.timestamp > CHILD_REPO_CACHE_TTL) childRepoCache.delete(key)
  }
  if (childRepoCache.size > CHILD_REPO_CACHE_MAX) {
    const sorted = [...childRepoCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < sorted.length - CHILD_REPO_CACHE_MAX; i++) {
      childRepoCache.delete(sorted[i][0])
    }
  }
}

/** Scan a project dir for immediate child git repos (multi-repo projects). */
export async function detectChildRepos(
  projectPath: string
): Promise<{ name: string; path: string }[]> {
  const cached = childRepoCache.get(projectPath)
  if (cached && Date.now() - cached.timestamp < CHILD_REPO_CACHE_TTL) return cached.repos

  // Deduplicate concurrent calls for the same path
  const pending = pendingDetections.get(projectPath)
  if (pending) return pending

  const detection = (async () => {
    // If root is itself a git repo, no multi-repo mode
    if (await isGitRepo(projectPath)) {
      childRepoCache.set(projectPath, { repos: [], timestamp: Date.now() })
      return []
    }
    try {
      const entries = await readdir(projectPath)
      const repos: { name: string; path: string }[] = []
      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(projectPath, entry)
          try {
            const s = await fsStat(fullPath)
            if (s.isDirectory() && (await isGitRepo(fullPath))) {
              repos.push({ name: entry, path: fullPath })
            }
          } catch {
            // Skip inaccessible entries
          }
        })
      )
      repos.sort((a, b) => a.name.localeCompare(b.name))
      childRepoCache.set(projectPath, { repos, timestamp: Date.now() })
      evictStaleRepoCache()
      return repos
    } catch {
      return []
    }
  })()

  pendingDetections.set(projectPath, detection)
  void detection.finally(() => pendingDetections.delete(projectPath))
  return detection
}

/** Detected worktrees with per-worktree colors assigned (main excluded). */
export async function detectWorktreesWithColors(repoPath: string) {
  const detected = await detectWorktrees(repoPath)
  const nonMainPaths = detected.filter((d) => !d.isMain).map((d) => d.path)
  const colors = ensureColors(repoPath, nonMainPaths)
  return detected.map((d) => (d.isMain ? d : { ...d, color: colors.get(d.path) }))
}

// ── Copy / submodule behavior resolvers ──────────────────────────────────────
/**
 * Policy reads the worktree-creation flow depends on. The default impl
 * (`createDbWorktreePolicyOps`) reads the local DB; a hub/runner split can
 * substitute an impl that resolves policy remotely — exec-side code depends
 * only on this interface, never on the DB directly.
 */
export interface WorktreePolicyOps {
  resolveCopyBehavior(
    projectId?: string
  ): Promise<{ behavior: WorktreeCopyBehavior; customPaths: string[] }>
  resolveSubmoduleInit(projectId?: string): Promise<WorktreeSubmoduleInit>
}

/** DB-backed `WorktreePolicyOps` — same SQL the legacy resolvers ran. */
export function createDbWorktreePolicyOps(db: SlayzoneDb): WorktreePolicyOps {
  return {
    async resolveCopyBehavior(
      projectId?: string
    ): Promise<{ behavior: WorktreeCopyBehavior; customPaths: string[] }> {
      // Check project-level override first (null = inherit from global)
      // Wrapped in try-catch: columns added in migration v70 may not exist on stale DBs
      if (projectId) {
        try {
          const row = (await db
            .prepare(
              'SELECT worktree_copy_behavior, worktree_copy_paths FROM projects WHERE id = ?'
            )
            .get(projectId)) as
            | { worktree_copy_behavior: string | null; worktree_copy_paths: string | null }
            | undefined
          if (row?.worktree_copy_behavior) {
            const behavior = row.worktree_copy_behavior as WorktreeCopyBehavior
            const customPaths =
              behavior === 'custom' && row.worktree_copy_paths
                ? row.worktree_copy_paths
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean)
                : []
            return { behavior, customPaths }
          }
        } catch {
          /* fall through to global setting */
        }
      }

      // Fall back to global setting
      const settingRow = (await db
        .prepare("SELECT value FROM settings WHERE key = 'worktree_copy_behavior'")
        .get()) as { value: string } | undefined
      const behavior = (settingRow?.value as WorktreeCopyBehavior) || 'ask'
      let customPaths: string[] = []
      if (behavior === 'custom') {
        const pathsRow = (await db
          .prepare("SELECT value FROM settings WHERE key = 'worktree_copy_paths'")
          .get()) as { value: string } | undefined
        customPaths = pathsRow?.value
          ? pathsRow.value
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
          : []
      }

      return { behavior, customPaths }
    },

    async resolveSubmoduleInit(projectId?: string): Promise<WorktreeSubmoduleInit> {
      if (projectId) {
        try {
          const row = (await db
            .prepare('SELECT worktree_submodule_init FROM projects WHERE id = ?')
            .get(projectId)) as { worktree_submodule_init: string | null } | undefined
          if (row?.worktree_submodule_init)
            return row.worktree_submodule_init as WorktreeSubmoduleInit
        } catch {
          /* column may not exist on stale DB — fall through */
        }
      }

      const settingRow = (await db
        .prepare("SELECT value FROM settings WHERE key = 'worktree_submodule_init'")
        .get()) as { value: string } | undefined
      return (settingRow?.value as WorktreeSubmoduleInit) || 'auto'
    }
  }
}

/** Legacy signature — delegates to the DB-backed `WorktreePolicyOps`. */
export async function resolveCopyBehavior(
  db: SlayzoneDb,
  projectId?: string
): Promise<{ behavior: WorktreeCopyBehavior; customPaths: string[] }> {
  return createDbWorktreePolicyOps(db).resolveCopyBehavior(projectId)
}

/** Legacy signature — delegates to the DB-backed `WorktreePolicyOps`. */
export async function resolveSubmoduleInitBehavior(
  db: SlayzoneDb,
  projectId?: string
): Promise<WorktreeSubmoduleInit> {
  return createDbWorktreePolicyOps(db).resolveSubmoduleInit(projectId)
}

// ── Worktree creation (create → copy ignored → submodules → setup script) ─────
/**
 * `onPhase` streams phase progress to the requesting renderer: the IPC handler
 * wires it to `webContents.send('git:createWorktree:phase')`, the tRPC
 * `createWorktree` mutation to `worktreesEvents` (consumed by the
 * `onCreateWorktreePhase` subscription, correlated by requestId).
 */
export async function createWorktreeWithSetupWith(
  policy: WorktreePolicyOps,
  opts: CreateWorktreeOpts,
  onPhase?: (phase: CreateWorktreePhase) => void
): Promise<{
  setupResult: Awaited<ReturnType<typeof runWorktreeSetupScript>>
  submoduleResult: WorktreeSubmoduleResult
}> {
  const { repoPath, targetPath, branch, sourceBranch, projectId } = opts
  const emit = (phase: CreateWorktreePhase): void => onPhase?.(phase)

  emit('creating')
  await createWorktree(repoPath, targetPath, branch, sourceBranch)

  emit('copying')
  // Copy ignored files based on settings ('ask' is handled client-side)
  const { behavior, customPaths } = await policy.resolveCopyBehavior(projectId)
  if (behavior === 'all' || behavior === 'custom') {
    await copyIgnoredFiles(repoPath, targetPath, behavior, customPaths)
  }

  emit('submodules')
  const submoduleBehavior = await policy.resolveSubmoduleInit(projectId)
  let submoduleResult: WorktreeSubmoduleResult
  if (submoduleBehavior === 'skip') {
    submoduleResult = { ran: false, reason: 'skipped' }
  } else {
    submoduleResult = await initSubmodules(targetPath)
  }

  emit('setup')
  const setupResult = await runWorktreeSetupScript(targetPath, repoPath, sourceBranch)

  emit('done')
  return { setupResult, submoduleResult }
}

/** Legacy signature — delegates to `createWorktreeWithSetupWith` over the DB-backed policy. */
export async function createWorktreeWithSetup(
  db: SlayzoneDb,
  opts: CreateWorktreeOpts,
  onPhase?: (phase: CreateWorktreePhase) => void
): Promise<{
  setupResult: Awaited<ReturnType<typeof runWorktreeSetupScript>>
  submoduleResult: WorktreeSubmoduleResult
}> {
  return createWorktreeWithSetupWith(createDbWorktreePolicyOps(db), opts, onPhase)
}

// ── AI-assisted merge: start a no-commit merge, return an agent resolution plan ─
export async function mergeWithAI(args: {
  projectPath: string
  worktreePath: string
  parentBranch: string
  sourceBranch: string
}): Promise<MergeWithAIResult> {
  const { projectPath, worktreePath, parentBranch, sourceBranch } = args
  try {
    // Check for uncommitted changes in worktree
    const hasChanges = await hasUncommittedChanges(worktreePath)

    // Start merge
    const result = await startMergeNoCommit(projectPath, parentBranch, sourceBranch)

    // If clean merge and no uncommitted changes, we're done
    if (result.clean && !hasChanges) {
      return { success: true }
    }

    // Build dynamic prompt based on what needs to be done
    const steps: string[] = []

    if (hasChanges) {
      steps.push(`Step 1: Commit uncommitted changes in this worktree
- git add -A
- git commit -m "WIP: changes before merge"`)
    }

    if (result.conflictedFiles.length > 0) {
      const stepNum = hasChanges ? 2 : 1
      steps.push(`Step ${stepNum}: Resolve merge conflicts in ${projectPath}
Conflicted files:
${result.conflictedFiles.map((f) => `- ${f}`).join('\n')}

- cd "${projectPath}"
- Read each conflicted file
- Resolve conflicts (prefer source branch when unclear)
- git add <resolved files>
- git commit -m "Merge ${sourceBranch} into ${parentBranch}"`)
    } else if (hasChanges) {
      // No conflicts but has uncommitted changes - after committing, merge should work
      steps.push(`Step 2: Complete the merge
- cd "${projectPath}"
- git merge "${sourceBranch}" --no-ff
- If conflicts occur, resolve them`)
    }

    const prompt = `Complete this merge: "${sourceBranch}" → "${parentBranch}"

${steps.join('\n\n')}`

    return {
      resolving: true,
      conflictedFiles: result.conflictedFiles,
      prompt
    }
  } catch (err) {
    recordDiagnosticEvent({
      level: 'error',
      source: 'git',
      event: 'git.merge_with_ai_failed',
      message: err instanceof Error ? err.message : String(err),
      payload: {
        projectPath,
        worktreePath,
        parentBranch,
        sourceBranch
      }
    })
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ── AI conflict analysis: summarize a 3-way conflict + suggest a resolution ────
export async function analyzeConflict(
  mode: string,
  filePath: string,
  base: string | null,
  ours: string | null,
  theirs: string | null
): Promise<ConflictAnalysis> {
  const prompt = `Analyze this merge conflict for file "${filePath}".

BASE (common ancestor):
\`\`\`
${base ?? '(file did not exist)'}
\`\`\`

OURS (current branch):
\`\`\`
${ours ?? '(file did not exist)'}
\`\`\`

THEIRS (incoming branch):
\`\`\`
${theirs ?? '(file did not exist)'}
\`\`\`

Respond in this exact format (no extra text):
SUMMARY: <2-3 sentences explaining what each branch changed and why they conflict>
---RESOLUTION---
<the complete resolved file content, picking the best combination of both sides>`

  const result = await runAiCommand(mode as 'claude-code' | 'codex', prompt)

  // Parse the structured response
  const sepIdx = result.indexOf('---RESOLUTION---')
  if (sepIdx === -1) {
    return { summary: result, suggestion: '' }
  }
  const summary = result
    .slice(0, sepIdx)
    .replace(/^SUMMARY:\s*/i, '')
    .trim()
  const suggestion = result.slice(sepIdx + '---RESOLUTION---'.length).trim()
  return { summary, suggestion }
}
