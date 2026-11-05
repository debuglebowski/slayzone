/**
 * The desktop app with its local computer reachable ONLY over WebRTC (docs/direct-link.md):
 * the computer's direct listener binds a wildcard address and advertises no address a
 * client could dial, so the hub offers the WebRTC path instead — brokered over the
 * links it already has, connected over host candidates on this machine.
 *
 * Import `test` from HERE in a spec that needs it: overriding `appExtraEnv` gives the
 * spec its own worker (Playwright never shares a worker across fixture sets).
 */
import { test as base } from './electron'

export { expect, resetApp, seed, TEST_PROJECT_PATH } from './electron'

export const test = base.extend<object, { appExtraEnv: Record<string, string> }>({
  appExtraEnv: [
    async ({}, use) => {
      await use({ SLAYZONE_COMPUTER_LISTEN_ADDRESS: '0.0.0.0:0' })
    },
    { scope: 'worker' }
  ]
})
