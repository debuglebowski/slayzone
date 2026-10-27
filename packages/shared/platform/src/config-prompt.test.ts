/**
 * config-prompt — interactive first-run setup for the standalone hub + computer.
 * Pure Node (real temp files, a scripted fake IO — no TTY, no native deps) → runs
 * under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/config-prompt.test.ts
 */
import { describe, expect, test } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canPrompt, confirm, runInteractiveConfig, type PromptIO } from './config-prompt'
import { updateJsonFile } from './slayzone-config'

/** config-prompt.ts is role-agnostic now (writes an arbitrary JSON object at
 *  whatever path the caller names) — read persisted values back as raw JSON
 *  rather than through a role-specific loader. */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-prompt-'))
}

/** A fake IO that feeds a fixed queue of answers and records everything written. */
function fakeIo(
  answers: string[]
): PromptIO & { asked: string[]; written: string[]; closed: boolean } {
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
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): void | Promise<void> {
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

describe('config-prompt: canPrompt', () => {
  test('canPrompt false when stdin is not a TTY (test env)', () => {
    // The test harness stdin is a pipe (isTTY undefined) → never interactive.
    withEnv({ SLAYZONE_SUPERVISED: undefined, SLAYZONE_NONINTERACTIVE: undefined }, () => {
      expect(canPrompt(), 'non-TTY ⇒ false').toBe(false)
    })
  })

  test('canPrompt false under SLAYZONE_SUPERVISED / SLAYZONE_NONINTERACTIVE', () => {
    withEnv({ SLAYZONE_SUPERVISED: '1' }, () => expect(canPrompt(), 'supervised ⇒ false').toBe(false))
    withEnv({ SLAYZONE_NONINTERACTIVE: '1' }, () =>
      expect(canPrompt(), 'noninteractive ⇒ false').toBe(false)
    )
  })
})

describe('config-prompt: confirm', () => {
  test('confirm defaults yes on empty [Y/n], no on empty [y/N]', async () => {
    expect(await confirm(fakeIo(['']), 'ok?', { defaultYes: true }), 'empty ⇒ default yes').toBe(true)
    expect(await confirm(fakeIo(['']), 'ok?', { defaultYes: false }), 'empty ⇒ default no').toBe(false)
    expect(await confirm(fakeIo(['y']), 'ok?', { defaultYes: false }), 'y ⇒ yes').toBe(true)
    expect(await confirm(fakeIo(['nope']), 'ok?', { defaultYes: true }), 'nope ⇒ no').toBe(false)
  })
})

describe('config-prompt: runInteractiveConfig', () => {
  test('no missing fields ⇒ nothing collected, no confirm, no write', async () => {
    const dir = tmp()
    try {
      const io = fakeIo([])
      const res = await runInteractiveConfig({
        fields: [],
        io,
        configPath: join(dir, 'config.json')
      })
      expect(res.collected.length, 'nothing collected').toBe(0)
      expect(res.saved, 'not saved').toBe(false)
      expect(io.asked.length, 'no questions asked').toBe(0)
      expect(existsSync(join(dir, 'config.json')), 'no config written').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('collect + confirm-yes persists to config.json and seeds env', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    try {
      // answer: the value, then 'y' to the save confirm.
      const io = fakeIo(['hub.example.com:8443', 'y'])
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          {
            configKey: 'publicAddress',
            envKey: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
            label: 'Public address'
          }
        ]
      })
      expect(res.saved, 'saved').toBe(true)
      expect(res.collected.length, 'one collected').toBe(1)
      expect(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'env seeded').toBe('hub.example.com:8443')
      expect(readJson(cfgPath).publicAddress, 'persisted to file').toBe('hub.example.com:8443')
      expect(io.closed, 'injected io NOT closed by the computer').toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
      else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('confirm-no seeds env for this run but does NOT persist', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    try {
      const io = fakeIo(['hub.example.com:8443', 'n'])
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          {
            configKey: 'publicAddress',
            envKey: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
            label: 'Public address'
          }
        ]
      })
      expect(res.saved, 'not saved').toBe(false)
      expect(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'env still seeded').toBe('hub.example.com:8443')
      expect(existsSync(cfgPath), 'config file NOT written').toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
      else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty answer with no default is skipped (not collected/seeded)', async () => {
    const dir = tmp()
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    try {
      const io = fakeIo(['']) // Enter on the only field, no default → skip
      const res = await runInteractiveConfig({
        io,
        configPath: join(dir, 'config.json'),
        fields: [
          {
            configKey: 'publicAddress',
            envKey: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
            label: 'Public address'
          }
        ]
      })
      expect(res.collected.length, 'nothing collected').toBe(0)
      expect(process.env.SLAYZONE_HUB_PUBLIC_ADDRESS, 'env NOT seeded').toBe(undefined)
      expect(existsSync(join(dir, 'config.json')), 'no config written').toBe(false)
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
      else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty answer WITH a default collects the default', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_COMPUTER_ALLOWED_ROOTS
    delete process.env.SLAYZONE_COMPUTER_ALLOWED_ROOTS
    try {
      const io = fakeIo(['', 'y']) // Enter accepts default, then save
      const res = await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          {
            configKey: 'allowedRoots',
            envKey: 'SLAYZONE_COMPUTER_ALLOWED_ROOTS',
            label: 'Roots',
            default: '/work',
            transform: (raw) => ({ config: [raw], env: raw })
          }
        ]
      })
      expect(res.collected.length, 'default collected').toBe(1)
      expect(process.env.SLAYZONE_COMPUTER_ALLOWED_ROOTS, 'env seeded with default').toBe('/work')
      const roots = readJson(cfgPath).allowedRoots
      expect(roots, 'persisted array').toEqual(['/work'])
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_COMPUTER_ALLOWED_ROOTS
      else process.env.SLAYZONE_COMPUTER_ALLOWED_ROOTS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('save merges over existing config keys (does not clobber)', async () => {
    const dir = tmp()
    const cfgPath = join(dir, 'config.json')
    const prevEnv = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    try {
      // Pre-seed an unrelated key.
      updateJsonFile({ address: '0.0.0.0:9999' }, cfgPath)
      const io = fakeIo(['hub.example.com:8443', 'y'])
      await runInteractiveConfig({
        io,
        configPath: cfgPath,
        fields: [
          {
            configKey: 'publicAddress',
            envKey: 'SLAYZONE_HUB_PUBLIC_ADDRESS',
            label: 'Public address'
          }
        ]
      })
      const cfg = readJson(cfgPath)
      expect(cfg.address, 'pre-existing key preserved').toBe('0.0.0.0:9999')
      expect(cfg.publicAddress, 'new key merged in').toBe('hub.example.com:8443')
    } finally {
      if (prevEnv === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
      else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prevEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
