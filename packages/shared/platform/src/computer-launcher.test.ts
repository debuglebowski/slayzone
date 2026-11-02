import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ensureComputerLauncher } from './computer-launcher'

it('stable launcher rolls back supervisor that fails before readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(bad, 'process.exit(1)')
  const launcher = ensureComputerLauncher(root, { version: '1', entry: good })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { version: '2', entry: bad },
      previous: { version: '1', entry: good }
    })
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 10_000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.entry).toBe(good)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rolls back a supervisor that crashes immediately after announcing readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-probation-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(bad, "process.send({type:'supervisor-ready'},()=>process.exit(1))")
  const launcher = ensureComputerLauncher(root, { version: '1', entry: good })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { version: '2', entry: bad },
      previous: { version: '1', entry: good }
    })
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 6000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
    expect(
      JSON.parse(readFileSync(join(root, 'computer-runtime', 'supervisor-quarantine.json'), 'utf8'))
        .version
    ).toBe('2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)

it('startup watchdog treats a slow supervisor as a crash, preserving host work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-watchdog-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  const teardown = join(root, 'host-was-stopped')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(
    bad,
    `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(teardown)},'killed');process.exit(0)});setInterval(()=>{},1000)`
  )
  const launcher = ensureComputerLauncher(root, { entry: good, version: '1' })
  const pointer = join(root, 'computer-runtime', 'supervisor.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { entry: bad, version: '2' },
      previous: { entry: good, version: '1' }
    })
  )
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8')
      .replace('}, 90000);', '}, 300);')
      .replace('setTimeout(launch, 2000)', 'setTimeout(launch, 10)')
  )
  try {
    const stderr = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 3000 },
        (err, _stdout, stderr) => (err ? reject(err) : resolve(stderr))
      )
    )
    expect(stderr).toContain('supervisor 2 startup timed out; restarting')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
    const { existsSync } = await import('node:fs')
    expect(existsSync(teardown)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('host startup watchdog permits cleanup and retries a clean timeout exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-host-watchdog-'))
  const good = join(root, 'good.cjs'),
    bad = join(root, 'bad.cjs')
  const cleaned = join(root, 'host-cleaned')
  writeFileSync(good, "process.send({type:'supervisor-ready'},()=>process.disconnect())")
  writeFileSync(
    bad,
    `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(cleaned)},'yes');process.exit(0)});setInterval(()=>{},1000)`
  )
  const launcher = ensureComputerLauncher(root, { entry: good, version: '1' })
  const pointer = join(root, 'computer-runtime', 'host-release.json')
  writeFileSync(
    pointer,
    JSON.stringify({
      current: { entry: bad, version: '2' },
      previous: { entry: good, version: '1' }
    })
  )
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8')
      .replace('}, 90000);', '}, 300);')
      .replace('setTimeout(launch, 2000)', 'setTimeout(launch, 10)')
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        process.execPath,
        [launcher, '--session-host'],
        { env: { ...process.env, SLAYZONE_ROOT: root }, timeout: 3000 },
        (err) => (err ? reject(err) : resolve())
      )
    )
    expect(readFileSync(cleaned, 'utf8')).toBe('yes')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).current.version).toBe('1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('explicit stop during crash backoff does not start another child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-backoff-stop-'))
  const bad = join(root, 'bad.cjs'),
    boots = join(root, 'boots')
  writeFileSync(
    bad,
    `require('node:fs').appendFileSync(${JSON.stringify(boots)},'boot\\n');process.exit(1)`
  )
  const launcher = ensureComputerLauncher(root, { entry: bad, version: '1' })
  writeFileSync(
    launcher,
    readFileSync(launcher, 'utf8').replace(
      "child.on('exit', (code) => {",
      "child.on('exit', (code) => {process.stdout.write('child-exited\\n');"
    )
  )
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, SLAYZONE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    await once(child.stdout, 'data')
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    expect(readFileSync(boots, 'utf8').trim().split('\n')).toEqual(['boot'])
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)
