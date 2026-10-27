#!/usr/bin/env node
/**
 * Release gate: no ELF file in a Linux build may need a newer glibc / libstdc++
 * than the oldest distro we ship to.
 *
 *   node scripts/release/check-glibc-floor.mjs packages/apps/app/dist/linux-unpacked
 *
 * Why this exists (#165). v0.36.0's Linux build ran on `ubuntu-latest`, whose glibc
 * had moved to 2.42; electron-builder compiles node-pty from source there (it ships
 * no Linux prebuild), and the resulting `pty.node` needed `GLIBC_2.42`. On every
 * older distro — Ubuntu 24.04 LTS, Debian 12 — the local computer died at load, so
 * no terminal, agent or git work could run. The smoke test could not see it: it runs
 * the build on the host that built it. Only the binaries' own symbol-version
 * requirements say which systems they load on, so this reads them.
 *
 * Every regular ELF file under the directory is checked — natives (`.node`), the
 * helpers they exec (node-pty's `spawn-helper`), and Electron itself — so a new
 * native module, or one that loses its prebuild, is covered without being listed.
 * The .deb and the AppImage are packed from this same directory.
 *
 * Pure JS (no binutils), so the parser is pinned by tests on any platform.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The oldest runtime the Linux build must load on: Ubuntu 22.04 (glibc 2.35;
 * libstdc++ from gcc 12 → GLIBCXX_3.4.30 / CXXABI_1.3.13). Debian 12 (2.36) and
 * every newer distro are above it. The release builds on `ubuntu-22.04` to meet it
 * (release-foundation.yml); this gate is what proves the build did.
 */
export const LINUX_FLOOR = { GLIBC: '2.35', GLIBCXX: '3.4.30', CXXABI: '1.3.13' }

const SHT_GNU_VERNEED = 0x6ffffffe

/** Numeric compare of dotted versions ('2.9' < '2.35'). */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The symbol versions an ELF file needs from its shared libraries (its
 * `.gnu.version_r`), e.g. `{ lib: 'libc.so.6', version: 'GLIBC_2.42' }` — what
 * `objdump -p` lists under "Version References". Null for a non-ELF file; throws for
 * an ELF it cannot read, so the gate fails closed.
 */
export function requiredSymbolVersions(buf) {
  if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46) return null
  const is64 = buf[4] === 2
  const le = buf[5] === 1
  if ((buf[4] !== 1 && buf[4] !== 2) || (buf[5] !== 1 && buf[5] !== 2)) {
    throw new Error('unknown ELF class or byte order')
  }
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const uN = (o) => (is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o))

  const shoff = uN(is64 ? 0x28 : 0x20)
  const shentsize = u16(is64 ? 0x3a : 0x2e)
  const shnum = u16(is64 ? 0x3c : 0x30)
  if (shoff === 0 || shnum === 0) throw new Error('no section header table')
  const section = (i) => {
    const b = shoff + i * shentsize
    if (b + shentsize > buf.length) throw new Error('section header out of bounds')
    return is64
      ? {
          type: u32(b + 4),
          offset: uN(b + 24),
          size: uN(b + 32),
          link: u32(b + 40),
          info: u32(b + 44)
        }
      : {
          type: u32(b + 4),
          offset: u32(b + 16),
          size: u32(b + 20),
          link: u32(b + 24),
          info: u32(b + 28)
        }
  }

  const out = []
  for (let i = 0; i < shnum; i++) {
    const vr = section(i)
    if (vr.type !== SHT_GNU_VERNEED) continue
    const strtab = section(vr.link)
    const str = (o) => {
      const start = strtab.offset + o
      const end = buf.indexOf(0, start)
      if (end < 0 || end > strtab.offset + strtab.size) throw new Error('string out of bounds')
      return buf.toString('utf8', start, end)
    }
    let need = vr.offset
    for (let n = 0; n < vr.info; n++) {
      const cnt = u16(need + 2)
      const lib = str(u32(need + 4))
      let aux = need + u32(need + 8)
      for (let k = 0; k < cnt; k++) {
        out.push({ lib, version: str(u32(aux + 8)) })
        const next = u32(aux + 12)
        if (next === 0) break
        aux += next
      }
      const next = u32(need + 12)
      if (next === 0) break
      need += next
    }
  }
  return out
}

/** Every regular file under `dir` (symlinks are not followed: their targets are scanned where they live). */
function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(abs, base)
    else if (entry.isFile()) yield abs
  }
}

/**
 * Check every ELF file under `dir` against `floor` ({ GLIBC: '2.35', … } — families
 * not named are not gated). A requirement over the floor, or GLIBC_PRIVATE (never
 * portable), is a violation; so is an ELF file that cannot be read.
 */
export function checkGlibcFloor(dir, floor = LINUX_FLOOR) {
  const violations = []
  const unreadable = []
  /** Highest requirement seen per family, for the report. */
  const highest = {}
  let scanned = 0
  for (const abs of walk(dir)) {
    const rel = path.relative(dir, abs).split(path.sep).join('/')
    // Only the 4-byte magic decides; reading every byte of every file is not needed.
    if (lstatSync(abs).size < 4) continue
    let versions
    try {
      versions = requiredSymbolVersions(readFileSync(abs))
    } catch (err) {
      unreadable.push({ file: rel, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (versions === null) continue
    scanned++
    for (const { version } of versions) {
      const m = /^([A-Z]+)_(.+)$/.exec(version)
      if (!m) continue
      const [, family, v] = m
      if (!(family in floor)) continue
      if (v === 'PRIVATE') {
        violations.push({ file: rel, version, floor: `${family}_${floor[family]}` })
        continue
      }
      if (!/^\d+(\.\d+)*$/.test(v)) continue
      if (!highest[family] || compareVersions(v, highest[family].v) > 0) {
        highest[family] = { v, file: rel }
      }
      if (compareVersions(v, floor[family]) > 0) {
        violations.push({ file: rel, version, floor: `${family}_${floor[family]}` })
      }
    }
  }
  return { scanned, violations, unreadable, highest }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: check-glibc-floor.mjs <linux-unpacked dir>')
    process.exit(2)
  }
  const { scanned, violations, unreadable, highest } = checkGlibcFloor(path.resolve(dir))
  console.log(`scanned ${scanned} ELF files under ${dir}`)
  for (const [family, { v, file }] of Object.entries(highest)) {
    console.log(`  highest ${family}_${v} (floor ${LINUX_FLOOR[family]}) — ${file}`)
  }
  for (const u of unreadable) console.log(`  ✗ cannot read ${u.file}: ${u.error}`)
  for (const v of violations) console.log(`  ✗ ${v.file} needs ${v.version} (floor ${v.floor})`)
  if (scanned === 0) console.log('  ✗ no ELF files found — wrong directory?')
  if (violations.length || unreadable.length || scanned === 0) {
    console.log(
      '\nGLIBC FLOOR FAILED — these binaries will not load on older supported distros (#165). ' +
        'Build them on a host at the floor, not above it.'
    )
    process.exit(1)
  }
  console.log('\nGLIBC FLOOR OK')
}
