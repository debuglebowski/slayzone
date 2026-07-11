import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_VARS, loadRunnerConfig } from './config'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadRunnerConfig', () => {
  it('builds a config from env with sensible defaults', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example:8443/fleet',
      [ENV_VARS.joinToken]: 'jt-1'
    })
    expect(config).toEqual({
      hubUrl: 'wss://hub.example:8443/fleet',
      joinToken: 'jt-1',
      name: hostname(),
      allowedRoots: [],
      capabilities: ['pty']
    })
  })

  it('parses list-shaped env vars', () => {
    const config = loadRunnerConfig({
      [ENV_VARS.hubUrl]: 'wss://hub.example/fleet',
      [ENV_VARS.allowedRoots]: ['/srv/a', '/srv/b'].join(delimiter),
      [ENV_VARS.capabilities]: 'pty, git',
      [ENV_VARS.name]: 'runner-9',
      [ENV_VARS.heartbeatIntervalMs]: '5000'
    })
    expect(config.allowedRoots).toEqual(['/srv/a', '/srv/b'])
    expect(config.capabilities).toEqual(['pty', 'git'])
    expect(config.name).toBe('runner-9')
    expect(config.heartbeatIntervalMs).toBe(5000)
  })

  it('merges config file under env (env wins)', () => {
    const filePath = join(dir, 'runner.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        hubUrl: 'wss://from-file.example/fleet',
        name: 'from-file',
        capabilities: ['pty', 'fs'],
        pinnedCertSha256: 'a'.repeat(64)
      })
    )
    const config = loadRunnerConfig({
      [ENV_VARS.configFile]: filePath,
      [ENV_VARS.name]: 'from-env'
    })
    expect(config.hubUrl).toBe('wss://from-file.example/fleet')
    expect(config.name).toBe('from-env')
    expect(config.capabilities).toEqual(['pty', 'fs'])
    expect(config.pinnedCertSha256).toBe('a'.repeat(64))
  })

  it('fails with a readable error when hubUrl is missing', () => {
    expect(() => loadRunnerConfig({})).toThrow(/SLAYZONE_HUB_URL/)
  })

  it('rejects malformed config files and non-integer heartbeat', () => {
    const filePath = join(dir, 'bad.json')
    writeFileSync(filePath, '{not json')
    expect(() => loadRunnerConfig({ [ENV_VARS.configFile]: filePath })).toThrow(/not valid JSON/)
    expect(() =>
      loadRunnerConfig({ [ENV_VARS.hubUrl]: 'wss://x/fleet', [ENV_VARS.heartbeatIntervalMs]: 'soon' })
    ).toThrow(/integer/)
  })
})
