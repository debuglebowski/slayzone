/**
 * Ratchet (robustness plan §9, Phase 7e): the hub keeps no task path, so no access
 * rule may decide ownership by a path inside a task's folders. A path-taking request
 * names its task or project; the computer confines the path there.
 *
 * What may still name a `path(…)` ref — each a NEW root the hub itself records (a
 * project's folder: its owner check is what stops registering a project over someone
 * else's folder or the hub's own state). The list may only shrink.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/owner-policy-path-ratchet.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const ALLOWED_PATH_RULES = ['projects.create', 'projects.update']

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8')

/** Each `'proc.name': …` rule of the policy whose body names `path('…')`. */
function procsWithPathRefs(policy: string): string[] {
  const out: string[] = []
  const rule = /^\s*'([\w.]+)':\s*([\s\S]*?)(?=^\s*'[\w.]+':|^\s*\/\/ ──|^}\s*$)/gm
  for (const m of policy.matchAll(rule)) {
    const body = m[2].replace(/\/\/.*$/gm, '')
    if (/(^|[^\w])path\(\s*'/.test(body)) out.push(m[1])
  }
  return out
}

test('only new-root rules name a path; no task folder decides ownership', () => {
  const found = procsWithPathRefs(source('owner-policy.ts'))
  expect(found.filter((p) => !ALLOWED_PATH_RULES.includes(p))).toEqual([])
  // The ratchet only shrinks: an allowed entry that no longer names a path goes.
  expect(ALLOWED_PATH_RULES.filter((p) => !found.includes(p))).toEqual([])
})

test('the computer-disk roots hold no task folder', () => {
  const access = source('access.ts')
  const sql = access.slice(access.indexOf('const COMPUTER_DISK_ROOTS_SQL'))
  const end = sql.indexOf('`', sql.indexOf('`') + 1)
  expect(sql.slice(0, end)).not.toMatch(/FROM tasks/)
  expect(access).not.toMatch(/worktree_path|base_dir/)
})
