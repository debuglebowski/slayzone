/**
 * Review regressions, computer side: reproductions from the pre-merge reviews of
 * feat/move-to-computer, one test per reported case, kept as the computer reaches
 * them. Part of the ONE review-regression suite (`pnpm test:review-regressions`,
 * packages/shared/test-utils/review-regressions.mjs), which also runs the earlier
 * rounds' reproductions where they already live.
 *
 * Round 6 (artifact cfbc0854):
 *   L1 — the built computer bundle hung at startup on plain Node (the graphemes
 *        addon, bundled for the reply mirror, decoded its tables from the wrong bytes
 *        of Node's shared Buffer pool and spun). Standalone computers (`#!/usr/bin/env
 *        node`) and the upgrade probe never started. Booted here, as shipped.
 *   L5 — copying ignored files dropped every link in a folder that held only links
 *        (npm's `node_modules/.bin`): the link's folder was never created.
 */
import { execFile } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { ComputerConfig } from './config'
import { createGitHandlers, GitMethods } from './handlers/git'

const exec = promisify(execFile)
const BUNDLE = resolve(import.meta.dirname, '../dist/bin.cjs')

/**
 * Plain Node, never Electron-as-node: L1 never showed under Electron's Node (the
 * desktop's computer), only under the `node` a standalone computer runs on.
 */
function plainNode(): string {
  return process.versions.electron ? 'node' : process.execPath
}

describe('L1: the built computer bundle starts on plain Node', () => {
  it('ships the reply mirror (else this boot proves nothing about L1)', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source).toContain('addon-unicode-graphemes')
  })

  it('--runtime-contract answers and exits', async () => {
    const { stdout } = await exec(plainNode(), [BUNDLE, '--runtime-contract'], {
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    const contract = JSON.parse(stdout.trim()) as { min: number; max: number; version: string }
    expect(contract.max).toBeGreaterThanOrEqual(contract.min)
    expect(typeof contract.version).toBe('string')
  }, 40_000)

  it('--upgrade-probe (self-upgrade validation) answers with its version', async () => {
    const { stdout } = await exec(plainNode(), [BUNDLE, '--upgrade-probe'], {
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    })
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 40_000)
})

describe('L5: copying ignored files keeps links, in folders that hold only links', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rr-copy-links-')))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('node_modules/.bin links are copied verbatim, folder and all', async () => {
    const repo = join(base, 'repo')
    const wt = join(base, 'wt')
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(repo, 'node_modules', 'pkg', 'x.js'), 'module.exports = 1\n')
    symlinkSync('../pkg/x.js', join(repo, 'node_modules', '.bin', 'x'))
    symlinkSync('../pkg/x.js', join(repo, 'node_modules', '.bin', 'y'))
    await exec('git', ['init', '-q'], { cwd: repo })

    const config: ComputerConfig = {
      hubUrl: 'ws://localhost:0/computers',
      name: 't',
      allowedRoots: [base],
      capabilities: []
    }
    const logged: unknown[] = []
    const handlers = createGitHandlers({
      dialer: { notify: () => true },
      config,
      log: (...args: unknown[]) => logged.push(args)
    })
    const res = (await (handlers[GitMethods.copyIgnoredFiles] as (p: unknown) => unknown)({
      repoPath: repo,
      worktreePath: wt,
      behavior: 'all',
      customPaths: []
    })) as { copied: number }

    expect(logged.filter((l) => JSON.stringify(l).includes('failed'))).toEqual([])
    expect(res.copied).toBe(3)
    for (const name of ['x', 'y']) {
      const link = join(wt, 'node_modules', '.bin', name)
      expect(lstatSync(link).isSymbolicLink(), name).toBe(true)
      expect(readlinkSync(link)).toBe('../pkg/x.js')
    }
    expect(readFileSync(join(wt, 'node_modules', '.bin', 'x'), 'utf8')).toBe('module.exports = 1\n')
  })
})
