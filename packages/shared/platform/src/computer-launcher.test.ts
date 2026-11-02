import { execFile, spawn } from 'node:child_process'
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
