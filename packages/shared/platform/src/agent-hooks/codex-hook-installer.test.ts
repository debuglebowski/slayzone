import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import {
  installCodexHooks,
  uninstallCodexWrapper,
  CODEX_HOOK_EVENTS,
  isManagedSlayzoneHook
} from './codex-hook-installer'

const SCRIPT = '/tmp/.slayzone/hooks/notify.sh'
// formatHookCommand leaves a clean POSIX path bare; the installer prefixes `bash`.
const EXPECTED_CMD = `bash ${SCRIPT}`

function tmpHooks(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-codex-installer-'))
  return path.join(dir, '.codex', 'hooks.json')
}

function cleanup(p: string) {
  try {
    fs.rmSync(path.dirname(path.dirname(p)), { recursive: true, force: true })
  } catch {}
}

function readJson(p: string): { hooks?: Record<string, unknown[]>; [k: string]: unknown } {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

describe('installCodexHooks', () => {
  test('creates hooks.json when missing, adds all 6 events', async () => {
    const target = tmpHooks()
    try {
      const r = await installCodexHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipVersionProbe: true
      })
      expect(r.installed).toBe(true)
      expect(r.eventsAdded).toEqual([...CODEX_HOOK_EVENTS])
      const data = readJson(target)
      expect(data.hooks).toBeDefined()
      for (const ev of CODEX_HOOK_EVENTS) {
        const list = (data.hooks as Record<string, unknown[]>)[ev]
        expect(Array.isArray(list)).toBe(true)
        expect(list.length).toBe(1)
      }
    } finally {
      cleanup(target)
    }
  })

  test('hook command is an explicit bash invocation of notify.sh', async () => {
    const target = tmpHooks()
    try {
      await installCodexHooks({ scriptPath: SCRIPT, hooksPath: target, skipVersionProbe: true })
      const data = readJson(target)
      const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
      expect(hooks.SessionStart[0].hooks[0].command).toBe(EXPECTED_CMD)
    } finally {
      cleanup(target)
    }
  })

  test('preserves pre-existing user hooks on same event', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userEntry = { hooks: [{ type: 'command', command: '/my/custom/script.sh' }] }
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [userEntry] } }))
    try {
      const r = await installCodexHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipVersionProbe: true
      })
      expect(r.installed).toBe(true)
      const data = readJson(target)
      const stopList = (data.hooks as Record<string, unknown[]>).Stop as Array<{ hooks: unknown[] }>
      expect(stopList.length).toBe(2)
      const stillThere = stopList.some((e) =>
        (e.hooks as Array<{ command?: string }>).some((h) => h.command === '/my/custom/script.sh')
      )
      expect(stillThere).toBe(true)
    } finally {
      cleanup(target)
    }
  })

  test('replaces stale managed entry (no duplicate)', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const stale = {
      hooks: [
        { type: 'command', command: 'bash /old/.slayzone/hooks/notify.sh', _slayzoneManaged: true }
      ]
    }
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [stale] } }))
    try {
      await installCodexHooks({ scriptPath: SCRIPT, hooksPath: target, skipVersionProbe: true })
      const data = readJson(target)
      const stopList = (data.hooks as Record<string, unknown[]>).Stop as Array<{
        hooks: Array<{ command: string }>
      }>
      expect(stopList.length).toBe(1)
      expect(stopList[0].hooks[0].command).toBe(EXPECTED_CMD)
    } finally {
      cleanup(target)
    }
  })

  test('refuses to overwrite malformed JSON', async () => {
    const target = tmpHooks()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ this is not json')
    try {
      const r = await installCodexHooks({
        scriptPath: SCRIPT,
        hooksPath: target,
        skipVersionProbe: true
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
      await installCodexHooks({ scriptPath: SCRIPT, hooksPath: target, skipVersionProbe: true })
      const first = fs.readFileSync(target, 'utf8')
      await installCodexHooks({ scriptPath: SCRIPT, hooksPath: target, skipVersionProbe: true })
      const second = fs.readFileSync(target, 'utf8')
      expect(first).toBe(second)
    } finally {
      cleanup(target)
    }
  })

  test('uses match-all matcher for tool-scoped events only', async () => {
    const target = tmpHooks()
    try {
      await installCodexHooks({ scriptPath: SCRIPT, hooksPath: target, skipVersionProbe: true })
      const data = readJson(target)
      const hooks = data.hooks as Record<string, Array<{ matcher?: string }>>
      expect(hooks.PreToolUse[0].matcher).toBe('.*')
      expect(hooks.PostToolUse[0].matcher).toBe('.*')
      expect(hooks.SessionStart[0].matcher).toBeUndefined()
      expect(hooks.Stop[0].matcher).toBeUndefined()
      expect(hooks.PermissionRequest[0].matcher).toBeUndefined()
    } finally {
      cleanup(target)
    }
  })
})

describe('uninstallCodexWrapper', () => {
  test('removes the legacy bash wrapper identified by its marker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-codex-wrapper-'))
    const wrapperPath = path.join(dir, 'codex')
    fs.writeFileSync(wrapperPath, '#!/bin/bash\n# slayzone codex wrapper v1\nexec codex "$@"\n')
    try {
      const removed = await uninstallCodexWrapper({ wrapperPath })
      expect(removed).toBe(true)
      expect(fs.existsSync(wrapperPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('leaves a non-SlayZone file untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-codex-wrapper-'))
    const wrapperPath = path.join(dir, 'codex')
    fs.writeFileSync(wrapperPath, '#!/bin/bash\n# user-owned codex\n')
    try {
      const removed = await uninstallCodexWrapper({ wrapperPath })
      expect(removed).toBe(false)
      expect(fs.existsSync(wrapperPath)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('idempotent — no-op when nothing is installed', async () => {
    const removed = await uninstallCodexWrapper({
      wrapperPath: path.join(os.tmpdir(), 'slayzone-nonexistent', 'codex')
    })
    expect(removed).toBe(false)
  })
})

describe('isManagedSlayzoneHook', () => {
  test('matches by marker', () => {
    expect(isManagedSlayzoneHook({ type: 'command', command: 'x', _slayzoneManaged: true })).toBe(
      true
    )
  })

  test('matches by notify-script substring', () => {
    expect(
      isManagedSlayzoneHook({ type: 'command', command: 'bash /home/x/.slayzone/hooks/notify.sh' })
    ).toBe(true)
  })

  test('does not match unrelated hooks', () => {
    expect(isManagedSlayzoneHook({ type: 'command', command: '/usr/bin/echo' })).toBe(false)
    expect(isManagedSlayzoneHook(null)).toBe(false)
    expect(isManagedSlayzoneHook({})).toBe(false)
  })
})
