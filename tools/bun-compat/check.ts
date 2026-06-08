/**
 * Native-module compatibility probe for the Bun sidecar. Runs every
 * native/require-heavy dependency the sidecar depends on through a tiny
 * exercise. Any module that throws at import or at first use is recorded
 * as blocked, which means the Bun sidecar needs a Node fallback
 * (`SLAYZONE_RUNTIME=node`) until the upstream issue is resolved.
 *
 * Run:
 *   bun run tools/bun-compat/check.ts     # primary target
 *   node --experimental-vm-modules ... ts — not exercised; use tsx for node check
 *
 * Emits a summary table to stdout and writes a machine-readable JSON
 * report to tools/bun-compat/report.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const REPORT_PATH = join(REPO_ROOT, 'tools', 'bun-compat', 'report.json')

interface ProbeResult {
  module: string
  status: 'ok' | 'blocked' | 'skipped'
  step: string
  error?: string
  durationMs: number
  notes?: string
}

async function probe(module: string, fn: () => Promise<void> | void, notes?: string): Promise<ProbeResult> {
  const started = Date.now()
  const stepTracker: { step: string } = { step: 'import' }
  try {
    const wrapped = async (): Promise<void> => {
      stepTracker.step = 'exercise'
      await fn()
    }
    await wrapped()
    return { module, status: 'ok', step: stepTracker.step, durationMs: Date.now() - started, notes }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Package not installed in this workspace — not a Bun blocker, just
    // informational. The plan lists msgpackr as a forward-looking dep.
    if (/Cannot find (module|package) ['"]/.test(message)) {
      return {
        module,
        status: 'skipped',
        step: stepTracker.step,
        durationMs: Date.now() - started,
        notes: 'package not installed in workspace',
      }
    }
    return {
      module,
      status: 'blocked',
      step: stepTracker.step,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      durationMs: Date.now() - started,
      notes,
    }
  }
}

async function main(): Promise<void> {
  const runtime: 'bun' | 'node' =
    // @ts-expect-error — `Bun` is a global in Bun, undefined in Node.
    typeof Bun !== 'undefined' ? 'bun' : 'node'
  const results: ProbeResult[] = []

  // better-sqlite3 — native n-api bindings; historically the most brittle on Bun.
  results.push(
    await probe('better-sqlite3', async () => {
      const mod = await import('better-sqlite3')
      const Database = mod.default
      const dbPath = join(tmpdir(), `slayzone-bun-compat-${process.pid}.sqlite`)
      const db = new Database(dbPath)
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
      db.prepare('INSERT INTO t (name) VALUES (?)').run('smoke')
      const row = db.prepare('SELECT * FROM t WHERE id = 1').get() as { id: number; name: string }
      if (row?.name !== 'smoke') throw new Error(`unexpected row: ${JSON.stringify(row)}`)
      db.close()
    }, 'prepared statements + runtime-loaded native binding'),
  )

  // node-pty — spawns PTYs; depends on conpty (win) or util-linux.
  results.push(
    await probe('node-pty', async () => {
      const pty = await import('node-pty')
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const child = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env, LANG: 'en_US.UTF-8' } })
      const sawOutput = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500)
        child.onData((_) => {
          clearTimeout(timer)
          resolve(true)
        })
        child.write('echo bunpty\r')
      })
      child.kill()
      if (!sawOutput) throw new Error('no PTY data within 1.5s')
    }, 'spawn + write + read'),
  )

  // convex — cloud client, uses WebSocket + fetch, not native; still worth probing.
  results.push(
    await probe('convex', async () => {
      const mod = await import('convex/browser')
      if (typeof mod.ConvexClient !== 'function') {
        throw new Error('ConvexClient missing from convex/browser')
      }
      // Don't actually connect — just verify constructor + shape
      const client = new mod.ConvexClient('https://example.convex.cloud', { skipConvexDeploymentUrlCheck: true })
      if (typeof client.close !== 'function') throw new Error('close() missing on ConvexClient')
      client.close()
    }, 'module + basic client shape'),
  )

  // express — pure JS, but has a large dep tree that tickles Bun's CJS interop.
  results.push(
    await probe('express', async () => {
      const express = (await import('express')).default
      const app = express()
      app.get('/ping', (_req, res) => res.send('pong'))
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', async () => {
          try {
            const addr = server.address()
            if (!addr || typeof addr === 'string') throw new Error('no address')
            const res = await fetch(`http://127.0.0.1:${addr.port}/ping`)
            const body = await res.text()
            if (body !== 'pong') throw new Error(`unexpected body: ${body}`)
            server.close(() => resolve())
          } catch (e) {
            server.close()
            reject(e)
          }
        })
        server.on('error', reject)
      })
    }, 'listen + fetch round-trip'),
  )

  // ws — WebSocket implementation, sometimes used alongside Bun's native WebSocket.
  results.push(
    await probe('ws', async () => {
      const { WebSocketServer, WebSocket } = await import('ws')
      await new Promise<void>((resolve, reject) => {
        const wss = new WebSocketServer({ port: 0 })
        wss.on('listening', () => {
          const addr = wss.address()
          if (!addr || typeof addr === 'string') { wss.close(); return reject(new Error('no address')) }
          const client = new WebSocket(`ws://127.0.0.1:${addr.port}`)
          client.on('open', () => client.send('hi'))
          wss.on('connection', (sock) => {
            sock.on('message', (data) => {
              if (String(data) !== 'hi') { wss.close(); client.close(); return reject(new Error(`bad msg: ${data}`)) }
              sock.send('ack')
            })
          })
          client.on('message', (data) => {
            if (String(data) !== 'ack') { wss.close(); client.close(); return reject(new Error(`bad ack: ${data}`)) }
            client.close()
            wss.close(() => resolve())
          })
          client.on('error', reject)
          wss.on('error', reject)
        })
      })
    }, 'server + client round-trip'),
  )

  // msgpackr — fast MessagePack encoder/decoder with optional native accelerator.
  results.push(
    await probe('msgpackr', async () => {
      const { pack, unpack } = await import('msgpackr')
      const input = { a: 1, b: 'two', c: [true, null, 3.14] }
      const bytes = pack(input)
      const out = unpack(bytes)
      if (JSON.stringify(out) !== JSON.stringify(input)) {
        throw new Error(`roundtrip mismatch: ${JSON.stringify(out)}`)
      }
    }, 'pack/unpack round-trip'),
  )

  // Report
  const summary = {
    runtime,
    version: runtime === 'bun'
      // @ts-expect-error — Bun global
      ? Bun.version as string
      : process.version,
    platform: `${process.platform}-${process.arch}`,
    generatedAt: new Date().toISOString(),
    results,
  }

  mkdirSync(join(REPO_ROOT, 'tools', 'bun-compat'), { recursive: true })
  writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2), 'utf8')

  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))
  process.stdout.write(`\nbun-compat: runtime=${runtime} ${summary.version} on ${summary.platform}\n`)
  process.stdout.write(`${pad('module', 20)}${pad('status', 10)}${pad('step', 12)}duration  error\n`)
  process.stdout.write(`${'-'.repeat(70)}\n`)
  for (const r of results) {
    process.stdout.write(
      `${pad(r.module, 20)}${pad(r.status, 10)}${pad(r.step, 12)}${pad(`${r.durationMs}ms`, 10)}${r.error ?? ''}\n`,
    )
  }
  process.stdout.write(`\nwrote ${REPORT_PATH}\n`)

  const blocked = results.filter((r) => r.status === 'blocked')
  const skipped = results.filter((r) => r.status === 'skipped')
  if (skipped.length > 0) {
    process.stdout.write(`\n${skipped.length} module(s) skipped (not installed): ${skipped.map((r) => r.module).join(', ')}\n`)
  }
  if (blocked.length > 0) {
    process.stderr.write(`\n${blocked.length} module(s) blocked on ${runtime}\n`)
    process.stderr.write(`→ sidecar must use SLAYZONE_RUNTIME=node until resolved\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`bun-compat failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(2)
})
