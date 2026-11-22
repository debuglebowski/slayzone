/**
 * `HOST_APP_ROUTERS` / `HUB_APP_ROUTERS` (`@slayzone/transport/host-paths`) decide
 * which `app.*` routers a remote hub's client forwards to the local hub (the only
 * one bridged to the Electron host). Cross-checked here against the LIVE router:
 * a new `app.*` router fails until it is placed in exactly one of the two sets.
 */
import { describe, expect, test } from 'vitest'
import { appRouter } from './router'
import {
  HOST_APP_ROUTERS,
  HUB_APP_ROUTERS,
  HUB_MENU_PROCEDURES,
  isHostPath
} from '@slayzone/transport/host-paths'

const LIVE_APP_ROUTERS = [
  ...new Set(
    Object.keys(appRouter._def.procedures)
      .filter((p) => p.startsWith('app.'))
      .map((p) => p.split('.')[1])
  )
].sort()

describe('host-paths classification', () => {
  test('every live app.* router is classified exactly once', () => {
    const classified = [...HOST_APP_ROUTERS, ...HUB_APP_ROUTERS].sort()
    expect(new Set(classified).size, 'a router is in both sets').toBe(classified.length)
    expect(classified).toEqual(LIVE_APP_ROUTERS)
  })

  test('menu is host; hub-data and non-app paths are not', () => {
    expect(isHostPath('menu.onCloseCurrentFocus')).toBe(true)
    expect(isHostPath('app.shell.openExternal')).toBe(true)
    expect(isHostPath('app.backup.list')).toBe(false)
    expect(isHostPath('task.getAll')).toBe(false)
    expect(isHostPath('app')).toBe(false)
  })

  test('hub-raised menu streams stay on the hub that raised them', () => {
    expect(isHostPath('menu.onOpenTask')).toBe(false)
    expect(isHostPath('menu.onCloseTask')).toBe(false)
    expect(isHostPath('menu.onOpenArtifact')).toBe(false)
    expect(isHostPath('menu.onGoHome')).toBe(true)
  })

  test('every hub-raised menu stream is a live procedure', () => {
    const live = new Set(Object.keys(appRouter._def.procedures))
    for (const path of HUB_MENU_PROCEDURES) expect(live.has(path), path).toBe(true)
  })
})
