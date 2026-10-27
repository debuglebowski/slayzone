/**
 * Tests for the Linux glibc-floor release gate (#165): v0.36.0 shipped a node-pty
 * native built on a glibc 2.42 host, so the local computer died at load on every
 * distro older than that (Ubuntu 24.04, Debian 12) — and nothing in the release
 * could see it, because the smoke test runs on the build host.
 *
 * The ELF files are synthesized here (one section table, a .dynstr and a
 * .gnu.version_r) so the parser is pinned on every platform without committing
 * binaries.
 *
 * Run with: npx tsx scripts/release/check-glibc-floor.test.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  checkGlibcFloor,
  compareVersions,
  LINUX_FLOOR,
  requiredSymbolVersions
} from './check-glibc-floor.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : e}`)
    failed++
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label ? `${label}: ` : ''}expected ${b}, got ${a}`)
}

/**
 * A minimal ELF whose .gnu.version_r says it needs `needs` = { 'libc.so.6':
 * ['GLIBC_2.2.5', …], … }. Sections: [null, .dynstr, .gnu.version_r, .shstrtab].
 */
function elf(needs, { bits = 64, littleEndian = true, sections = true } = {}) {
  const is64 = bits === 64
  // .dynstr: every library and version name.
  const strs = ['']
  const strOff = new Map()
  let dynstrLen = 1
  const intern = (s) => {
    if (!strOff.has(s)) {
      strOff.set(s, dynstrLen)
      strs.push(s)
      dynstrLen += Buffer.byteLength(s) + 1
    }
    return strOff.get(s)
  }
  const libs = Object.entries(needs)
  for (const [lib, versions] of libs) {
    intern(lib)
    for (const v of versions) intern(v)
  }
  const dynstr = Buffer.from(strs.map((s) => `${s}\0`).join(''), 'utf8')

  // .gnu.version_r: one Verneed (16 bytes) per library, each followed by its Vernaux
  // entries (16 bytes each).
  const verneed = Buffer.alloc(libs.reduce((n, [, vs]) => n + 16 + 16 * vs.length, 0))
  const w16 = (b, o, v) => (littleEndian ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o))
  const w32 = (b, o, v) => (littleEndian ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o))
  let o = 0
  libs.forEach(([lib, versions], i) => {
    const size = 16 + 16 * versions.length
    w16(verneed, o, 1)
    w16(verneed, o + 2, versions.length)
    w32(verneed, o + 4, strOff.get(lib))
    w32(verneed, o + 8, 16)
    w32(verneed, o + 12, i === libs.length - 1 ? 0 : size)
    versions.forEach((v, j) => {
      const a = o + 16 + 16 * j
      w32(verneed, a + 8, strOff.get(v))
      w32(verneed, a + 12, j === versions.length - 1 ? 0 : 16)
    })
    o += size
  })

  const shstrtab = Buffer.from('\0.dynstr\0.gnu.version_r\0.shstrtab\0', 'utf8')
  const ehsize = is64 ? 64 : 52
  const shentsize = is64 ? 64 : 40
  const dynstrOff = ehsize
  const verneedOff = dynstrOff + dynstr.length
  const shstrOff = verneedOff + verneed.length
  const shoff = shstrOff + shstrtab.length
  const out = Buffer.alloc(shoff + (sections ? 4 * shentsize : 0))
  out.write('\x7fELF', 0, 'latin1')
  out[4] = is64 ? 2 : 1
  out[5] = littleEndian ? 1 : 2
  out[6] = 1
  const wN = (off, v) =>
    is64
      ? littleEndian
        ? out.writeBigUInt64LE(BigInt(v), off)
        : out.writeBigUInt64BE(BigInt(v), off)
      : w32(out, off, v)
  w16(out, 16, 3) // ET_DYN
  wN(is64 ? 0x28 : 0x20, sections ? shoff : 0)
  w16(out, is64 ? 0x3a : 0x2e, shentsize)
  w16(out, is64 ? 0x3c : 0x30, sections ? 4 : 0)
  w16(out, is64 ? 0x3e : 0x32, sections ? 3 : 0)
  dynstr.copy(out, dynstrOff)
  verneed.copy(out, verneedOff)
  shstrtab.copy(out, shstrOff)
  if (sections) {
    const sh = (idx, { name, type, offset, size, link = 0, info = 0 }) => {
      const b = shoff + idx * shentsize
      w32(out, b, name)
      w32(out, b + 4, type)
      if (is64) {
        wN(b + 24, offset)
        wN(b + 32, size)
        w32(out, b + 40, link)
        w32(out, b + 44, info)
      } else {
        w32(out, b + 16, offset)
        w32(out, b + 20, size)
        w32(out, b + 24, link)
        w32(out, b + 28, info)
      }
    }
    sh(1, { name: 1, type: 3, offset: dynstrOff, size: dynstr.length })
    sh(2, {
      name: 9,
      type: 0x6ffffffe,
      offset: verneedOff,
      size: verneed.length,
      link: 1,
      info: libs.length
    })
    sh(3, { name: 24, type: 3, offset: shstrOff, size: shstrtab.length })
  }
  return out
}

console.log('\n=== Linux glibc floor gate ===\n')

test('compareVersions orders dotted versions numerically', () => {
  eq(compareVersions('2.42', '2.35') > 0, true, '2.42 > 2.35')
  eq(compareVersions('2.9', '2.35') < 0, true, '2.9 < 2.35')
  eq(compareVersions('2.2.5', '2.2') > 0, true, '2.2.5 > 2.2')
  eq(compareVersions('3.4.30', '3.4.30'), 0, 'equal')
})

test('reads every required symbol version, per library', () => {
  const buf = elf({
    'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.42'],
    'libstdc++.so.6': ['GLIBCXX_3.4.21', 'CXXABI_1.3']
  })
  eq(
    requiredSymbolVersions(buf),
    [
      { lib: 'libc.so.6', version: 'GLIBC_2.2.5' },
      { lib: 'libc.so.6', version: 'GLIBC_2.42' },
      { lib: 'libstdc++.so.6', version: 'GLIBCXX_3.4.21' },
      { lib: 'libstdc++.so.6', version: 'CXXABI_1.3' }
    ],
    'versions'
  )
})

test('reads 32-bit and big-endian ELF too', () => {
  const needs = { 'libc.so.6': ['GLIBC_2.4'] }
  const want = [{ lib: 'libc.so.6', version: 'GLIBC_2.4' }]
  eq(requiredSymbolVersions(elf(needs, { bits: 32 })), want, '32-bit')
  eq(requiredSymbolVersions(elf(needs, { littleEndian: false })), want, 'big-endian')
})

test('a non-ELF file has no requirements; an ELF without a section table is unreadable', () => {
  eq(requiredSymbolVersions(Buffer.from('#!/bin/sh\necho hi\n')), null, 'not ELF')
  let threw = false
  try {
    requiredSymbolVersions(elf({ 'libc.so.6': ['GLIBC_2.2.5'] }, { sections: false }))
  } catch {
    threw = true
  }
  eq(threw, true, 'fails closed rather than passing a file it cannot read')
})

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'glibc-floor-test-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

test('the v0.36.0 node-pty (GLIBC_2.42) fails the gate, naming file and version', () => {
  const dir = tree({
    'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node': elf({
      'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.42']
    }),
    'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node':
      elf({ 'libc.so.6': ['GLIBC_2.34'] }),
    'resources/app.asar': 'not elf'
  })
  try {
    const { violations, scanned } = checkGlibcFloor(dir, { GLIBC: '2.35' })
    eq(scanned, 2, 'scans every ELF file, skips the rest')
    eq(
      violations,
      [
        {
          file: 'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
          version: 'GLIBC_2.42',
          floor: 'GLIBC_2.35'
        }
      ],
      'only the over-floor requirement'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('libstdc++ requirements are gated too; unrelated version families are not', () => {
  const dir = tree({
    'a.node': elf({ 'libstdc++.so.6': ['GLIBCXX_3.4.32', 'CXXABI_1.3.15'] }),
    'b.node': elf({ 'libgcc_s.so.1': ['GCC_14.0'], 'libnss3.so': ['NSS_3.99'] })
  })
  try {
    const { violations } = checkGlibcFloor(dir, { GLIBCXX: '3.4.30', CXXABI: '1.3.13' })
    eq(
      violations.map((v) => `${v.file} ${v.version}`),
      ['a.node GLIBCXX_3.4.32', 'a.node CXXABI_1.3.15'],
      'libstdc++ over the floor'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GLIBC_PRIVATE is never portable', () => {
  const dir = tree({ 'x.node': elf({ 'libc.so.6': ['GLIBC_PRIVATE'] }) })
  try {
    eq(checkGlibcFloor(dir, { GLIBC: '2.35' }).violations.length, 1, 'violation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('symlinks are not followed (their targets are scanned where they live)', () => {
  const dir = tree({ 'real.node': elf({ 'libc.so.6': ['GLIBC_2.42'] }) })
  try {
    symlinkSync(path.join(dir, 'real.node'), path.join(dir, 'link.node'))
    eq(checkGlibcFloor(dir, { GLIBC: '2.35' }).violations.length, 1, 'counted once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped floor covers Ubuntu 22.04 and Debian 12', () => {
  // Raising it drops a supported distro; read #165 first.
  eq(compareVersions(LINUX_FLOOR.GLIBC, '2.35') <= 0, true, 'GLIBC ≤ 2.35 (Ubuntu 22.04)')
  eq(compareVersions(LINUX_FLOOR.GLIBCXX, '3.4.30') <= 0, true, 'GLIBCXX ≤ 3.4.30 (gcc 12)')
  eq(compareVersions(LINUX_FLOOR.CXXABI, '1.3.13') <= 0, true, 'CXXABI ≤ 1.3.13 (gcc 12)')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
