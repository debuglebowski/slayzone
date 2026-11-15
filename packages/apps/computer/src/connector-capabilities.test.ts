/** Retaining a compatible v3 host must not give it the connector's new operations. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { startConnector } from './connector'
import type { ConnectorGrant } from './session-host'

const host = vi.hoisted(() => ({ boundedReads: undefined as boolean | undefined }))

vi.mock('./main', () => ({ COMPUTER_VERSION: '0.40.0' }))
vi.mock('./agent-hooks', () => ({ stageComputerHooks: async () => '/unused/hooks' }))
vi.mock('./session-host', () => ({
  connectorHost: async () => ({
    socket: { once: () => undefined },
    close: () => undefined,
    rpc: {
      request: async (method: string, params?: { method?: string; params?: { op?: string } }) => {
        if (method === 'identity')
          return {
            contract: 3,
            epoch: 'retained-v3',
            name: 'retained-host',
            platform: 'darwin-arm64',
            version: '0.39.0',
            capabilities: ['proc'],
            ...(host.boundedReads === undefined ? {} : { boundedReads: host.boundedReads })
          }
        if (method === 'dispatch' && params?.method === 'git.op') {
          if (params.params?.op === 'getIgnoredFileTree') return []
          throw new Error(`unknown git op '${params.params?.op}'`)
        }
        return { ok: true }
      }
    }
  })
}))

it.each([undefined, false, true])(
  'new connectors forward retained v3 host boundedReads=%s on enroll and hello',
  async (boundedReads) => {
    host.boundedReads = boundedReads
    const root = mkdtempSync(join(tmpdir(), 'connector-capabilities-'))
    const previousRoot = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = root
    const hub = await startLoopbackHub({ floodLimits: false })
    const config = {
      hubUrl: hub.url,
      name: 'retained-host',
      allowedRoots: [root],
      capabilities: ['proc'],
      joinToken: 'jt-valid'
    }
    let connector: Awaited<ReturnType<typeof startConnector>> | undefined
    const advertised: Array<{ mode: string; boundedReads: boolean | undefined }> = []
    try {
      for (const generation of [1, 2]) {
        const grant = {
          health: { contract: 3, epoch: 'retained-v3' },
          generation
        } as ConnectorGrant
        connector = await startConnector(root, config, grant)
        const connected = await connector.dialer.events.once('connected')
        const [computer] = hub.gateway.listComputers()
        advertised.push({ mode: connected.mode, boundedReads: computer.boundedReads })
        // Historical operations remain usable through the same connector.
        await expect(
          hub.gateway.request(computer.computerId, 'git.op', {
            op: 'getIgnoredFileTree',
            input: { repoPath: root },
            mutates: false
          })
        ).resolves.toEqual([])
        await connector.stop()
        connector = undefined
      }
      expect(advertised).toEqual([
        { mode: 'enroll', boundedReads: boundedReads === true },
        { mode: 'hello', boundedReads: boundedReads === true }
      ])
    } finally {
      await connector?.stop()
      await hub.close()
      if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  }
)
