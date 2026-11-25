/**
 * Ratchet (robustness plan §9, Phase 7e): the hub keeps no task path, so no access
 * rule may decide ownership by a path inside a task's folders. A path-taking request
 * names its task or project; the computer confines the path there.
 *
 * What may still name a `path(…)` ref — each a NEW root the hub itself records (a
 * project's folder: its owner check is what stops registering a project over someone
 * else's folder or the hub's own state). Relocation replaces that recorded root;
 * its source and destination remain project roots, never task folders. Pin every
 * permitted field, so an extra path inside an existing rule also fails.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/owner-policy-path-ratchet.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const PROJECT_ROOT_PATHS = {
  'projects.create': ['path'],
  'projects.update': ['path'],
  'projects.relocate': ['path', 'sourcePath'],
  // A clone creates the project's folder on a computer: a new root, like create.
  'projects.cloneFolder': ['path']
}

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8')

/** Each `'proc.name': …` rule of the policy whose body names `path('…')`. */
function procsWithPathRefs(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const rule = /^\s*'([\w.]+)':\s*([\s\S]*?)(?=^\s*'[\w.]+':|^\s*\/\/ ──|^}\s*$)/gm
  for (const m of policy.matchAll(rule)) {
    const body = m[2].replace(/\/\/.*$/gm, '')
    const fields = [...body.matchAll(/(?:^|[^\w])path\(\s*'([^']+)'/g)].map((ref) => ref[1])
    if (fields.length) out[m[1]] = fields
  }
  return out
}

test('only new-root rules name a path; no task folder decides ownership', () => {
  expect(procsWithPathRefs(source('owner-policy.ts'))).toEqual(PROJECT_ROOT_PATHS)
})

test('the computer-disk roots hold no task folder', () => {
  const access = source('access.ts')
  const sql = access.slice(access.indexOf('const COMPUTER_DISK_ROOTS_SQL'))
  const end = sql.indexOf('`', sql.indexOf('`') + 1)
  expect(sql.slice(0, end)).not.toMatch(/FROM tasks/)
  expect(access).not.toMatch(/worktree_path|base_dir/)
})
