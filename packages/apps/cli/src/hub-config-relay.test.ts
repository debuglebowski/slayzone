/**
 * hub-config — the computer-issued CLI relay is chosen by its credentials, not
 * by whether the process is a task terminal.
 *
 * A computer issues `SLAYZONE_CLI_RELAY_ADDRESS` + `SLAYZONE_CLI_RELAY_TOKEN` per
 * spawned process and strips any it inherited (spawn-env.ts), so their presence
 * already proves the computer launched this process. Gating them on
 * `SLAYZONE_TASK_ID` broke every non-terminal spawn: the banner's setup
 * (`slay init`) fell through to `SLAYZONE_HUB_ADDRESS` with no token → 401.
 *
 * Pure Node.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { resolveTaskCommandTarget } from './hub-config'

const KEYS = [
  'SLAYZONE_TASK_ID',
  'SLAYZONE_CLI_RELAY_ADDRESS',
  'SLAYZONE_CLI_RELAY_TOKEN',
  'SLAYZONE_HUB_ADDRESS',
  'SLAYZONE_HUB_TOKEN'
]
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function relayEnv(): void {
  process.env.SLAYZONE_CLI_RELAY_ADDRESS = '127.0.0.1:45001'
  process.env.SLAYZONE_CLI_RELAY_TOKEN = 'capability'
  process.env.SLAYZONE_HUB_ADDRESS = 'hub.example.com'
}

test('computer-spawned process without a task id uses the relay', () => {
  relayEnv()
  expect(resolveTaskCommandTarget()).toMatchObject({
    baseUrl: 'http://127.0.0.1:45001',
    token: 'capability',
    source: 'relay'
  })
})

test('task terminal still uses the relay', () => {
  relayEnv()
  process.env.SLAYZONE_TASK_ID = 'task-1'
  expect(resolveTaskCommandTarget()).toMatchObject({ source: 'relay', token: 'capability' })
})

test('no relay credentials → hub address, unchanged', () => {
  process.env.SLAYZONE_HUB_ADDRESS = 'hub.example.com'
  expect(resolveTaskCommandTarget()).toMatchObject({
    baseUrl: 'https://hub.example.com',
    source: 'env'
  })
})
