import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import {
  resolveMissingFromRef,
  snapshotPath
} from '../../../shared/test-utils/git-snapshot-resolve'
import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
import { reapOnOwnerDeath } from '@slayzone/test-utils/fixture-reaper'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { hostControl, type HostHealth } from '../../computer/src/session-host'
import { releaseEntry } from '../../computer/src/upgrade-runtime'

const root = resolve(import.meta.dirname, '../../../..')
const computerDir = join(root, 'packages/apps/computer')
const requireComputer = createRequire(join(computerDir, 'package.json'))

type ComputerBuild = (options: {
  write?: boolean
  version?: string
  plugins?: import('esbuild').Plugin[]
}) => Promise<import('esbuild').BuildResult<{ write: false }>>

/**
 * The computer bundle at `version`: from `ref` (a historical release) or, without
 * one, from the working tree (the release being rolled out). Both use the
 * published build (`computer/build.mjs`); only reading a ref and the timing-only
 * source patches are this test's. The version is the real build-time define.
 */
async function computerBin(version: string, ref?: string): Promise<string> {
  const { buildComputer } = (await import(pathToFileURL(join(computerDir, 'build.mjs')).href)) as {
    buildComputer: ComputerBuild
  }
  const read = (path: string): string =>
    ref
      ? execFileSync('git', ['show', `${ref}:${relative(root, path)}`], {
          cwd: root,
          encoding: 'utf8'
        })
      : readFileSync(path, 'utf8')
  const result = await buildComputer({
    write: false,
    version,
    plugins: [
      {
        name: 'computer-release',
        setup(build) {
          if (ref) {
            build.onResolve({ filter: /\?raw$/ }, (args) => ({
              path: requireComputer.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
              namespace: 'snapshot-raw'
            }))
            build.onLoad({ filter: /.*/, namespace: 'snapshot-raw' }, (args) => ({
              contents: read(args.path),
              loader: 'text'
            }))
            // A module the old release imported may be gone from disk since: resolve
            // it from the ref, so the build depends only on that ref.
            build.onResolve({ filter: /^\.\.?\// }, (args) =>
              resolveMissingFromRef(root, ref, args)
            )
          }
          // Source files only: `?raw` text keeps its own (build or ref) loader.
          build.onLoad({ filter: /\.(ts|tsx|js|mjs|json)$/, namespace: 'file' }, (args) => {
            const path = ref ? snapshotPath(args.path, realpathSync) : args.path
            if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
            let source = read(path)
            // Timing only: production state machine, launcher, contracts, dispatch,
            // enrollment and maintenance decisions are the built source.
            if (path.endsWith('/upgrade-runtime.ts'))
              source = source.replace('const INTERVAL_MS = 30_000', 'const INTERVAL_MS = 100')
            if (path.endsWith('/auto-upgrade.ts'))
              source = source.replace('deps.probationMs ?? 60_000', 'deps.probationMs ?? 50')
            return {
              contents: source,
              loader: extname(path) === '.json' ? 'json' : extname(path) === '.tsx' ? 'tsx' : 'ts',
              resolveDir: dirname(path)
            }
          })
        }
      }
    ]
  })
  const bundle = result.outputFiles.find((file) => file.path.endsWith('.cjs'))
  if (!bundle) throw new Error('computer build produced no bin.cjs')
  return bundle.text
}

// Run the actual historical supervisor: current-code mocks cannot protect users upgrading from this release. Real build/process/socket timing is intentional. A rare watchdog timeout during deliberate machine oversubscription is acceptable only as a capacity signal; rerun isolated and inspect captured stage output. Busy-job preservation, host epoch/PID change and one enrollment remain mandatory.
// (Applies to both cases: 6bd86bfd0^ and ed9673300.)
test.each([
  ['6bd86bfd0^', 4],
  ['ed9673300', 5]
] as const)(
  'historical %s supervisor rolls a busy contract1 host through a safe maintenance bridge',
  async (ref, oldProtocol) => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'historical-supervisor-'))
    // The supervisor + session host are detached: if this worker dies before `finally`,
    // they would respawn forever against the closed hub.
    reapOnOwnerDeath(dir)
    symlinkSync(
      dirname(dirname(requireComputer.resolve('node-pty/package.json'))),
      join(dir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const oldEntry = join(dir, 'historical.cjs')
    writeFileSync(oldEntry, await computerBin('1.0.0', ref))
    const candidate = releaseEntry(join(dir, 'computer-runtime'), '2.0.0')
    mkdirSync(dirname(candidate), { recursive: true })
    // The release being rolled out: this tree's computer, as version 2.0.0.
    writeFileSync(candidate, await computerBin('2.0.0'))
    let release = '1.0.0',
      upgraded = false
    const server = http.createServer((_req, res) =>
      res.end(JSON.stringify({ ok: true, version: release }))
    )
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const hub = await startLoopbackHub({ floodLimits: false }, { server })
    // This is the hub before deployment, speaking the actual old wire. Only
    // handshake versions are translated; all auth, requests and session state are real.
    hub.wss.prependListener('connection', (socket) => {
      const emit = socket.emit.bind(socket)
      socket.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'message' && !upgraded) {
          const frame = JSON.parse(String(args[0]))
          if (frame.params?.protocolVersion === oldProtocol) {
            frame.params.protocolVersion = COMPUTER_PROTOCOL_VERSION
            args[0] = Buffer.from(JSON.stringify(frame))
          }
        }
        return emit(event, ...args)
      }) as typeof socket.emit
      const send = socket.send.bind(socket)
      socket.send = ((data: string, ...args: unknown[]) => {
        if (!upgraded) {
          const frame = JSON.parse(data)
          if (frame.result?.protocolVersion === COMPUTER_PROTOCOL_VERSION) {
            frame.result.protocolVersion = oldProtocol
            data = JSON.stringify(frame)
          }
        }
        return (send as (...args: unknown[]) => void)(data, ...args)
      }) as typeof socket.send
    })
    const { port } = server.address() as AddressInfo
    writeFileSync(
      join(dir, 'computer.config.json'),
      JSON.stringify({
        hubUrl: `ws://127.0.0.1:${port}/computers`,
        allowedRoots: [dir],
        autoUpgrade: true
      })
    )
    let output = ''
    const child = spawn(process.execPath, [oldEntry], {
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        XDG_CONFIG_HOME: join(dir, '.config'),
        SLAYZONE_ROOT: dir,
        SLAYZONE_SUPERVISED: '0',
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`,
        SLAYZONE_HUB_JOIN_TOKEN: 'jt-valid',
        SLAYZONE_NONINTERACTIVE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    let currentConnections = 0
    hub.gateway.events.on('computer-connected', ({ computer }) => {
      if (computer.version === '2.0.0') currentConnections++
    })
    const stopForeground = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        await exit
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      await vi.waitFor(() => expect(hub.gateway.listComputers(), output).toHaveLength(1), {
        timeout: 15_000
      })
      const id = hub.gateway.listComputers()[0].computerId
      await hub.gateway.request(id, 'proc.spawn', {
        sessionId: 'preserved-native-job',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        // The computer strips ELECTRON_RUN_AS_NODE from inherited env, so under the
        // Electron-run harness this would start a GUI Electron: alive on macOS, but
        // exiting at once on a headless Linux runner, leaving the host idle. The
        // spawn's own env keeps the busy job a real Node process on every runtime.
        env: { ELECTRON_RUN_AS_NODE: '1' },
        cwd: dir
      })
      const sessions = await hub.gateway.request(id, 'proc.list')
      const beforePeer = await hostControl(dir)
      let before: HostHealth
      try {
        before = await beforePeer.rpc.request<HostHealth>('health')
      } finally {
        beforePeer.close()
      }
      expect(before).toMatchObject({ contract: 1, version: '1.0.0', idle: false })
      release = '2.0.0'
      upgraded = true
      hub.gateway.disconnect(id, 'hub deployed current release')
      await vi.waitFor(
        () => {
          expect(hub.gateway.listComputers()[0], output).toMatchObject({
            computerId: id,
            version: '2.0.0',
            chatRuntimeReady: false
          })
          expect(currentConnections, output).toBeGreaterThanOrEqual(2)
          expect(
            JSON.parse(readFileSync(join(dir, 'computer-runtime/supervisor.json'), 'utf8')).current
              .version
          ).toBe('2.0.0')
        },
        { timeout: 15_000 }
      )
      const retained = await hostControl(dir)
      try {
        expect(await retained.rpc.request('health')).toMatchObject(before)
      } finally {
        retained.close()
      }
      expect(await hub.gateway.request(id, 'proc.list')).toEqual(sessions)
      await expect(hub.gateway.request(id, 'chat.request', { kind: 'inventory' })).rejects.toThrow(
        /update|maintenance/i
      )
      await hub.gateway.request(id, 'proc.kill', { sessionId: 'preserved-native-job' })
      await vi.waitFor(
        async () => {
          const peer = await hostControl(dir)
          try {
            const health = await peer.rpc.request<HostHealth>('health')
            expect(health, output).toMatchObject({
              contract: HOST_CONTRACT_VERSION,
              version: '2.0.0',
              idle: true
            })
            expect(health.epoch).not.toBe(before.epoch)
            expect(health.pid).not.toBe(before.pid)
            expect(hub.gateway.listComputers()[0]).toMatchObject({
              computerId: id,
              chatRuntimeReady: true
            })
          } finally {
            peer.close()
          }
        },
        { timeout: 15_000 }
      )
      expect(hub.auth.enrollCalls).toHaveLength(1)
    } finally {
      await stopForeground()
      const peer = await hostControl(dir).catch(() => undefined)
      if (peer) {
        await peer.rpc.request('stop', { force: true }).catch(() => undefined)
        peer.close()
      }
      await hub.close()
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  60_000
)
