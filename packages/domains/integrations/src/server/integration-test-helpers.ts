/**
 * Shared helpers for real-API integration tests (Linear + GitHub).
 * These tests hit live APIs — gated behind env vars.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Database } from 'better-sqlite3'
import { storeCredential } from './credentials'

// ── .env loading ────────────────────────────────────────────────────────
function loadEnvFile(): void {
  const envPath = path.resolve(import.meta.dirname, '../../../../../.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx)
    const value = trimmed.slice(eqIdx + 1)
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile()

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.log(`Skipping integration tests (no ${name})`)
    process.exit(0)
  }
  return value
}

// ── Unique ID generation (no Date.now collisions) ───────────────────────
let idCounter = 0
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++idCounter}`
}

// ── DB seeding ──────────────────────────────────────────────────────────
export function seedFullMapping(
  db: Database,
  provider: 'linear' | 'github',
  credential: string,
  opts: {
    teamId: string
    teamKey: string
    syncMode?: 'one_way' | 'two_way'
    repoOwner?: string
    repoName?: string
    workflowStates?: Array<{ id: string; type: string }>
  }
): { projectId: string; connectionId: string; mappingId: string } {
  const projectId = uid(`proj-integ-${provider}`)
  const connectionId = uid(`conn-integ-${provider}`)
  const credRef = uid(`cred-integ-${provider}`)
  const mappingId = uid(`map-integ-${provider}`)

  db.prepare(`INSERT INTO projects (id, name, color, path, created_at, updated_at)
    VALUES (?, ?, '#888888', '/tmp/integ-test', datetime('now'), datetime('now'))`)
    .run(projectId, `Integration Test ${provider}`)

  storeCredential(db, credRef, credential)

  db.prepare(`INSERT INTO integration_connections (id, provider, credential_ref, enabled)
    VALUES (?, ?, ?, 1)`)
    .run(connectionId, provider, credRef)

  db.prepare(`INSERT INTO integration_project_connections (id, project_id, provider, connection_id)
    VALUES (?, ?, ?, ?)`)
    .run(crypto.randomUUID(), projectId, provider, connectionId)

  const repoOwner = opts.repoOwner ?? ''
  const repoName = opts.repoName ?? ''

  db.prepare(`INSERT INTO integration_project_mappings
    (id, project_id, provider, connection_id, external_team_id, external_team_key,
     sync_mode, status_setup_complete, external_repo_owner, external_repo_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      mappingId, projectId, provider, connectionId,
      opts.teamId, opts.teamKey,
      opts.syncMode ?? 'two_way',
      repoOwner, repoName
    )

  if (provider === 'linear' && opts.workflowStates) {
    const statusMap: Record<string, string> = {
      triage: 'inbox',
      backlog: 'backlog',
      unstarted: 'todo',
      started: 'in_progress',
      completed: 'done',
      canceled: 'canceled'
    }
    for (const state of opts.workflowStates) {
      const localStatus = statusMap[state.type] ?? 'todo'
      db.prepare(`INSERT OR IGNORE INTO integration_state_mappings
        (id, provider, project_mapping_id, local_status, state_id, state_type)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), 'linear', mappingId, localStatus, state.id, state.type)
    }
  }

  if (provider === 'github') {
    db.prepare(`INSERT OR IGNORE INTO integration_state_mappings
      (id, provider, project_mapping_id, local_status, state_id, state_type)
      VALUES (?, 'github', ?, 'todo', 'open', 'open')`)
      .run(crypto.randomUUID(), mappingId)
    db.prepare(`INSERT OR IGNORE INTO integration_state_mappings
      (id, provider, project_mapping_id, local_status, state_id, state_type)
      VALUES (?, 'github', ?, 'done', 'closed', 'closed')`)
      .run(crypto.randomUUID(), mappingId)
  }

  return { projectId, connectionId, mappingId }
}

// ── Suite timeout ───────────────────────────────────────────────────────
const SUITE_TIMEOUT_MS = 120_000

export function startSuiteTimeout(): void {
  const timer = setTimeout(() => {
    console.error('\n✗ Suite timed out after 2 minutes')
    process.exit(1)
  }, SUITE_TIMEOUT_MS)
  timer.unref()
}

// ── Crash-safe cleanup registry ─────────────────────────────────────────
type CleanupFn = () => Promise<void>
const cleanupFns: CleanupFn[] = []
let cleanupRan = false

export function registerCleanup(fn: CleanupFn): void {
  cleanupFns.push(fn)
}

async function runCleanups(): Promise<void> {
  if (cleanupRan) return
  cleanupRan = true
  for (const fn of cleanupFns) {
    try { await fn() } catch (e) {
      console.warn('  cleanup error:', e)
    }
  }
}

// Register handlers once
process.on('exit', () => { void runCleanups() })
process.on('SIGINT', () => { void runCleanups().then(() => process.exit(1)) })
process.on('SIGTERM', () => { void runCleanups().then(() => process.exit(1)) })
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  void runCleanups().then(() => process.exit(1))
})

// ── Cleanup helpers ─────────────────────────────────────────────────────

/** Archive Linear issues (cleanup). Uses issueArchive mutation. */
export async function cleanupLinearIssues(apiKey: string, issueIds: string[]): Promise<void> {
  for (const id of issueIds) {
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({
          query: `mutation ArchiveIssue($id: String!) { issueArchive(id: $id) { success } }`,
          variables: { id }
        })
      })
      if (!res.ok) console.warn(`  cleanup: failed to archive Linear issue ${id}: HTTP ${res.status}`)
    } catch (e) {
      console.warn(`  cleanup: failed to archive Linear issue ${id}:`, e)
    }
  }
}

/** Close GitHub issues (cleanup). */
export async function cleanupGithubIssues(
  token: string,
  issues: Array<{ owner: string; repo: string; number: number }>
): Promise<void> {
  for (const issue of issues) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`,
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ state: 'closed' })
        }
      )
      if (!res.ok) console.warn(`  cleanup: failed to close GitHub issue #${issue.number}: HTTP ${res.status}`)
    } catch (e) {
      console.warn(`  cleanup: failed to close GitHub issue #${issue.number}:`, e)
    }
  }
}

// ── Scoped discovery ────────────────────────────────────────────────────

/**
 * Run discovery for a SINGLE mapping only, not all mappings in the DB.
 * Prevents cross-contamination between test sections.
 */
export async function runScopedDiscovery(
  db: Database,
  mappingId: string
): Promise<void> {
  // Temporarily hide all other mappings by disabling their connections
  const otherMappings = db.prepare(`
    SELECT DISTINCT pm.connection_id FROM integration_project_mappings pm
    WHERE pm.id != ? AND pm.status_setup_complete = 1
  `).all(mappingId) as Array<{ connection_id: string }>

  const disabledIds: string[] = []
  for (const m of otherMappings) {
    db.prepare('UPDATE integration_connections SET enabled = 0 WHERE id = ?').run(m.connection_id)
    disabledIds.push(m.connection_id)
  }

  try {
    // Dynamic import to avoid circular deps
    const { runDiscovery } = await import('./sync')
    await runDiscovery(db)
  } finally {
    // Re-enable
    for (const id of disabledIds) {
      db.prepare('UPDATE integration_connections SET enabled = 1 WHERE id = ?').run(id)
    }
  }
}
