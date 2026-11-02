import { TEST_ISOLATION_ENV } from '../../../shared/test-utils/caller-env.js'
import { afterAll, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HubDialer, createMemoryCredentialStore } from '@slayzone/computer-transport/client'
import { createComputerCliRelay, type ComputerCliRelay } from '../../computer/src/cli-relay'
import { bootInProcessHub, signedInUser } from './owner-checks-harness'

const originalCwd = process.cwd()
const cliBin = resolve(import.meta.dirname, '../../cli/dist/slay.js')
const exec = promisify(execFile)
let stop: (() => Promise<void>) | undefined
afterAll(async () => {
  process.chdir(originalCwd)
  await stop?.()
})

test('bundled remote CLI authenticates through a real hub connection, enforces ownership, initializes local files, and reconnects', async () => {
  const hub = await bootInProcessHub({ login: true })
  let dialer: HubDialer | undefined
  let relay: ComputerCliRelay | undefined
  stop = async () => {
    await relay?.close()
    await dialer?.stop()
    await hub.stop()
  }
  const alice = await signedInUser(hub, 'cli-alice@example.com')
  const bob = await signedInUser(hub, 'cli-bob@example.com')
  const minted = await fetch(`http://127.0.0.1:${hub.port}/api/computers/join-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'cli-test', forUser: 'cli-alice@example.com' })
  })
  expect(minted.status).toBe(200)
  const { token } = (await minted.json()) as { token: string }
  dialer = new HubDialer({
    url: `ws://127.0.0.1:${hub.port}/computers`,
    identity: {
      name: 'cli-test',
      platform: process.platform,
      version: 'test',
      capabilities: ['pty']
    },
    credentialStore: createMemoryCredentialStore(),
    joinToken: token,
    onHubRequest: async () => {
      throw new Error('No OS operations needed in this test')
    }
  })
  const connected = dialer.events.once('connected')
  dialer.start()
  await connected
  relay = await createComputerCliRelay(dialer)
  dialer.events.on('disconnected', () => relay?.disconnect())
  const capability = relay.issue()
  const projectDir = join(hub.root, 'remote-checkout')
  mkdirSync(projectDir)
  const db = new Database(hub.dbPath)
  try {
    for (const [project, owner] of [
      ['cli-a', alice.userId],
      ['cli-b', bob.userId]
    ]) {
      db.prepare(
        "INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, '#fff', ?)"
      ).run(project, project, owner)
      db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(
        `${project}-task`,
        project,
        project
      )
    }
    db.prepare(
      "INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at, owner_user_id) VALUES ('other-computer', 'other', 'linux', '1', '{}', 0, 0, ?)"
    ).run(bob.userId)
    for (const [computer, project] of [
      [dialer.computerId!, 'cli-a'],
      ['other-computer', 'cli-b']
    ]) {
      db.prepare(
        "INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at) VALUES (?, ?, ?, 'ready', ?)"
      ).run(computer, project, projectDir, Date.now())
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'ai_providers:cli-a',
      '["codex"]'
    )
  } finally {
    db.close()
  }

  const cliEnv = { ...process.env }
  for (const key of Object.keys(cliEnv))
    if (key.startsWith('SLAYZONE_') && !TEST_ISOLATION_ENV.has(key)) delete cliEnv[key]
  Object.assign(cliEnv, {
    SLAYZONE_TASK_ID: 'cli-a-task',
    SLAYZONE_HUB_ADDRESS: `127.0.0.1:${hub.port}`,
    SLAYZONE_CLI_RELAY_ADDRESS: new URL(relay.url).host,
    SLAYZONE_CLI_RELAY_TOKEN: capability.token
  })
  const cli = (...args: string[]) =>
    exec(process.execPath, [cliBin, ...args], {
      env: cliEnv,
      cwd: projectDir,
      timeout: 15_000
    })
  expect(existsSync(join(hub.root, 'home/.slayzone/cli/hub-target.json'))).toBe(false)
  expect((await cli('tasks', 'view', 'cli-a-task')).stdout).toContain('cli-a')
  expect(
    (
      await fetch(`${relay.url}/api/automations`, {
        headers: { authorization: `Bearer ${capability.token}` }
      })
    ).status
  ).toBe(403)
  await expect(cli('tasks', 'view', 'cli-b-task')).rejects.toThrow()
  await cli('init')
  expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('SlayZone Environment')
  expect(existsSync(join(projectDir, '.agents/skills/slay/SKILL.md'))).toBe(true)
  expect(JSON.parse((await cli('hub', 'ls', '--json-v2')).stdout).taskHub).toMatchObject({
    connection: 'relay',
    url: `http://127.0.0.1:${hub.port}`
  })
  await dialer.stop()
  await expect(cli('tasks', 'view', 'cli-a-task')).rejects.toThrow()
  const reconnected = dialer.events.once('connected')
  dialer.start()
  expect((await reconnected).mode).toBe('hello')
  expect((await cli('tasks', 'view', 'cli-a-task')).stdout).toContain('cli-a')

  const revoked = await fetch(`http://127.0.0.1:${hub.port}/api/hub/computers`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${hub.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: dialer.computerId, revoked: true })
  })
  expect(revoked.status).toBe(200)
  await expect(cli('tasks', 'view', 'cli-a-task')).rejects.toThrow()
})
