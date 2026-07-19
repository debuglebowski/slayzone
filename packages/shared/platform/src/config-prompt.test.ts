/**
 * config-prompt — interactive first-run setup for the standalone hub + runner.
 * Pure Node (real temp files, a scripted fake IO — no TTY, no native deps) → runs
 * under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/config-prompt.test.ts
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canPrompt, confirm, runInteractiveConfig, type PromptIO } from './config-prompt'
import { loadSlayzoneConfig } from './slayzone-config'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : e}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-prompt-'))
}

/** A fake IO that feeds a fixed queue of answers and records everything written. */
function fakeIo(answers: string[]): PromptIO & { asked: string[]; written: string[]; closed: boolean } {
  const queue = [...answers]
  const asked: string[] = []
  const written: string[] = []
  return {
    asked,
    written,
    closed: false,
    async ask(question: string) {
      asked.push(question)
      return queue.shift() ?? ''
    },
    write(text: string) {
      written.push(text)
    },
    close() {
      this.closed = true
    }
  }
}

/** Run body with a scrubbed set of the env vars this module reads. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
  const keys = ['SLAYZONE_SUPERVISED', 'SLAYZONE_NONINTERACTIVE']
  const prev: Record<string, string | undefined> = {}
  for (const k of keys) prev[k] = process.env[k]
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  const restore = (): void => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
  const r = fn()
  if (r instanceof Promise) return r.finally(restore)
  restore()
}

async function main(): Promise<void> {
  console.log('\nconfig-prompt: canPrompt')
  console.log('─'.repeat(40))

  await test('canPrompt false when stdin is not a TTY (test env)', () => {
    // The test harness stdin is a pipe (isTTY undefined) → never interactive.
    withEnv({ SLAYZONE_SUPERVISED: undefined, SLAYZONE_NONINTERACTIVE: undefined }, () => {
      assertEq(canPrompt(), false, 'non-TTY ⇒ false')
    })
  })

  await test('canPrompt false under SLAYZONE_SUPERVISED / SLAYZONE_NONINTERACTIVE', () => {
    withEnv({ SLAYZONE_SUPERVISED: '1' }, () => assertEq(canPrompt(), false, 'supervised ⇒ false'))
    withEnv({ SLAYZONE_NONINTERACTIVE: '1' }, () => assertEq(canPrompt(), false, 'noninteractive ⇒ false'))
  })

  console.log('\nconfig-prompt: confirm')
  console.log('─'.repeat(40))

  await test('confirm defaults yes on empty [Y/n], no on empty [y/N]', async () => {
    assertEq(await confirm(fakeIo(['']), 'ok?', { defaultYes: true }), true, 'empty ⇒ default yes')
    assertEq(await confirm(fakeIo(['']), 'ok?', { defaultYes: false }), false, 'empty ⇒ default no')
    assertEq(await confirm(fakeIo(['y']), 'ok?', { defaultYes: false }), true, 'y ⇒ yes')
    assertEq(await confirm(fakeIo(['nope']), 'ok?', { defaultYes: true }), false, 'nope ⇒ no')
  })

  console.log('\nconfig-prompt: runInteractiveConfig')
  console.log('─'.repeat(40))

  await test('no missing fields ⇒ nothing collected, no confirm, no write', async () => {
    const dir = tmp()
    try {
      const io = fakeIo([])
      const res = await runInteractiveConfig({ fields: [], io, configPath: join(dir, 'config.json') })
      assertEq(res.collected.length, 0, 'nothing collected')
      assertEq(res.saved, false, 'not saved')
      assertEq(io.asked.length, 0, 'no questions asked')
      assert(!existsSync(join(dir, 'config.json')), 'no config written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('collect + confirm-yes persists to config.json and seeds env', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_URL
    delete process.env.SLAYZONE_HUB_PUBLIC_URL
    try {
      // answer: the value, then 'y' to the save confirm.
      const io = fakeIo(['https://hub.example.com', 'y'])
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          { configKey: 'publicUrl', envKey: 'SLAYZONE_HUB_PUBLIC_URL', label: 'Public URL' }
        ]
      })
      assertEq(res.saved, true, 'saved')
      assertEq(res.collected.length, 1, 'one collected')
      assertEq(process.env.SLAYZONE_HUB_PUBLIC_URL, 'https://hub.example.com', 'env seeded')
      assertEq(loadSlayzoneConfig(cfgPath).publicUrl, 'https://hub.example.com', 'persisted to file')
      assert(io.closed === false, 'injected io NOT closed by the runner')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
      else process.env.SLAYZONE_HUB_PUBLIC_URL = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('confirm-no seeds env for this run but does NOT persist', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_URL
    delete process.env.SLAYZONE_HUB_PUBLIC_URL
    try {
      const io = fakeIo(['https://hub.example.com', 'n'])
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [{ configKey: 'publicUrl', envKey: 'SLAYZONE_HUB_PUBLIC_URL', label: 'Public URL' }]
      })
      assertEq(res.saved, false, 'not saved')
      assertEq(process.env.SLAYZONE_HUB_PUBLIC_URL, 'https://hub.example.com', 'env still seeded')
      assert(!existsSync(cfgPath), 'config file NOT written')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
      else process.env.SLAYZONE_HUB_PUBLIC_URL = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('empty answer with no default is skipped (not collected/seeded)', async () => {
    const dir = tmp()
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_URL
    delete process.env.SLAYZONE_HUB_PUBLIC_URL
    try {
      const io = fakeIo(['']) // Enter on the only field, no default → skip
      const res = await runInteractiveConfig({
        io,
        configPath: join(dir, 'config.json'),
        fields: [{ configKey: 'publicUrl', envKey: 'SLAYZONE_HUB_PUBLIC_URL', label: 'Public URL' }]
      })
      assertEq(res.collected.length, 0, 'nothing collected')
      assertEq(process.env.SLAYZONE_HUB_PUBLIC_URL, undefined, 'env NOT seeded')
      assert(!existsSync(join(dir, 'config.json')), 'no config written')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
      else process.env.SLAYZONE_HUB_PUBLIC_URL = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('empty answer WITH a default collects the default', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_RUNNER_ALLOWED_ROOTS
    delete process.env.SLAYZONE_RUNNER_ALLOWED_ROOTS
    try {
      const io = fakeIo(['', 'y']) // Enter accepts default, then save
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          {
            configKey: 'allowedRoots',
            envKey: 'SLAYZONE_RUNNER_ALLOWED_ROOTS',
            label: 'Roots',
            default: '/work',
            transform: (raw) => ({ config: [raw], env: raw })
          }
        ]
      })
      assertEq(res.collected.length, 1, 'default collected')
      assertEq(process.env.SLAYZONE_RUNNER_ALLOWED_ROOTS, '/work', 'env seeded with default')
      const roots = loadSlayzoneConfig(cfgPath).allowedRoots
      assert(Array.isArray(roots) && roots[0] === '/work', 'persisted array')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_RUNNER_ALLOWED_ROOTS
      else process.env.SLAYZONE_RUNNER_ALLOWED_ROOTS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('save merges over existing config keys (does not clobber)', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_URL
    delete process.env.SLAYZONE_HUB_PUBLIC_URL
    try {
      // Pre-seed an unrelated key.
      const { saveSlayzoneConfig } = await import('./slayzone-config')
      saveSlayzoneConfig({ port: 9999 }, cfgPath)
      const io = fakeIo(['https://hub.example.com', 'y'])
      await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [{ configKey: 'publicUrl', envKey: 'SLAYZONE_HUB_PUBLIC_URL', label: 'Public URL' }]
      })
      const cfg = loadSlayzoneConfig(cfgPath)
      assertEq(cfg.port, 9999, 'pre-existing key preserved')
      assertEq(cfg.publicUrl, 'https://hub.example.com', 'new key merged in')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
      else process.env.SLAYZONE_HUB_PUBLIC_URL = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
