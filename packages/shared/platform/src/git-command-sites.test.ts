/**
 * No production code starts `git` by its bare name: each such spawn makes the OS try
 * every PATH entry first. They go through `gitCommand(env)` (resolve-command.ts) or a
 * chokepoint that does (`hubSpawn`/`hubSpawnSync` in worktrees, the computer's
 * `execCapture`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from 'vitest'

const repo = resolve(import.meta.dirname, '../../../..')

/** A raw child_process call (or a promisified one) whose command is the literal 'git'. */
const BARE_GIT =
  /\b(spawn|spawnSync|execFile|execFileSync|execFileAsync|exec|execSync|gitSpawn)\(\s*['"`]git['"`]/g

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', 'e2e', '__tests__', '.turbo'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(full)
    else if (
      /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) &&
      !/\.(test|spec|live)\.|\.d\.ts$/.test(entry.name)
    )
      yield full
  }
}

test('no production code spawns git by its bare name', () => {
  const hits: string[] = []
  for (const root of ['packages/apps', 'packages/domains', 'packages/shared']) {
    for (const file of sources(join(repo, root))) {
      const rel = relative(repo, file)
      if (rel.startsWith('packages/shared/test-utils/')) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(BARE_GIT)) {
        const line = text.slice(0, m.index).split('\n').length
        hits.push(`${rel}:${line}`)
      }
    }
  }
  expect(hits).toEqual([])
})
