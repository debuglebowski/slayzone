/**
 * One session host, one launcher, per computer root — guaranteed, not timed.
 *
 * 2026-11-22 on a remote computer: the supervisor judged the host launcher dead by
 * `host.json`'s pid (the host CHILD, dead inside its launcher's restart gap), unlinked
 * control.sock and spawned a second launcher. From then on every child of one of the
 * two died with EADDRINUSE and was restarted (and its release rolled back) forever,
 * after first rewriting the live host's hook journals.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { ensureComputerLauncher } from '@slayzone/platform/computer-launcher'
import { PRE_LOCK_COMPUTER_LAUNCHER } from '../../../shared/platform/src/computer-launcher.pre-lock.fixture'
import {
  hostEndpointDir,
  hostLauncherEndpoint,
  prepareEndpointDir
} from '@slayzone/platform/computer-endpoints'
import { HostSupersededError, hostControl, hostEndpoint, startSessionHost } from './session-host'
import { ensureSessionHost } from './upgrade-runtime'
import type { ComputerConfig } from './config'

const posix = process.platform !== 'win32'

// Every endpoint directory of this file lives under a private temp base: the sweep
// under test must never reach this machine's real temp dir.
let base: string
const previousTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
beforeAll(() => {
  // Under /tmp on POSIX: macOS's per-user tmpdir (/var/folders/…/T/) makes the
  // endpoint socket paths overflow the 104-byte sun_path limit.
  base = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'slz-ep-'))
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = base
})
afterAll(() => {
  for (const [k, v] of Object.entries(previousTmp))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  rmSync(base, { recursive: true, force: true })
})

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function config(root: string): ComputerConfig {
  return {
    hubUrl: 'ws://127.0.0.1:1/computers',
    name: 'singleton',
    allowedRoots: [root],
    capabilities: ['proc']
  } as ComputerConfig
}
function killLater(pid: number | undefined): void {
  if (pid)
    cleanup.push(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Gone. */
      }
    })
}
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * A stand-in session host entry, for the launcher to fork: records each boot (pid,
 * parent pid), then — from boot `serveFrom` on — binds the control endpoint and
 * answers every JSON-RPC request like a live host; earlier boots exit 3.
 */
function fakeHostEntry(
  root: string,
  serveFrom = 1
): {
  entry: string
  boots: () => { pid: number; ppid: number }[]
} {
  const entry = join(root, 'fake-host.cjs'),
    file = join(root, 'boots')
  writeFileSync(
    entry,
    `const fs=require('node:fs'),net=require('node:net');
fs.appendFileSync(${JSON.stringify(file)},process.pid+' '+process.ppid+'\\n');
const n=fs.readFileSync(${JSON.stringify(file)},'utf8').trim().split('\\n').length;
if(n<${serveFrom})process.exit(3);
process.on('SIGTERM',()=>process.exit(0));
net.createServer((s)=>{let b='';s.setEncoding('utf8');s.on('error',()=>{});s.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id!==undefined)s.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{pid:process.pid}})+'\\n');}});})
  .listen(${JSON.stringify(hostEndpoint(root))});`
  )
  return {
    entry,
    boots: () => {
      try {
        return readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((l) => {
            const [pid, ppid] = l.split(' ').map(Number)
            return { pid, ppid }
          })
      } catch {
        return []
      }
    }
  }
}
function startLauncher(root: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(root, 'computer-runtime', 'launch.cjs'), '--session-host'],
    { env: { ...process.env, SLAYZONE_ROOT: root }, stdio: 'ignore' }
  )
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await once(child, 'exit')
  })
  return child
}
function computerLog(root: string): string {
  try {
    return readFileSync(join(root, 'logs', 'computer.log'), 'utf8')
  } catch {
    return ''
  }
}

it("ensureSessionHost starts no second launcher while the root's launcher is between children", async () => {
  const root = tempRoot('singleton-gap-')
  // Boot 1 fails, so the launcher sits in a (long) restart backoff; boot 2 serves.
  const host = fakeHostEntry(root, 2)
  const release = { entry: host.entry, version: '1' }
  ensureComputerLauncher(root, release)
  const script = join(root, 'computer-runtime', 'launch.cjs')
  writeFileSync(
    script,
    readFileSync(script, 'utf8').replace('BACKOFF_MIN_MS = 2000', 'BACKOFF_MIN_MS = 60000')
  )
  const launcher = startLauncher(root)
  await until(() => host.boots().length === 1)
  await until(() => computerLog(root).includes('restarting in 60000ms'))
  // What the dead child left: a host.json naming it.
  writeFileSync(
    join(root, 'computer-runtime', 'host.json'),
    JSON.stringify({ pid: host.boots()[0].pid, endpoint: hostEndpoint(root) })
  )
  const peer = await ensureSessionHost(config(root), release, root)
  peer.close()
  for (const b of host.boots()) killLater(b.pid)
  // Its launcher restarted the host at once; nothing else forked one.
  expect(host.boots()).toHaveLength(2)
  expect(host.boots().every((b) => b.ppid === launcher.pid)).toBe(true)
  expect(launcher.exitCode).toBeNull()
}, 30_000)

it('a launcher that started before the supervisor checks is waited on, never duplicated', async () => {
  const root = tempRoot('singleton-slow-')
  // The live launcher's child takes a while to bind; the supervisor must wait.
  const host = fakeHostEntry(root, 1)
  const release = { entry: host.entry, version: '1' }
  ensureComputerLauncher(root, release)
  writeFileSync(host.entry, `setTimeout(()=>{${readFileSync(host.entry, 'utf8')}},1500)`)
  const launcher = startLauncher(root)
  await until(() => existsSync(hostLauncherEndpoint(root)) || !posix)
  await new Promise((r) => setTimeout(r, 100))
  const peer = await ensureSessionHost(config(root), release, root)
  peer.close()
  for (const b of host.boots()) killLater(b.pid)
  expect(host.boots()).toHaveLength(1)
  expect(host.boots()[0].ppid).toBe(launcher.pid)
}, 30_000)

it('a launcher from before the lock (no endpoint) in its restart gap is waited on, not duplicated', async () => {
  const root = tempRoot('singleton-legacy-')
  const host = fakeHostEntry(root, 1)
  const release = { entry: host.entry, version: '1' }
  ensureComputerLauncher(root, release)
  // Its previous child is dead (host.json names it); the old launcher restarts
  // the next one after its fixed 2s delay.
  const dead = spawn(process.execPath, ['-e', ''])
  await once(dead, 'exit')
  writeFileSync(
    join(root, 'computer-runtime', 'host.json'),
    JSON.stringify({ pid: dead.pid, endpoint: hostEndpoint(root) })
  )
  const dir = hostEndpointDir(root)
  if (dir) prepareEndpointDir(dir)
  const legacy = spawn(
    process.execPath,
    [
      '-e',
      `setTimeout(()=>require('node:child_process').fork(${JSON.stringify(host.entry)}),2000)`
    ],
    { stdio: 'ignore' }
  )
  cleanup.push(() => legacy.kill('SIGKILL'))
  const peer = await ensureSessionHost(config(root), release, root)
  peer.close()
  for (const b of host.boots()) killLater(b.pid)
  expect(host.boots()).toHaveLength(1)
  expect(host.boots()[0].ppid).toBe(legacy.pid)
  expect(computerLog(root)).not.toContain('[launcher')
}, 30_000)

it('a host that finds a live host exits superseded before touching shared state', async () => {
  const root = tempRoot('singleton-superseded-')
  const live = await startSessionHost(root, config(root))
  cleanup.push(() => live.stop())
  const runtime = join(root, 'computer-runtime')
  // A hook journal holding a chat event: a starting host would scrub (rewrite) it.
  const journal = join(runtime, 'hooks-0123456789abcdef.json')
  writeFileSync(
    journal,
    JSON.stringify([
      { id: 'e1', params: { name: 'chat-runtime' } },
      { id: 'e2', params: { name: 'native' } }
    ]) + '\n'
  )
  const generations = join(runtime, 'generations.json')
  writeFileSync(generations, 'not json')
  const before = {
    journal: readFileSync(journal, 'utf8'),
    generations: readFileSync(generations, 'utf8'),
    hostJson: readFileSync(join(runtime, 'host.json'), 'utf8')
  }
  const lines: string[] = []
  const second = startSessionHost(root, config(root), (m) => lines.push(m))
  await expect(second).rejects.toBeInstanceOf(HostSupersededError)
  await expect(second).rejects.toThrow(new RegExp(`live session host pid=${process.pid}`))
  expect(readFileSync(journal, 'utf8')).toBe(before.journal)
  expect(readFileSync(generations, 'utf8')).toBe(before.generations)
  expect(readFileSync(join(runtime, 'host.json'), 'utf8')).toBe(before.hostJson)
  expect(lines.filter((l) => /listening|generations/.test(l))).toEqual([])
  // The live host still serves.
  const control = await hostControl(root)
  control.close()
})

// 2026-11-28 on a remote computer upgraded from 0.43.0: two launchers from before the
// lock kept restarting their session host every ~2s for hours, each child dying with
// EADDRINUSE on the live host's control endpoint (79k errors, a 113 MB host.log). An
// upgrade points them at the new release; its host, superseded, must end them —
// without the old launcher quarantining it and rolling the pointer back.
it.skipIf(!posix)(
  'the real session host, superseded under a pre-lock launcher, ends that launcher: no restart loop, no rollback',
  async () => {
    const root = tempRoot('singleton-pre-lock-')
    const live = await startSessionHost(root, config(root))
    cleanup.push(() => live.stop())
    const runtime = join(root, 'computer-runtime')
    writeFileSync(
      join(root, 'computer.config.json'),
      JSON.stringify({
        hubUrl: 'ws://127.0.0.1:1/computers',
        computerName: 'singleton',
        allowedRoots: [root]
      })
    )
    const bin = join(import.meta.dirname, '..', 'dist', 'bin.cjs')
    const previous = join(root, 'previous.cjs')
    writeFileSync(previous, 'setInterval(()=>{},1000)')
    writeFileSync(join(runtime, 'launch.cjs'), PRE_LOCK_COMPUTER_LAUNCHER, { mode: 0o700 })
    const pointer = join(runtime, 'host-release.json')
    const release = {
      current: { entry: bin, version: '2.0.0' },
      previous: { entry: previous, version: '1.0.0' }
    }
    writeFileSync(pointer, JSON.stringify(release))
    // Only the root and the private temp base: never this machine's SlayZone wiring.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('SLAYZONE_'))
    )
    const launcher = spawn(process.execPath, [join(runtime, 'launch.cjs'), '--session-host'], {
      env: { ...env, SLAYZONE_ROOT: root },
      stdio: 'ignore'
    })
    cleanup.push(() => launcher.kill('SIGKILL'))
    // Its fixed restart delay is 2s: a launcher still up after 8s is looping.
    const ended = await Promise.race([
      once(launcher, 'exit').then(([code]) => code as number | null),
      new Promise<'running'>((r) => setTimeout(() => r('running'), 8000))
    ])
    expect(ended).toBe(0)
    expect(computerLog(root).match(/superseded by a live session host; exiting/g)).toHaveLength(1)
    expect(existsSync(join(runtime, 'host-quarantine.json'))).toBe(false)
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual(release)
    // The live host still serves.
    const control = await hostControl(root)
    control.close()
  },
  30_000
)

it.skipIf(!posix)(
  'a host that finds a stale control.sock (its owner died) takes it over',
  async () => {
    const root = tempRoot('singleton-stale-')
    const endpoint = hostEndpoint(root)
    prepareEndpointDir(hostEndpointDir(root)!)
    const killed = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(endpoint)},()=>process.kill(process.pid,'SIGKILL'))`
    ])
    await once(killed, 'exit')
    expect(existsSync(endpoint)).toBe(true)
    const host = await startSessionHost(root, config(root))
    cleanup.push(() => host.stop())
    const control = await hostControl(root)
    control.close()
  }
)

it('connections that arrive before the host is fully started wait; none sees a half-started host', async () => {
  const root = tempRoot('singleton-early-')
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let bound!: () => void
  const isBound = new Promise<void>((r) => (bound = r))
  const starting = startSessionHost(root, config(root), undefined, {
    afterBind: () => {
      bound()
      return gate
    }
  })
  await isBound
  let answered = false
  const early = hostControl(root).then((peer) => {
    answered = true
    return peer
  })
  await new Promise((r) => setTimeout(r, 400))
  expect(answered).toBe(false)
  expect(existsSync(join(root, 'computer-runtime', 'host.json'))).toBe(false)
  open()
  const host = await starting
  cleanup.push(() => host.stop())
  const peer = await early
  expect((await peer.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
  peer.close()
})

it('a host whose startup fails after binding drops early connections and frees its endpoint', async () => {
  const root = tempRoot('singleton-early-fail-')
  let bound!: () => void
  const isBound = new Promise<void>((r) => (bound = r))
  const starting = startSessionHost(root, config(root), undefined, {
    afterBind: async () => {
      bound()
      await new Promise((r) => setTimeout(r, 200))
      throw new Error('boom')
    }
  })
  await isBound
  const early = new Promise<string>((resolve) => {
    const s = createConnection(hostEndpoint(root))
    s.on('error', () => resolve('error'))
    s.on('close', () => resolve('closed'))
  })
  await expect(starting).rejects.toThrow('boom')
  expect(await early).toMatch(/closed|error/)
  const dir = hostEndpointDir(root)
  if (dir) expect(existsSync(dir)).toBe(false)
})

it('naming the endpoint creates nothing; the host removes its directory on stop', async () => {
  const root = tempRoot('singleton-dir-')
  hostEndpoint(root)
  const dir = hostEndpointDir(root)
  if (dir) expect(existsSync(dir)).toBe(false)
  // A probe of a root with no host must not leave a directory behind either.
  await expect(hostControl(root)).rejects.toThrow()
  if (dir) expect(existsSync(dir)).toBe(false)
  const host = await startSessionHost(root, config(root))
  if (dir) expect(existsSync(dir)).toBe(true)
  await host.stop()
  if (dir) expect(existsSync(dir)).toBe(false)
})

it.skipIf(!posix)('a host refuses an endpoint directory another user could reach', async () => {
  const root = tempRoot('singleton-unsafe-')
  const dir = hostEndpointDir(root)!
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o777)
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  await expect(startSessionHost(root, config(root))).rejects.toThrow(/unsafe/)
})

it.skipIf(!posix)(
  'a starting host sweeps old, empty endpoint directories of other roots',
  async () => {
    const root = tempRoot('singleton-sweep-')
    const stale = join(tmpdir(), `slay-computer-${process.getuid!()}-${'0'.repeat(24)}`)
    mkdirSync(stale, { mode: 0o700 })
    const old = Date.now() / 1000 - 3 * 3600
    utimesSync(stale, old, old)
    const host = await startSessionHost(root, config(root))
    cleanup.push(() => host.stop())
    expect(existsSync(stale)).toBe(false)
  }
)
