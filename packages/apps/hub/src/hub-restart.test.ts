/**
 * A hub restarts itself by exiting with a dedicated code (75, EX_TEMPFAIL) and
 * letting whatever runs it start it again (decision D2). Who that is decides whether
 * the restart is automatic: the desktop app, launchd or systemd — or nobody, when an
 * operator started the hub by hand (D6: allowed, the UI warns).
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  detectHubRespawner,
  HUB_RESTART_EXIT_CODE,
  requestHubRestart,
  setHubRestartHandler
} from './hub-restart.js'

afterEach(() => setHubRestartHandler(null))

describe('hub restart', () => {
  test('exit code is 75', () => {
    expect(HUB_RESTART_EXIT_CODE).toBe(75)
  })

  test('requestHubRestart reaches the handler the entrypoint installed', () => {
    const handler = vi.fn()
    setHubRestartHandler(handler)
    expect(requestHubRestart('restore')).toBe(true)
    expect(handler).toHaveBeenCalledWith('restore')
  })

  test('no handler (an embedded hub): nothing happens, and the caller is told', () => {
    expect(requestHubRestart('restore')).toBe(false)
  })
})

describe('detectHubRespawner', () => {
  const none = () => null
  test('the desktop app supervises it', () => {
    expect(detectHubRespawner({ supervised: true, name: 'h', env: {}, readCgroup: none })).toBe(
      'desktop'
    )
  })

  test("launchd: this hub's own label", () => {
    expect(
      detectHubRespawner({
        supervised: false,
        name: 'prod',
        env: { XPC_SERVICE_NAME: 'com.slayzone.hub.prod' },
        readCgroup: none
      })
    ).toBe('launchd')
  })

  test("launchd: a terminal app's XPC name is not a respawner", () => {
    expect(
      detectHubRespawner({
        supervised: false,
        name: 'prod',
        env: { XPC_SERVICE_NAME: 'application.com.apple.Terminal.1234' },
        readCgroup: none
      })
    ).toBeNull()
  })

  test("systemd: this hub's own unit in the cgroup", () => {
    expect(
      detectHubRespawner({
        supervised: false,
        name: 'prod',
        env: { INVOCATION_ID: 'x' },
        readCgroup: () =>
          '0::/user.slice/user-1000.slice/user@1000.service/app.slice/slayzone-hub-prod.service\n'
      })
    ).toBe('systemd')
  })

  test('systemd: INVOCATION_ID inherited from a terminal service is not enough', () => {
    expect(
      detectHubRespawner({
        supervised: false,
        name: 'prod',
        env: { INVOCATION_ID: 'x' },
        readCgroup: () =>
          '0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope\n'
      })
    ).toBeNull()
  })

  test('started by hand: nobody restarts it', () => {
    expect(
      detectHubRespawner({ supervised: false, name: 'prod', env: {}, readCgroup: none })
    ).toBeNull()
  })
})
