/**
 * Tests for scripts/api-compat/lib.mjs — the logic of `pnpm check:api-compat`:
 * which release to compare with, reading a release's contract constants, the
 * generated type-level comparison (run for real through tsgo over two fixture
 * routers), and the policy that turns its breaks into pass/fail.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import {
  checkSource,
  evaluate,
  explainSource,
  parseContract,
  parseVerdict,
  pickBaseTag,
  pruneAcks
} from './lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('pickBaseTag', () => {
  test('the newest stable release that is not HEAD', () => {
    const tags = [
      { tag: 'v0.9.0', sha: 'a' },
      { tag: 'v0.10.0', sha: 'b' },
      { tag: 'v0.11.0-beta.1', sha: 'c' },
      { tag: 'v0.10.1', sha: 'head' }
    ]
    expect(pickBaseTag(tags, 'head')).toBe('v0.10.0')
    expect(pickBaseTag(tags, 'other')).toBe('v0.10.1')
    expect(pickBaseTag([], 'head')).toBeNull()
  })
})

describe('parseContract', () => {
  test('a release from before the contract is API 0 with no minimums', () => {
    expect(parseContract(null)).toEqual({ HUB_API_VERSION: 0, MIN_CLIENT_API: 0, MIN_HUB_API: 0 })
  })
  test('reads the three constants', () => {
    const src =
      'export const HUB_API_VERSION = 4\nexport const MIN_CLIENT_API = 2\nexport const MIN_HUB_API = 3\n'
    expect(parseContract(src)).toEqual({ HUB_API_VERSION: 4, MIN_CLIENT_API: 2, MIN_HUB_API: 3 })
  })
  test('a missing constant is an error, not a guess', () => {
    expect(() => parseContract('export const HUB_API_VERSION = 1')).toThrow(/MIN_CLIENT_API/)
  })
})

describe('evaluate', () => {
  const none = { removed: [], added: [], oldClient: [], newClient: [], droppedInput: [] }
  const v = (HUB_API_VERSION, MIN_CLIENT_API = 0, MIN_HUB_API = 0) => ({
    HUB_API_VERSION,
    MIN_CLIENT_API,
    MIN_HUB_API
  })

  test('no breaks: ok', () => {
    expect(evaluate({ found: none, base: v(1), head: v(1), acks: {} }).ok).toBe(true)
  })

  test('each break lands on its direction; unacknowledged ones fail', () => {
    const found = {
      ...none,
      removed: ['a.gone'],
      oldClient: ['b.x output'],
      added: ['c.new'],
      newClient: ['d.y input'],
      droppedInput: ['e.z input.flag']
    }
    const r = evaluate({ found, base: v(1), head: v(1), acks: {} })
    expect(r.ok).toBe(false)
    expect(r.violations.oldClient).toEqual(['a.gone removed', 'b.x output'])
    expect(r.violations.newClient).toEqual(['c.new added', 'd.y input', 'e.z input.flag dropped'])
  })

  test('an acknowledgement with a reason accepts a break; an empty one does not', () => {
    const found = { ...none, newClient: ['d.y output'], oldClient: ['b.x output'] }
    const acks = {
      newClient: { 'd.y output': 'client reads it optionally' },
      oldClient: { 'b.x output': ' ' }
    }
    const r = evaluate({ found, base: v(1), head: v(1), acks })
    expect(r.acked.newClient).toEqual(['d.y output'])
    expect(r.violations.oldClient).toEqual(['b.x output'])
  })

  test('a minimum above the base API covers that direction', () => {
    const found = { ...none, newClient: ['d.y output'], oldClient: ['b.x output'] }
    expect(evaluate({ found, base: v(1), head: v(2, 0, 2), acks: {} }).violations).toEqual({
      oldClient: ['b.x output'],
      newClient: []
    })
    expect(evaluate({ found, base: v(1), head: v(2, 2, 2), acks: {} }).ok).toBe(true)
  })

  test('contradictory constants fail', () => {
    expect(evaluate({ found: none, base: v(1), head: v(1, 2), acks: {} }).errors).toHaveLength(1)
    expect(evaluate({ found: none, base: v(1), head: v(1, 0, 2), acks: {} }).errors).toHaveLength(1)
    expect(evaluate({ found: none, base: v(3), head: v(2), acks: {} }).errors).toHaveLength(1)
  })

  test('stale acknowledgements are reported and pruned', () => {
    const acks = { newClient: { 'gone output': 'x', 'd.y output': 'y' }, oldClient: {} }
    const found = { ...none, newClient: ['d.y output'] }
    const r = evaluate({ found, base: v(1), head: v(1), acks })
    expect(r.stale.newClient).toEqual(['gone output'])
    expect(pruneAcks(acks, r.stale).newClient).toEqual({ 'd.y output': 'y' })
  })
})

describe('parseVerdict', () => {
  const lineOf = { removed: 10, added: 11, oldClient: 12, newClient: 13, droppedInput: 14 }
  test('reads each assertion’s literals', () => {
    const out = [
      `w/check.ts(12,14): error TS2322: Type '"a.b output" | "c input"' is not assignable to type '"__none__"'.`,
      `w/check.ts(11,14): error TS2322: Type '"z.new"' is not assignable to type '"__none__"'.`,
      'other/file.ts(1,1): error TS2883: unrelated'
    ].join('\n')
    const r = parseVerdict(out, 'w/check.ts', lineOf)
    expect(r.unexpected).toEqual([])
    expect(r.found.oldClient).toEqual(['a.b output', 'c input'])
    expect(r.found.added).toEqual(['z.new'])
    expect(r.found.removed).toEqual([])
  })
  test('anything else in the generated file makes the verdict untrustworthy', () => {
    const out = [
      `w/check.ts(12,14): error TS2322: Type 'string' is not assignable to type '"__none__"'.`,
      `w/check.ts(3,1): error TS2307: Cannot find module`
    ].join('\n')
    expect(parseVerdict(out, 'w/check.ts', lineOf).unexpected).toHaveLength(2)
  })
})

describe('the generated comparison, through tsgo', () => {
  // Inside the api package, so `@trpc/server` and `zod` resolve as they do for the router.
  const dir = join(root, 'packages/apps/api/node_modules/.cache', `api-compat-test-${process.pid}`)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const router = (body) => `
import { initTRPC } from '@trpc/server'
import { z } from 'zod'
declare const Brand: unique symbol
type Id = string & { readonly [Brand]: 'Id' }
const t = initTRPC.create()
export const appRouter = t.router(${body})
export type AppRouter = typeof appRouter
`
  const OLD = `{
    same: t.procedure.input(z.object({ a: z.string() })).query(() => ({ x: 1 })),
    branded: t.procedure.query(() => ({ id: '' as Id })),
    gone: t.procedure.query(() => 1),
    widenedOut: t.procedure.query(() => 'a' as 'a' | 'b'),
    newRequiredIn: t.procedure.input(z.object({ a: z.string() })).mutation(() => null),
    newOptionalIn: t.procedure.input(z.object({ a: z.string() })).mutation(() => null),
    newOutField: t.procedure.query(() => ({ a: 1 })),
    nested: t.router({ deep: t.procedure.query(() => ({ y: 'k' })) })
  }`
  const NEW = `{
    same: t.procedure.input(z.object({ a: z.string() })).query(() => ({ x: 1 })),
    branded: t.procedure.query(() => ({ id: '' as Id })),
    widenedOut: t.procedure.query(() => 'a' as 'a' | 'b' | 'c'),
    newRequiredIn: t.procedure.input(z.object({ a: z.string(), b: z.number() })).mutation(() => null),
    newOptionalIn: t.procedure.input(z.object({ a: z.string(), flag: z.boolean().optional() })).mutation(() => null),
    newOutField: t.procedure.query(() => ({ a: 1, b: 2 })),
    added: t.procedure.query(() => 1),
    nested: t.router({ deep: t.procedure.query(() => ({ y: 1 })) })
  }`

  test('finds each kind of break, and nothing where only a type-only brand differs', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.ts'), router(OLD))
    writeFileSync(join(dir, 'new.ts'), router(NEW))
    const check = checkSource({ newRouter: './new', oldRouter: './old' })
    writeFileSync(join(dir, 'check.ts'), check.source)
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../../tsconfig.json',
        compilerOptions: { noErrorTruncation: true },
        include: ['check.ts']
      })
    )
    const res = spawnSync(
      'pnpm',
      ['exec', 'tsgo', '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: join(root, 'packages/apps/api'),
        encoding: 'utf8'
      }
    )
    const file = `node_modules/.cache/api-compat-test-${process.pid}/check.ts`
    const { found, unexpected } = parseVerdict(`${res.stdout}${res.stderr}`, file, check.lineOf)
    expect(unexpected).toEqual([])
    expect(found.removed).toEqual(['gone'])
    expect(found.added).toEqual(['added'])
    // An older client: the new hub may return 'c' it does not know; `nested.deep`'s
    // output changed type. A new required input is fine for it only if the old one sent
    // it — it did not.
    expect(found.oldClient).toEqual([
      'nested.deep output',
      'newRequiredIn input',
      'widenedOut output'
    ])
    // A newer client: reads `b` an older hub does not send. What it sends an older hub
    // that the hub's schema does not know is not rejected — it is stripped, silently.
    expect(found.newClient).toEqual(['nested.deep output', 'newOutField output'])
    expect(found.droppedInput).toEqual(['newOptionalIn input.flag', 'newRequiredIn input.b'])

    // --explain: one assignment per break, so tsgo says why.
    const ex = explainSource(check.prelude, {
      oldClient: ['widenedOut output'],
      newClient: ['newOutField output']
    })
    expect(Object.values(ex.lineOf)).toEqual([
      'oldClient: widenedOut output',
      'newClient: newOutField output'
    ])
  }, 120_000)
})
