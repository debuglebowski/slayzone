/**
 * The hub's workspace filesystem with no computer: project folders live on
 * computers, so every call — read, write, browse, watch, git status — is the
 * actionable "connect a computer", on any hub. Nothing here touches a disk.
 */
import { describe, expect, test } from 'vitest'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { getWorkspaceDeps } from './workspace-deps'

const refusal = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

describe('no computer: the default workspace fs', () => {
  const fs = getWorkspaceDeps().fs
  const calls: Array<[string, () => unknown]> = [
    ['readFile', () => fs.readFile(null, '/', 'etc/hosts')],
    ['writeFile', () => fs.writeFile(null, '/tmp', 'x', 'y')],
    ['listDir', () => fs.listDir(null, '/')],
    ['pathExists', () => fs.pathExists(null, '/')],
    ['gitStatus', () => fs.gitStatus(null, '/')],
    ['discoverRepos', () => fs.discoverRepos(null, '/')],
    ['watch', () => fs.watch(null, '/', () => undefined)]
  ]
  for (const [name, call] of calls) {
    test(`${name}: "connect a computer"`, async () => {
      const err = await refusal(call)
      expect(isHubSwitchedOffError(err)).toBe(true)
      expect((err as Error).message).toMatch(/Connect a computer/)
    })
  }
})
