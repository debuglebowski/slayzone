#!/usr/bin/env node
/**
 * Release gate: every native binary a packaged build ships for its own platform is
 * built for the TARGET arch, and every per-platform binary package a native loads
 * is there for that target.
 *
 *   node scripts/release/check-native-arch.mjs <unpacked app dir | .app> --platform <darwin|win32|linux> --arch <x64|arm64>
 *
 * Why this exists. macOS x64 is built on an arm64 runner and Windows arm64 on an x64
 * one, and neither can run its build, so the packaged-app smoke (which loads every
 * native) skips them. pnpm installs an optional per-platform package only for the
 * BUILD host, so those two shipped node-datachannel with the host's binary alone:
 * the main package resolved, the computer advertised WebRTC, and every offer failed
 * to load the addon. The release now installs the target's packages too
 * (release-foundation.yml), and this proves the build output carries them — by
 * reading binary headers, so it runs on any host for any target.
 *
 * Checked, under `app.asar.unpacked/node_modules` (where every native ships):
 *   1. every Mach-O / PE / ELF file meant for the target is of the target's format
 *      and includes its arch. Files are skipped when they are not for the target: in
 *      a per-platform package whose package.json `os`/`cpu` excludes it, or under a
 *      path tagged for another platform-arch (node-pty's `prebuilds/win32-x64/`,
 *      better-sqlite3's `prebuilds/linux-arm64.node`). Untagged files (a
 *      `build/Release` compiled by electron-builder) must match.
 *   2. every optionalDependency a shipped package names for the target platform-arch
 *      (napi-rs style: `@node-datachannel/win32-arm64-msvc`) is shipped, with a
 *      binary that passes 1.
 *
 * Pure JS (no file/otool/dumpbin), so the parser is pinned by tests on any platform.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The binary format each platform loads. */
const FORMAT = { darwin: 'macho', win32: 'pe', linux: 'elf' }

const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' }
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32', 0x1c4: 'arm' }
const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' }

/**
 * The format and arch(es) of a binary from its first bytes: `{ format, arches }`
 * (a universal Mach-O lists several), or null for anything that is not Mach-O, PE or
 * ELF. An arch this does not know is reported as `unknown(0x…)`.
 */
export function binaryArch(buf) {
  if (buf.length < 4) return null
  const name = (table, v) => table[v] ?? `unknown(0x${v.toString(16)})`
  // Thin Mach-O, 64- and 32-bit, little-endian (every Apple target).
  const le = buf.readUInt32LE(0)
  if (le === 0xfeedfacf || le === 0xfeedface) {
    if (buf.length < 8) return null
    return { format: 'macho', arches: [name(MACHO_CPU, buf.readUInt32LE(4))] }
  }
  // Universal (fat) Mach-O: big-endian header, then one fat_arch per slice.
  const be = buf.readUInt32BE(0)
  if (be === 0xcafebabe || be === 0xcafebabf) {
    if (buf.length < 8) return null
    const n = buf.readUInt32BE(4)
    // 0xcafebabe is also a Java class file; its "count" (a version) is far above this.
    if (n === 0 || n > 16) return null
    const entry = be === 0xcafebabf ? 32 : 20
    const arches = []
    for (let i = 0; i < n; i++) {
      const o = 8 + i * entry
      if (o + 4 > buf.length) throw new Error('fat Mach-O header truncated')
      arches.push(name(MACHO_CPU, buf.readUInt32BE(o)))
    }
    return { format: 'macho', arches }
  }
  // PE: MZ stub, e_lfanew at 0x3c → "PE\0\0" + Machine.
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return null
    const pe = buf.readUInt32LE(0x3c)
    if (pe + 6 > buf.length || buf.readUInt32BE(pe) !== 0x50450000) return null
    return { format: 'pe', arches: [name(PE_MACHINE, buf.readUInt16LE(pe + 4))] }
  }
  // ELF: e_machine at 18, in the file's byte order.
  if (be === 0x7f454c46) {
    if (buf.length < 20) return null
    const machine = buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18)
    return { format: 'elf', arches: [name(ELF_MACHINE, machine)] }
  }
  return null
}

const PLATFORM_ALIASES = {
  darwin: 'darwin',
  mac: 'darwin',
  macos: 'darwin',
  linux: 'linux',
  linuxmusl: 'linux',
  win32: 'win32',
  win: 'win32',
  win10: 'win32',
  windows: 'win32',
  android: 'android',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  sunos: 'sunos',
  aix: 'aix'
}
const ARCH_ALIASES = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  ia32: 'ia32',
  x86: 'ia32',
  arm: 'arm'
}
const TAG = new RegExp(
  `(?:^|[/_.-])(${Object.keys(PLATFORM_ALIASES).join('|')})-(${Object.keys(ARCH_ALIASES).join('|')})(?=$|[/_.-])`,
  'g'
)

/**
 * The platform-arch a path is tagged for (`prebuilds/darwin-x64/pty.node` →
 * `{ platform: 'darwin', arch: 'x64' }`), from its last tag, or null when untagged.
 */
export function pathTag(rel) {
  let last = null
  for (const m of rel.toLowerCase().matchAll(TAG)) last = m
  return last ? { platform: PLATFORM_ALIASES[last[1]], arch: ARCH_ALIASES[last[2]] } : null
}

/** npm's `os`/`cpu` semantics: absent = any; `!x` entries exclude. */
function fieldAllows(field, value) {
  if (!Array.isArray(field) || field.length === 0) return true
  if (field.includes(value)) return true
  if (field.includes(`!${value}`)) return false
  return field.every((v) => typeof v === 'string' && v.startsWith('!'))
}

/**
 * Whether an optional dependency's NAME says it is the target's binary package:
 * napi-rs-style names carry the platform and arch as tokens
 * (`@node-datachannel/darwin-x64`, `win32-arm64-msvc`, `linux-x64-gnu`). On Linux
 * the musl build is not the target (the release builds glibc).
 */
export function namesTargetPackage(name, { platform, arch }) {
  const tokens = name
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .split(/[-_.]/)
  const platforms = new Set(tokens.map((t) => PLATFORM_ALIASES[t]).filter(Boolean))
  const arches = new Set(tokens.map((t) => ARCH_ALIASES[t]).filter(Boolean))
  if (platforms.size !== 1 || arches.size !== 1) return false
  if (!platforms.has(platform) || !arches.has(arch)) return false
  return !(platform === 'linux' && tokens.includes('musl'))
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Every package dir under a node_modules dir (scoped ones included, nested ones too). */
function* packageDirs(nodeModules) {
  if (!existsSync(nodeModules)) return
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const abs = path.join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(abs, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue
        const dir = path.join(abs, scoped.name)
        yield { name: `${entry.name}/${scoped.name}`, dir }
        yield* packageDirs(path.join(dir, 'node_modules'))
      }
    } else {
      yield { name: entry.name, dir: abs }
      yield* packageDirs(path.join(abs, 'node_modules'))
    }
  }
}

/** Every regular file of one package, not descending into its nested node_modules. */
function* packageFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* packageFiles(abs)
    } else if (entry.isFile()) {
      yield abs
    }
  }
}

function readHead(file, bytes = 4096) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0))
  } finally {
    closeSync(fd)
  }
}

/** How a package that a dependency names would be found: nested first, then upward. */
function locatePackage(fromDir, name, nodeModulesRoot) {
  let dir = fromDir
  while (true) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.resolve(dir) === path.resolve(path.dirname(nodeModulesRoot))) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Check the natives under `nodeModules` (an `app.asar.unpacked/node_modules`) for
 * `target` = { platform, arch }. Returns { checked, skipped, violations, unreadable }.
 */
export function checkNativeArch(nodeModules, target) {
  const format = FORMAT[target.platform]
  if (!format) throw new Error(`unsupported platform: ${target.platform}`)
  const checked = []
  const skipped = []
  const violations = []
  const unreadable = []
  /** package dir → the target binaries in it that passed. */
  const goodByPackage = new Map()
  const packages = [...packageDirs(nodeModules)]

  for (const { name, dir } of packages) {
    const manifest = readJson(path.join(dir, 'package.json')) ?? {}
    const forTarget =
      fieldAllows(manifest.os, target.platform) && fieldAllows(manifest.cpu, target.arch)
    for (const abs of packageFiles(dir)) {
      const rel = path.relative(nodeModules, abs).split(path.sep).join('/')
      let head
      try {
        head = readHead(abs)
      } catch (err) {
        unreadable.push({ file: rel, error: String(err) })
        continue
      }
      let found
      try {
        found = binaryArch(head)
      } catch (err) {
        unreadable.push({ file: rel, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (!found) continue
      if (!forTarget) {
        skipped.push({
          file: rel,
          reason: `${name} is for ${manifest.os ?? '*'}/${manifest.cpu ?? '*'}`
        })
        continue
      }
      // Tags inside the package only: the package's own name is not a tag for its files.
      const tag = pathTag(path.relative(dir, abs).split(path.sep).join('/'))
      if (tag && (tag.platform !== target.platform || tag.arch !== target.arch)) {
        skipped.push({ file: rel, reason: `tagged ${tag.platform}-${tag.arch}` })
        continue
      }
      const ok = found.format === format && found.arches.includes(target.arch)
      const entry = { file: rel, format: found.format, arches: found.arches }
      if (ok) {
        checked.push(entry)
        goodByPackage.set(dir, [...(goodByPackage.get(dir) ?? []), rel])
      } else {
        violations.push({
          ...entry,
          problem: `is ${found.format} ${found.arches.join('+')}, target is ${format} ${target.arch}`
        })
      }
    }
  }

  // 2. The target's per-platform package of every native that loads one.
  for (const { name, dir } of packages) {
    const manifest = readJson(path.join(dir, 'package.json')) ?? {}
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!namesTargetPackage(dep, target)) continue
      const located = locatePackage(dir, dep, nodeModules)
      if (!located) {
        violations.push({
          file: `${name} → ${dep}`,
          problem: `${name} loads ${dep} on ${target.platform}-${target.arch}, and it is not shipped`
        })
      } else if (!goodByPackage.has(located)) {
        violations.push({
          file: `${name} → ${dep}`,
          problem: `${dep} is shipped without a ${format} ${target.arch} binary`
        })
      }
    }
  }
  return { checked, skipped, violations, unreadable }
}

/** `Resources` of a `.app` (or a dir holding one), else `<dir>/resources`. */
export function resourcesDir(input) {
  const abs = path.resolve(input)
  const app =
    existsSync(abs) && !abs.endsWith('.app')
      ? readdirSync(abs).find((f) => f.endsWith('.app'))
      : undefined
  const root = app ? path.join(abs, app) : abs
  const mac = path.join(root, 'Contents', 'Resources')
  return existsSync(mac) ? mac : path.join(root, 'resources')
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i]
    else out._.push(argv[i])
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2))
  const input = args._[0]
  if (!input || !args.platform || !args.arch) {
    console.error(
      'usage: check-native-arch.mjs <unpacked app dir | SlayZone.app> --platform <darwin|win32|linux> --arch <x64|arm64>'
    )
    process.exit(2)
  }
  const target = { platform: args.platform, arch: args.arch }
  const nodeModules = path.join(resourcesDir(input), 'app.asar.unpacked', 'node_modules')
  console.log(`natives for ${target.platform}-${target.arch} under ${nodeModules}`)
  if (!existsSync(nodeModules)) {
    console.log('  ✗ no app.asar.unpacked/node_modules — wrong directory?')
    process.exit(1)
  }
  // Electron's own Node, when run under it, would read app.asar paths as archives.
  process.noAsar = true
  const { checked, skipped, violations, unreadable } = checkNativeArch(nodeModules, target)
  for (const c of checked) console.log(`  ✓ ${c.file} (${c.format} ${c.arches.join('+')})`)
  console.log(`  · ${skipped.length} binaries for other platforms skipped`)
  for (const u of unreadable) console.log(`  ✗ cannot read ${u.file}: ${u.error}`)
  for (const v of violations) console.log(`  ✗ ${v.file}: ${v.problem}`)
  if (checked.length === 0)
    console.log('  ✗ no native binary for the target found — wrong directory?')
  if (violations.length || unreadable.length || checked.length === 0) {
    console.log(
      `\nNATIVE ARCH FAILED — this build would ship natives that cannot load on ${target.platform}-${target.arch}.`
    )
    process.exit(1)
  }
  console.log('\nNATIVE ARCH OK')
}
