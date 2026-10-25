#!/usr/bin/env node
/**
 * Smoke-test an UNPACKED electron-builder output (`dist/mac-*\/SlayZone.app`,
 * `dist/linux-unpacked`, `dist/win-unpacked`) the way the desktop app runs it.
 *
 *   node scripts/release/smoke-packaged-app.mjs <unpacked-app-dir-or-.app>
 *
 * Why this exists. Every other suite runs the hub and the computer from the repo's
 * `node_modules`, so none of them can see a packaging mistake: a native module that is
 * unpacked while its JS dependency stays inside `app.asar`, a bundle that no build step
 * ever copied into `Resources/`. Both shipped (hub: `bindings` lived only inside the
 * asar, so `new Database()` died at the first open; computer: `Resources/computer/bin.cjs`
 * was never built), and both only show on a machine with a real packaged app — the app
 * then reports "could not start its local server". This script is the one place that
 * proves, on the build output, that:
 *
 *   1. every bundle the app spawns is on disk where `index.ts` looks for it;
 *   2. the natives resolve from the bundle's own directory with the NODE_PATH the app
 *      hands the child (`better-sqlite3` must OPEN a database, not just `require`);
 *   3. the packaged hub boots against an empty root, creates `slayzone.data.sqlite`
 *      and answers `/health`;
 *   4. the packaged computer bundle loads its natives (a missing one exits at load);
 *   5. app.asar carries only what the app loads: its node_modules stays under a size
 *      budget, and the mermaid bundle the artifact exporter reads by path is inside it.
 *
 * The packaged Electron binary is the interpreter (ELECTRON_RUN_AS_NODE=1), exactly as
 * in production: same ABI, same asar-aware `fs`.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const input = process.argv[2]
if (!input) {
  console.error('usage: smoke-packaged-app.mjs <unpacked app dir | SlayZone.app>')
  process.exit(2)
}

/** Resolve {resources, exe} for the three layouts electron-builder leaves behind. */
function locate(dir) {
  const abs = path.resolve(dir)
  // A parent such as `dist/mac-arm64` holding the .app.
  const app =
    existsSync(abs) && !abs.endsWith('.app')
      ? readdirSync(abs).find((f) => f.endsWith('.app'))
      : undefined
  const root = app ? path.join(abs, app) : abs
  if (existsSync(path.join(root, 'Contents', 'Resources'))) {
    const macos = path.join(root, 'Contents', 'MacOS')
    const exe = readdirSync(macos)[0]
    return { resources: path.join(root, 'Contents', 'Resources'), exe: path.join(macos, exe) }
  }
  const exeName = process.platform === 'win32' ? 'slayzone.exe' : 'slayzone'
  return { resources: path.join(root, 'resources'), exe: path.join(root, exeName) }
}

const { resources, exe } = locate(input)
const failures = []
const fail = (msg) => {
  failures.push(msg)
  console.log(`  ✗ ${msg}`)
}
const pass = (msg) => console.log(`  ✓ ${msg}`)

// What `index.ts` hands both children (see `packagedNativeModulePath` there).
const NODE_PATH = path.join(resources, 'app.asar.unpacked', 'node_modules')
const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH }
for (const k of Object.keys(baseEnv)) if (k.startsWith('SLAYZONE_')) delete baseEnv[k]

console.log(`resources: ${resources}\nexecutable: ${exe}`)

// 1. The bundles the app spawns, where it looks for them.
console.log('\n1. bundles on disk')
for (const rel of ['hub/bin.cjs', 'computer/bin.cjs', 'dist/web/index.html', 'bin/slay.js']) {
  existsSync(path.join(resources, rel)) ? pass(rel) : fail(`${rel} is missing from Resources`)
}
if (!existsSync(exe)) {
  fail(`executable not found: ${exe}`)
  finish()
}
const have = (rel) => existsSync(path.join(resources, rel))

/** Run a snippet under the packaged Electron-as-node; returns {status, out}. */
function run(code) {
  const r = spawnSync(exe, ['-e', code], { env: baseEnv, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

// 2 + 4. Natives resolve from the bundle's own dir, and better-sqlite3 really opens.
console.log('\n2. natives resolve from each bundle')
if (have('hub/bin.cjs')) {
  const hub = path.join(resources, 'hub', 'bin.cjs')
  const r = run(
    `const D=require('module').createRequire(${JSON.stringify(hub)})('better-sqlite3');` +
      `const d=new D(':memory:');d.prepare('select 1 as x').get();d.close();console.log('opened')`
  )
  r.status === 0 && r.out.includes('opened')
    ? pass('hub: better-sqlite3 loads and opens a database')
    : fail(`hub: better-sqlite3 cannot open a database — ${r.out.split('\n')[0]}`)
}
if (have('computer/bin.cjs')) {
  const computer = path.join(resources, 'computer', 'bin.cjs')
  const r = run(
    `require('module').createRequire(${JSON.stringify(computer)})('node-pty');console.log('loaded')`
  )
  r.status === 0 && r.out.includes('loaded')
    ? pass('computer: node-pty loads')
    : fail(`computer: node-pty cannot load — ${r.out.split('\n')[0]}`)
}

// 3. The packaged hub boots against an empty root and answers /health.
console.log('\n3. packaged hub boots')
const root = mkdtempSync(path.join(tmpdir(), 'slz-packaged-smoke-'))
if (have('hub/bin.cjs')) {
  const child = spawn(exe, [path.join(resources, 'hub', 'bin.cjs')], {
    env: {
      ...baseEnv,
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_REQUIRE_LOGIN: '0'
    },
    // stdin stays OPEN, as the supervisor leaves it: a supervised child treats a closed
    // stdin as "my parent died" and exits.
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  let exited = null
  child.on('exit', (code) => (exited = code ?? 'signal'))

  let port = null
  for (let i = 0; i < 300 && port === null && exited === null; i++) {
    const m = /listening on http:\/\/[^:\s]+:(\d+)/.exec(log)
    if (m) port = Number(m[1])
    else await sleep(100)
  }
  if (port === null) {
    fail(
      `hub never reported listening (exit=${exited}) — ${log.trim().split('\n').slice(-3).join(' | ')}`
    )
  } else {
    pass(`hub listening on :${port}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      res.ok ? pass(`/health → ${res.status}`) : fail(`/health → ${res.status}`)
    } catch (err) {
      fail(`/health unreachable — ${err.message}`)
    }
    existsSync(path.join(root, 'slayzone.data.sqlite'))
      ? pass('slayzone.data.sqlite created in the hub root')
      : fail(`no slayzone.data.sqlite in ${root}: ${readdirSync(root).join(', ')}`)
  }
  child.kill('SIGTERM')
  await sleep(500)
  if (exited === null) child.kill('SIGKILL')
}

// 4. The packaged computer bundle loads (its top-level `require('node-pty')` exits on a miss).
console.log('\n4. packaged computer loads')
if (have('computer/bin.cjs')) {
  const child = spawn(exe, [path.join(resources, 'computer', 'bin.cjs')], {
    env: {
      ...baseEnv,
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:1'
    },
    // stdin stays OPEN, as the supervisor leaves it: a supervised child treats a closed
    // stdin as "my parent died" and exits.
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  await sleep(4000)
  child.kill('SIGKILL')
  const missing = /Cannot find module|MODULE_NOT_FOUND/.test(log)
  if (missing) {
    const line = log
      .trim()
      .split('\n')
      .find((l) => /Cannot find module/.test(l))
    fail(`computer bundle failed to load — ${line}`)
  } else {
    pass('computer bundle loaded without a module-resolution error')
  }
}

// 5. What app.asar packs. electron-builder ships the whole production tree of the app's
// `dependencies`; the app bundles everything else into out/, so that list must stay the
// runtime externals of main/preload plus the natives. A renderer library or @slayzone/*
// package back in `dependencies` drags its whole tree in (v0.35.0 carried ~570 MB of
// node_modules nothing loaded). Measured from the asar header: packed bytes only —
// asarUnpack'd natives live beside it in app.asar.unpacked.
console.log('\n5. app.asar contents')
// ~17.5 MB measured on macOS arm64 (2026-10-25). Raise it only for a new runtime dependency.
const ASAR_NODE_MODULES_BUDGET_MB = 22
const asarPath = path.join(resources, 'app.asar')
if (!existsSync(asarPath)) {
  fail('app.asar is missing from Resources')
} else {
  const header = readAsarHeader(asarPath)
  const nodeModules = header.files.node_modules
  const perPackage = new Map()
  for (const [rel, size] of packedFiles(nodeModules, [])) {
    const name = rel[0].startsWith('@') ? `${rel[0]}/${rel[1]}` : rel[0]
    perPackage.set(name, (perPackage.get(name) ?? 0) + size)
  }
  const totalMb = [...perPackage.values()].reduce((a, b) => a + b, 0) / 1048576
  const summary = `${totalMb.toFixed(1)} MB in ${perPackage.size} packages`
  if (totalMb <= ASAR_NODE_MODULES_BUDGET_MB) {
    pass(`node_modules ${summary} (budget ${ASAR_NODE_MODULES_BUDGET_MB} MB)`)
  } else {
    const top = [...perPackage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, bytes]) => `${name} ${(bytes / 1048576).toFixed(1)} MB`)
      .join(', ')
    fail(
      `node_modules ${summary} exceeds the ${ASAR_NODE_MODULES_BUDGET_MB} MB budget — ` +
        `a bundled-only package is in the app's \`dependencies\`? largest: ${top}`
    )
  }
  // The artifact exporter reads mermaid's standalone bundle by path (an electron-vite
  // `?asset` import into out/main/chunks) and silently degrades to plain code without it.
  const chunks = header.files.out?.files?.main?.files?.chunks?.files ?? {}
  Object.keys(chunks).some((f) => /^mermaid\.min-[\w-]+\.js$/.test(f))
    ? pass('mermaid bundle for artifact export is in out/main/chunks')
    : fail('out/main/chunks has no mermaid.min-*.js — mermaid artifact exports would degrade')
}

rmSync(root, { recursive: true, force: true })
finish()

/** The asar header JSON: a Chromium pickle holding a pickle holding the JSON string. */
function readAsarHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(16)
    readSync(fd, prefix, 0, 16, 0)
    const json = Buffer.alloc(prefix.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    return JSON.parse(json.toString('utf8'))
  } catch (err) {
    throw new Error(`cannot read the asar header of ${file}: ${err.message}`)
  } finally {
    closeSync(fd)
  }
}

/** [relativePathParts, size] for every file packed inside the asar (not unpacked, not links). */
function* packedFiles(node, parts) {
  if (!node) return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files))
      yield* packedFiles(child, [...parts, name])
  } else if (!node.unpacked && !node.link) {
    yield [parts, Number(node.size ?? 0)]
  }
}

function finish() {
  console.log(failures.length ? `\nSMOKE FAILED (${failures.length})` : '\nSMOKE OK')
  process.exit(failures.length ? 1 : 0)
}
