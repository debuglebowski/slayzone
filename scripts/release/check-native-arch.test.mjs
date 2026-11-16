/**
 * Tests for the native-arch release gate: macOS x64 (built on arm64) and Windows
 * arm64 (built on x64) shipped node-datachannel with the BUILD host's per-platform
 * binary only, and neither build can be smoke-run on its runner. The gate reads
 * binary headers instead, so it is pinned here with synthesized ones.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  binaryArch,
  checkNativeArch,
  namesTargetPackage,
  pathTag,
  resourcesDir
} from './check-native-arch.mjs'

// This suite runs on Electron's node, whose fs treats `*.asar` paths as archives
// (the fixture's `app.asar.unpacked` is fine, but keep fs plain like the gate's node).
const savedNoAsar = process.noAsar
beforeAll(() => {
  process.noAsar = true
})
afterAll(() => {
  process.noAsar = savedNoAsar
})

const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c }
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }
const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 }

function macho(arch) {
  const b = Buffer.alloc(32)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(MACHO_CPU[arch], 4)
  return b
}
function fat(...arches) {
  const b = Buffer.alloc(8 + arches.length * 20)
  b.writeUInt32BE(0xcafebabe, 0)
  b.writeUInt32BE(arches.length, 4)
  arches.forEach((a, i) => b.writeUInt32BE(MACHO_CPU[a], 8 + i * 20))
  return b
}
function pe(arch) {
  const b = Buffer.alloc(0x90)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.writeUInt32BE(0x50450000, 0x80)
  b.writeUInt16LE(PE_MACHINE[arch], 0x84)
  return b
}
function elf(arch) {
  const b = Buffer.alloc(64)
  b.writeUInt32BE(0x7f454c46, 0)
  b[4] = 2
  b[5] = 1
  b.writeUInt16LE(ELF_MACHINE[arch], 18)
  return b
}

test('binaryArch reads Mach-O (thin and universal), PE and ELF', () => {
  expect(binaryArch(macho('x64'))).toEqual({ format: 'macho', arches: ['x64'] })
  expect(binaryArch(macho('arm64'))).toEqual({ format: 'macho', arches: ['arm64'] })
  expect(binaryArch(fat('x64', 'arm64'))).toEqual({ format: 'macho', arches: ['x64', 'arm64'] })
  expect(binaryArch(pe('arm64'))).toEqual({ format: 'pe', arches: ['arm64'] })
  expect(binaryArch(pe('x64'))).toEqual({ format: 'pe', arches: ['x64'] })
  expect(binaryArch(elf('x64'))).toEqual({ format: 'elf', arches: ['x64'] })
  expect(binaryArch(elf('arm64'))).toEqual({ format: 'elf', arches: ['arm64'] })
})

test('binaryArch ignores everything else (scripts, JSON, a Java class)', () => {
  expect(binaryArch(Buffer.from('#!/bin/sh\necho hi\n'))).toBeNull()
  expect(binaryArch(Buffer.from('{"name":"x"}'))).toBeNull()
  const javaClass = Buffer.alloc(16)
  javaClass.writeUInt32BE(0xcafebabe, 0)
  javaClass.writeUInt32BE(0x00000034, 4) // class version 52
  expect(binaryArch(javaClass)).toBeNull()
  // MZ without a PE header (a stray text file starting "MZ").
  expect(binaryArch(Buffer.from('MZ is not a binary'))).toBeNull()
})

test('pathTag reads the platform-arch a prebuild path is for', () => {
  expect(pathTag('prebuilds/darwin-x64/pty.node')).toEqual({ platform: 'darwin', arch: 'x64' })
  expect(pathTag('prebuilds/linux-arm64.node')).toEqual({ platform: 'linux', arch: 'arm64' })
  expect(pathTag('prebuilds/linuxmusl-x64.node')).toEqual({ platform: 'linux', arch: 'x64' })
  expect(pathTag('bin/darwin-arm64-150/posix.node')).toEqual({ platform: 'darwin', arch: 'arm64' })
  expect(pathTag('third_party/conpty/1.23/win10-arm64/OpenConsole.exe')).toEqual({
    platform: 'win32',
    arch: 'arm64'
  })
  expect(pathTag('build/Release/pty.node')).toBeNull()
})

test('namesTargetPackage picks the napi-rs-style package for the target', () => {
  const t = (platform, arch) => ({ platform, arch })
  expect(namesTargetPackage('@node-datachannel/darwin-x64', t('darwin', 'x64'))).toBe(true)
  expect(namesTargetPackage('@node-datachannel/darwin-arm64', t('darwin', 'x64'))).toBe(false)
  expect(namesTargetPackage('@node-datachannel/win32-arm64-msvc', t('win32', 'arm64'))).toBe(true)
  expect(namesTargetPackage('@node-datachannel/linux-x64-gnu', t('linux', 'x64'))).toBe(true)
  expect(namesTargetPackage('@node-datachannel/linux-x64-musl', t('linux', 'x64'))).toBe(false)
  expect(namesTargetPackage('@node-datachannel/android-arm64', t('linux', 'arm64'))).toBe(false)
  expect(namesTargetPackage('detect-libc', t('darwin', 'x64'))).toBe(false)
})

/** An unpacked app: `files` = { 'node_modules/…': Buffer | string }. Returns its dir. */
function app(files, { mac = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-arch-'))
  const resources = mac
    ? path.join(root, 'SlayZone.app', 'Contents', 'Resources')
    : path.join(root, 'resources')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(resources, 'app.asar.unpacked', rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, typeof content === 'string' ? content : content)
  }
  return {
    root,
    nodeModules: path.join(resources, 'app.asar.unpacked', 'node_modules'),
    done: () => rmSync(root, { recursive: true, force: true })
  }
}

const ndc = (installed) => ({
  'node_modules/node-datachannel/package.json': JSON.stringify({
    name: 'node-datachannel',
    optionalDependencies: {
      '@node-datachannel/darwin-arm64': '0.33.4',
      '@node-datachannel/darwin-x64': '0.33.4',
      '@node-datachannel/win32-arm64-msvc': '0.33.4',
      '@node-datachannel/win32-x64-msvc': '0.33.4',
      '@node-datachannel/linux-x64-gnu': '0.33.4',
      '@node-datachannel/linux-x64-musl': '0.33.4'
    }
  }),
  'node_modules/node-datachannel/dist/cjs/lib/index.cjs': '',
  ...Object.fromEntries(
    Object.entries(installed).flatMap(([name, [os, cpu, bin]]) => [
      [
        `node_modules/@node-datachannel/${name}/package.json`,
        JSON.stringify({ name: `@node-datachannel/${name}`, os: [os], cpu: [cpu] })
      ],
      [`node_modules/@node-datachannel/${name}/node_datachannel.node`, bin]
    ])
  )
})

test('the bug: an x64 Mac build carrying only the arm64 node-datachannel binary fails', () => {
  const a = app({
    ...ndc({ 'darwin-arm64': ['darwin', 'arm64', macho('arm64')] }),
    'node_modules/node-pty/package.json': '{"name":"node-pty"}',
    'node_modules/node-pty/build/Release/pty.node': macho('x64')
  })
  try {
    const r = checkNativeArch(a.nodeModules, { platform: 'darwin', arch: 'x64' })
    expect(r.violations).toEqual([
      expect.objectContaining({
        file: 'node-datachannel → @node-datachannel/darwin-x64',
        problem: expect.stringMatching(/not shipped/)
      })
    ])
    // The host's package is for another cpu: skipped, not a violation.
    expect(r.skipped.map((s) => s.file)).toContain(
      '@node-datachannel/darwin-arm64/node_datachannel.node'
    )
  } finally {
    a.done()
  }
})

test('the fix: the target package shipped passes, beside the host one', () => {
  const a = app({
    ...ndc({
      'darwin-arm64': ['darwin', 'arm64', macho('arm64')],
      'darwin-x64': ['darwin', 'x64', macho('x64')]
    }),
    'node_modules/node-pty/package.json': '{"name":"node-pty"}',
    'node_modules/node-pty/build/Release/pty.node': fat('x64', 'arm64'),
    'node_modules/node-pty/prebuilds/win32-x64/pty.node': pe('x64')
  })
  try {
    const r = checkNativeArch(a.nodeModules, { platform: 'darwin', arch: 'x64' })
    expect(r.violations).toEqual([])
    expect(r.checked.map((c) => c.file).sort()).toEqual([
      '@node-datachannel/darwin-x64/node_datachannel.node',
      'node-pty/build/Release/pty.node'
    ])
  } finally {
    a.done()
  }
})

test('a target package whose binary is the wrong arch fails (mislabelled or swapped)', () => {
  const a = app(ndc({ 'win32-arm64-msvc': ['win32', 'arm64', pe('x64')] }))
  try {
    const r = checkNativeArch(a.nodeModules, { platform: 'win32', arch: 'arm64' })
    expect(r.violations.map((v) => v.problem)).toEqual([
      expect.stringMatching(/is pe x64, target is pe arm64/),
      expect.stringMatching(/without a pe arm64 binary/)
    ])
  } finally {
    a.done()
  }
})

test('an untagged native rebuilt for the host instead of the target fails', () => {
  const a = app({
    ...ndc({ 'win32-arm64-msvc': ['win32', 'arm64', pe('arm64')] }),
    'node_modules/bufferutil/package.json': '{"name":"bufferutil"}',
    'node_modules/bufferutil/build/Release/bufferutil.node': pe('x64'),
    'node_modules/bufferutil/prebuilds/win32-x64/bufferutil.node': pe('x64')
  })
  try {
    const r = checkNativeArch(a.nodeModules, { platform: 'win32', arch: 'arm64' })
    expect(r.violations).toEqual([
      expect.objectContaining({ file: 'bufferutil/build/Release/bufferutil.node' })
    ])
  } finally {
    a.done()
  }
})

test('Linux: the glibc package is required, the musl one is not', () => {
  const a = app(ndc({ 'linux-x64-gnu': ['linux', 'x64', elf('x64')] }))
  try {
    expect(checkNativeArch(a.nodeModules, { platform: 'linux', arch: 'x64' }).violations).toEqual(
      []
    )
  } finally {
    a.done()
  }
})

test('resourcesDir finds a .app inside a dist dir, and win/linux resources', () => {
  const mac = app({ 'node_modules/x/package.json': '{}' }, { mac: true })
  const win = app({ 'node_modules/x/package.json': '{}' })
  try {
    expect(resourcesDir(mac.root)).toBe(
      path.join(mac.root, 'SlayZone.app', 'Contents', 'Resources')
    )
    expect(resourcesDir(win.root)).toBe(path.join(win.root, 'resources'))
  } finally {
    mac.done()
    win.done()
  }
})
