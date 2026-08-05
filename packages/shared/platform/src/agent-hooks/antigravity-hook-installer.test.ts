import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { installAntigravityHooks, ANTIGRAVITY_HOOK_EVENTS } from './antigravity-hook-installer'

const SCRIPT = '/tmp/.slayzone/hooks/notify.sh'

function tmpHooks(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-antigravity-installer-'))
  return path.join(dir, '.gemini', 'config', 'hooks.json')
}

function cleanup(p: string) {
  try {
    // <tmpdir>/.gemini/config/hooks.json → remove <tmpdir>
    fs.rmSync(path.dirname(path.dirname(path.dirname(p))), { recursive: true, force: true })
  } catch {}
}

function readJson(p: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

describe('installAntigravityHooks', () => {
  test('creates hooks.json when missing, slayzone-notify has all events', async () => {
    const target = tmpHooks()
    try {
      const r = await installAntigravityHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipBinaryProbe: true
      })
      expect(r.installed).toBe(true)
      expect(r.eventsAdded).toEqual([...ANTIGRAVITY_HOOK_EVENTS])
      const data = readJson(target)
      const named = data['slayzone-notify']
      expect(named).toBeDefined()
      for (const ev of ANTIGRAVITY_HOOK_EVENTS) {
        const list = named[ev] as unknown[]
        expect(Array.isArray(list)).toBe(true)
        expect(list.length).toBe(1)
      }
    } finally {
      cleanup(target)
    }
  })

  test('handler command carries the event name as an argv arg', async () => {
    const target = tmpHooks()
    try {
      await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target, skipBinaryProbe: true })
      const named = readJson(target)['slayzone-notify']
      const entry = (named.PreInvocation as Array<{ hooks: Array<{ command: string }> }>)[0]
      expect(entry.hooks[0].command).toBe(`${SCRIPT} PreInvocation`)
      const stopEntry = (named.Stop as Array<{ hooks: Array<{ command: string }> }>)[0]
      expect(stopEntry.hooks[0].command).toBe(`${SCRIPT} Stop`)
    } finally {
      cleanup(target)
    }
  })

  test('PostToolUse gets matcher "*", PreInvocation/Stop get none', async () => {
    const target = tmpHooks()
    try {
      await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target, skipBinaryProbe: true })
      const named = readJson(target)['slayzone-notify']
      expect((named.PostToolUse as Array<{ matcher?: string }>)[0].matcher).toBe('*')
      expect((named.PreInvocation as Array<{ matcher?: string }>)[0].matcher).toBeUndefined()
      expect((named.Stop as Array<{ matcher?: string }>)[0].matcher).toBeUndefined()
    } finally {
      cleanup(target)
    }
  })

  test('preserves other named hooks in the file', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userHook = { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: '/my/lint.sh' }] }] }
    fs.writeFileSync(target, JSON.stringify({ 'user-linter': userHook }))
    try {
      const r = await installAntigravityHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipBinaryProbe: true
      })
      expect(r.installed).toBe(true)
      const data = readJson(target)
      expect(data['user-linter']).toEqual(userHook)
      expect(data['slayzone-notify']).toBeDefined()
    } finally {
      cleanup(target)
    }
  })

  test('overwrites a stale slayzone-notify key entirely (no leftover events)', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify({
        'slayzone-notify': { SessionStart: [{ hooks: [{ command: '/old/notify.sh' }] }] }
      })
    )
    try {
      await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target, skipBinaryProbe: true })
      const named = readJson(target)['slayzone-notify']
      expect(named.SessionStart).toBeUndefined()
      expect(Object.keys(named).sort()).toEqual([...ANTIGRAVITY_HOOK_EVENTS].sort())
    } finally {
      cleanup(target)
    }
  })

  test('refuses to overwrite malformed JSON', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ this is not json')
    try {
      const r = await installAntigravityHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipBinaryProbe: true
      })
      expect(r.installed).toBe(false)
      expect(r.reason).toMatch(/not valid JSON/)
      expect(fs.readFileSync(target, 'utf8')).toBe('{ this is not json')
    } finally {
      cleanup(target)
    }
  })

  test('idempotent — rerun produces same file content', async () => {
    const target = tmpHooks()
    try {
      await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target, skipBinaryProbe: true })
      const first = fs.readFileSync(target, 'utf8')
      await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target, skipBinaryProbe: true })
      const second = fs.readFileSync(target, 'utf8')
      expect(first).toBe(second)
    } finally {
      cleanup(target)
    }
  })

  test('skips install when agy binary absent', async () => {
    const target = tmpHooks()
    const origPath = process.env.PATH
    const origE2E = process.env.SLAYZONE_E2E_INSTALL_HOOKS
    process.env.PATH = '/nonexistent-dir'
    delete process.env.SLAYZONE_E2E_INSTALL_HOOKS
    try {
      const r = await installAntigravityHooks({ scriptPath: SCRIPT, hooksPath: target })
      expect(r.installed).toBe(false)
      expect(r.reason).toMatch(/agy binary not on PATH/)
      expect(fs.existsSync(target)).toBe(false)
    } finally {
      process.env.PATH = origPath
      if (origE2E !== undefined) process.env.SLAYZONE_E2E_INSTALL_HOOKS = origE2E
      cleanup(target)
    }
  })
})
