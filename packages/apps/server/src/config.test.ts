import { test, expect, describe } from 'vitest'
import { parseConfig } from './config'

describe('parseConfig', () => {
  test('defaults', () => {
    const c = parseConfig({ env: {}, argv: [] })
    expect(c.port).toBe(0)
    expect(c.host).toBe('127.0.0.1')
    expect(c.mcpPort).toBeNull()
    expect(c.maxUploadBytes).toBe(100 * 1024 * 1024)
    expect(c.noAgentCheck).toBe(false)
  })

  test('env vars', () => {
    const c = parseConfig({
      env: {
        SLAYZONE_PORT: '5000',
        SLAYZONE_HOST: '0.0.0.0',
        SLAYZONE_MCP_PORT: '5001',
        SLAYZONE_NO_AGENT_CHECK: '1',
      },
      argv: [],
    })
    expect(c.port).toBe(5000)
    expect(c.host).toBe('0.0.0.0')
    expect(c.mcpPort).toBe(5001)
    expect(c.noAgentCheck).toBe(true)
  })

  test('argv overrides env', () => {
    const c = parseConfig({
      env: { SLAYZONE_PORT: '5000' },
      argv: ['--port', '6000'],
    })
    expect(c.port).toBe(6000)
  })

  test('mcpPort same as port → null (unified mode)', () => {
    const c = parseConfig({
      env: { SLAYZONE_PORT: '5000', SLAYZONE_MCP_PORT: '5000' },
      argv: [],
    })
    expect(c.mcpPort).toBeNull()
  })

  test('--no-agent-check flag', () => {
    const c = parseConfig({ env: {}, argv: ['--no-agent-check'] })
    expect(c.noAgentCheck).toBe(true)
  })

  test('invalid port falls back', () => {
    const c = parseConfig({ env: { SLAYZONE_PORT: 'abc' }, argv: [] })
    expect(c.port).toBe(0)
  })
})
