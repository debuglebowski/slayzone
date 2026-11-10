/**
 * Tests for scripts/check-task-computer-resolver.mjs (`pnpm lint:task-computer`, review 2
 * S5): a second copy of "which computer is this task's" fails; the resolver's users,
 * tests, frozen migrations and allowlisted files pass; a stale allowlist entry fails.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-task-computer-resolver.mjs')
const STORE = 'packages/domains/computers/src/server/store.ts'
const RESOLVER = `export const TASK_COMPUTER_EXPR = \`COALESCE(
  CASE WHEN t.has_worktree = 1 THEN t.worktree_computer_id END,
  t.computer_id, p.default_computer_id)\`\n`

/** Runs the guard over a fixture repo of `files` (repo-relative path → content). */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'task-computer-'))
  try {
    for (const [rel, content] of Object.entries({ [STORE]: RESOLVER, ...files })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the resolver itself and its users pass', () => {
  const r = check({
    'packages/domains/x/src/a.ts': `import { TASK_COMPUTER_EXPR } from '@slayzone/computers/server'
const sql = \`SELECT COALESCE(\${TASK_COMPUTER_EXPR}, ?) AS c FROM tasks t\`
const owner = \`COALESCE(o.computer_id, ?)\`\n`
  })
  expect(r.out).toContain('one copy')
  expect(r.code).toBe(0)
})

test('the old pin-then-project-default COALESCE fails, named by file and line', () => {
  const r = check({
    'packages/domains/terminal/src/server/runtime/chat-data-ops.ts': `const a = 1
const sql = \`SELECT COALESCE(t.computer_id, p.default_computer_id) AS computer_id\`\n`
  })
  expect(r.code).toBe(1)
  expect(r.out).toContain('packages/domains/terminal/src/server/runtime/chat-data-ops.ts:2')
})

test('variants fail too: extra fallback param, holder-first chain, other aliases, TS chains', () => {
  for (const body of [
    'AND COALESCE(t.computer_id, p.default_computer_id, ?) = ?',
    'coalesce(t.worktree_computer_id,t.computer_id,p.default_computer_id)',
    'COALESCE(task.worktree_computer_id, task.computer_id)',
    'COALESCE(tk.computer_id, (SELECT default_computer_id FROM projects WHERE id = tk.project_id))',
    'const c = task.worktree_computer_id ?? task.computer_id ?? null',
    'const c = row.computer_id ?? project.default_computer_id'
  ]) {
    const r = check({ 'packages/apps/hub/src/x.ts': `const q = \`${body}\`\n` })
    expect([body, r.code]).toEqual([body, 1])
  }
})

test('one task column alone, or the project default alone, is no copy', () => {
  const r = check({
    'packages/apps/hub/src/x.ts': `const a = \`COALESCE(t.computer_id, ?)\`
const b = \`COALESCE(p.default_computer_id, ?)\`
const c = \`COALESCE(t.worktree_computer_id, ?)\`
const d = row.default_computer_id ?? null\n`
  })
  expect(r.code).toBe(0)
})

test('tests and frozen migrations are not scanned', () => {
  const copy = 'const q = `COALESCE(t.computer_id, p.default_computer_id)`\n'
  const r = check({
    'packages/apps/hub/src/x.test.ts': copy,
    'packages/shared/db-migrations/src/migrations.ts': copy,
    'packages/shared/db-migrations/src/v176-x.ts': copy
  })
  expect(r.code).toBe(0)
})

test('an allowlisted file that no longer holds a copy fails (no rot)', () => {
  const r = check({ 'packages/domains/content-erasure/src/server/worker-db.ts': 'export {}\n' })
  expect(r.code).toBe(1)
  expect(r.out).toContain('remove it from ALLOWLIST')
})
