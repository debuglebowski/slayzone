import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import {
  installGeminiHooks,
  GEMINI_HOOK_EVENTS,
  isManagedSlayzoneHook
} from './gemini-hook-installer'

const SCRIPT = '/tmp/.slayzone/hooks/notify.sh'

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-gemini-installer-'))
  return path.join(dir, '.gemini', 'settings.json')
}

function cleanup(p: string) {
  try {
    fs.rmSync(path.dirname(path.dirname(p)), { recursive: true, force: true })
  } catch {}
}

function readJson(p: string): { hooks?: Record<string, unknown[]>; [k: string]: unknown } {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

describe('installGeminiHooks', () => {
  test('creates settings.json when missing, adds all 5 events', async () => {
    const target = tmpSettings()
    try {
      const r = await installGeminiHooks({
        scriptPath: SCRIPT,
        settingsPath: target,
        skipBinaryProbe: true
      })
      expect(r.installed).toBe(true)
      expect(r.eventsAdded).toEqual([...GEMINI_HOOK_EVENTS])
      const data = readJson(target)
      expect(data.hooks).toBeDefined()
      for (const ev of GEMINI_HOOK_EVENTS) {
        const list = (data.hooks as Record<string, unknown[]>)[ev]
        expect(Array.isArray(list)).toBe(true)
        expect(list.length).toBe(1)
      }
    } finally {
      cleanup(target)
    }
  })

  test('preserves pre-existing user hooks on same event', async () => {
    const target = tmpSettings()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userEntry = { hooks: [{ type: 'command', command: '/my/custom/script.sh' }] }
    fs.writeFileSync(target, JSON.stringify({ hooks: { AfterAgent: [userEntry] } }))
    try {
      const r = await installGeminiHooks({
        scriptPath: SCRIPT,
        settingsPath: target,
        skipBinaryProbe: true
      })
      expect(r.installed).toBe(true)
      const data = readJson(target)
      const list = (data.hooks as Record<string, unknown[]>).AfterAgent as Array<{
        hooks: unknown[]
      }>
      expect(list.length).toBe(2)
      const stillThere = list.some((e) =>
        (e.hooks as Array<{ command?: string }>).some((h) => h.command === '/my/custom/script.sh')
      )
      expect(stillThere).toBe(true)
    } finally {
      cleanup(target)
    }
  })

  test('replaces stale managed entry (no duplicate)', async () => {
    const target = tmpSettings()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const stale = {
      hooks: [
        { type: 'command', command: '/old/.slayzone/hooks/notify.sh', _slayzoneManaged: true }
      ]
    }
    fs.writeFileSync(target, JSON.stringify({ hooks: { AfterAgent: [stale] } }))
    try {
      await installGeminiHooks({ scriptPath: SCRIPT, settingsPath: target, skipBinaryProbe: true })
      const data = readJson(target)
      const list = (data.hooks as Record<string, unknown[]>).AfterAgent as Array<{
        hooks: Array<{ command: string }>
      }>
      expect(list.length).toBe(1)
      expect(list[0].hooks[0].command).toBe(SCRIPT)
    } finally {
      cleanup(target)
    }
  })

  test('refuses to overwrite malformed JSON', async () => {
    const target = tmpSettings()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ this is not json')
    try {
      const r = await installGeminiHooks({
        scriptPath: SCRIPT,
        settingsPath: target,
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
    const target = tmpSettings()
    try {
      await installGeminiHooks({ scriptPath: SCRIPT, settingsPath: target, skipBinaryProbe: true })
      const first = fs.readFileSync(target, 'utf8')
      await installGeminiHooks({ scriptPath: SCRIPT, settingsPath: target, skipBinaryProbe: true })
      const second = fs.readFileSync(target, 'utf8')
      expect(first).toBe(second)
    } finally {
      cleanup(target)
    }
  })

  test('uses matcher "*" for AfterTool, none for lifecycle events', async () => {
    const target = tmpSettings()
    try {
      await installGeminiHooks({ scriptPath: SCRIPT, settingsPath: target, skipBinaryProbe: true })
      const data = readJson(target)
      const hooks = data.hooks as Record<string, Array<{ matcher?: string }>>
      expect(hooks.AfterTool[0].matcher).toBe('*')
      expect(hooks.BeforeAgent[0].matcher).toBeUndefined()
      expect(hooks.AfterAgent[0].matcher).toBeUndefined()
      expect(hooks.SessionStart[0].matcher).toBeUndefined()
      expect(hooks.SessionEnd[0].matcher).toBeUndefined()
    } finally {
      cleanup(target)
    }
  })

  test('skips install when gemini binary absent', async () => {
    const target = tmpSettings()
    const origPath = process.env.PATH
    const origE2E = process.env.SLAYZONE_E2E_INSTALL_HOOKS
    process.env.PATH = '/nonexistent-dir'
    delete process.env.SLAYZONE_E2E_INSTALL_HOOKS
    try {
      const r = await installGeminiHooks({ scriptPath: SCRIPT, settingsPath: target })
      expect(r.installed).toBe(false)
      expect(r.reason).toMatch(/gemini binary not on PATH/)
      expect(fs.existsSync(target)).toBe(false)
    } finally {
      process.env.PATH = origPath
      if (origE2E !== undefined) process.env.SLAYZONE_E2E_INSTALL_HOOKS = origE2E
      cleanup(target)
    }
  })
})

describe('isManagedSlayzoneHook', () => {
  test('matches by marker', () => {
    expect(isManagedSlayzoneHook({ type: 'command', command: 'x', _slayzoneManaged: true })).toBe(
      true
    )
  })

  test('matches by script path substring', () => {
    expect(
      isManagedSlayzoneHook({ type: 'command', command: '/home/x/.slayzone/hooks/notify.sh' })
    ).toBe(true)
  })

  test('does not match unrelated hooks', () => {
    expect(isManagedSlayzoneHook({ type: 'command', command: '/usr/bin/echo' })).toBe(false)
    expect(isManagedSlayzoneHook(null)).toBe(false)
    expect(isManagedSlayzoneHook({})).toBe(false)
  })
})
