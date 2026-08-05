import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import {
  installClaudeHooks,
  CLAUDE_HOOK_EVENTS,
  isManagedSlayzoneHook
} from './claude-hook-installer'

const SCRIPT = '/tmp/.slayzone/hooks/notify.sh'

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-claude-installer-'))
  return path.join(dir, '.claude', 'settings.json')
}

function cleanup(p: string) {
  try {
    fs.rmSync(path.dirname(path.dirname(p)), { recursive: true, force: true })
  } catch {}
}

function readJson(p: string): { hooks?: Record<string, unknown[]>; [k: string]: unknown } {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

describe('installClaudeHooks', () => {
  test('creates settings.json when missing, adds all 9 events', async () => {
    const target = tmpSettings()
    try {
      const r = await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      expect(r.installed).toBe(true)
      expect(r.eventsAdded).toEqual([...CLAUDE_HOOK_EVENTS])
      const data = readJson(target)
      expect(data.hooks).toBeDefined()
      for (const ev of CLAUDE_HOOK_EVENTS) {
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
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [userEntry] } }))
    try {
      const r = await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      expect(r.installed).toBe(true)
      const data = readJson(target)
      const stopList = (data.hooks as Record<string, unknown[]>).Stop as Array<{ hooks: unknown[] }>
      expect(stopList.length).toBe(2)
      // User entry preserved.
      const stillThere = stopList.some((e) =>
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
    // Simulate a stale managed entry from a previous install at a different path.
    const stale = {
      hooks: [
        { type: 'command', command: '/old/.slayzone/hooks/notify.sh', _slayzoneManaged: true }
      ]
    }
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [stale] } }))
    try {
      await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      const data = readJson(target)
      const stopList = (data.hooks as Record<string, unknown[]>).Stop as Array<{
        hooks: Array<{ command: string }>
      }>
      // Only one entry, pointing at the new script path.
      expect(stopList.length).toBe(1)
      expect(stopList[0].hooks[0].command).toBe(SCRIPT)
    } finally {
      cleanup(target)
    }
  })

  test('refuses to overwrite malformed JSON', async () => {
    const target = tmpSettings()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ this is not json')
    try {
      const r = await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      expect(r.installed).toBe(false)
      expect(r.reason).toMatch(/not valid JSON/)
      // File untouched.
      expect(fs.readFileSync(target, 'utf8')).toBe('{ this is not json')
    } finally {
      cleanup(target)
    }
  })

  test('idempotent — rerun produces same file content', async () => {
    const target = tmpSettings()
    try {
      await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      const first = fs.readFileSync(target, 'utf8')
      await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      const second = fs.readFileSync(target, 'utf8')
      expect(first).toBe(second)
    } finally {
      cleanup(target)
    }
  })

  test('uses matcher "*" for tool-scoped events', async () => {
    const target = tmpSettings()
    try {
      await installClaudeHooks({ scriptPath: SCRIPT, settingsPath: target })
      const data = readJson(target)
      const hooks = data.hooks as Record<string, Array<{ matcher?: string }>>
      expect(hooks.PreToolUse[0].matcher).toBe('*')
      expect(hooks.PostToolUse[0].matcher).toBe('*')
      expect(hooks.Notification[0].matcher).toBe('*')
      expect(hooks.Stop[0].matcher).toBeUndefined()
    } finally {
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
