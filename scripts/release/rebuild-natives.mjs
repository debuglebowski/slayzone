#!/usr/bin/env node

// Rebuilds the app's native modules for Electron the way electron-builder's own
// `npmRebuild` step does (same @electron/rebuild options), except that a module whose
// package ships a Node-API prebuild for the target platform-arch is left on that prebuild
// instead of being compiled from source.
//
// Why: node-pty ships N-API prebuilds (prebuilds/<platform>-<arch>/) that load under any
// Electron, but it is not prebuildify-tagged, so @electron/rebuild compiles it anyway. On
// Windows that compiles winpty + conpty: ~83 s per arch (~3 s on macOS). Its loader tries
// build/Release first and prebuilds/<platform>-<arch> second, so with no build/Release
// the prebuild is what runs.
//
// Used only for Windows (the release workflow passes -c.npmRebuild=false there). macOS
// keeps electron-builder's rebuild: its spawn-helper prebuild can lose its execute bit
// (pnpm), and compiling there costs seconds. Linux has no node-pty prebuild at all.
//
// Usage: rebuild-natives.mjs --app-dir <dir> --workspace-root <dir> --electron-version <v>
//          --platform <win32|darwin|linux> --arch <x64|arm64>

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { rebuild } from '@electron/rebuild'

// Module → the files its prebuild dir must hold for the prebuild to stand in for a build.
const PREBUILT = {
  win32: { 'node-pty': ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe'] }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (!current.startsWith('--')) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${current}`)
    args[current.slice(2)] = value
    i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
for (const key of ['app-dir', 'workspace-root', 'electron-version', 'platform', 'arch']) {
  if (!args[key]) {
    throw new Error(
      'Usage: rebuild-natives.mjs --app-dir <dir> --workspace-root <dir> --electron-version <v> --platform <p> --arch <a>'
    )
  }
}

const appDir = path.resolve(args['app-dir'])
const workspaceRoot = path.resolve(args['workspace-root'])
const { platform, arch } = args

// Fail loudly rather than ship a module that has neither a build nor a prebuild, or one
// whose stale build/Release (which its loader prefers) would shadow the prebuild.
const ignoreModules = []
for (const [name, files] of Object.entries(PREBUILT[platform] ?? {})) {
  const moduleDir = path.join(workspaceRoot, 'node_modules', name)
  const prebuildDir = path.join(moduleDir, 'prebuilds', `${platform}-${arch}`)
  const missing = files.filter((f) => !existsSync(path.join(prebuildDir, f)))
  if (missing.length > 0) {
    throw new Error(
      `${name}: prebuild for ${platform}-${arch} lacks ${missing.join(', ')} (${prebuildDir})`
    )
  }
  const buildDir = path.join(moduleDir, 'build', 'Release')
  const stale = existsSync(buildDir) ? readdirSync(buildDir).filter((f) => f.endsWith('.node')) : []
  if (stale.length > 0) {
    throw new Error(
      `${name}: build/Release holds ${stale.join(', ')}, which would load before the prebuild`
    )
  }
  console.log(`${name}: using prebuilds/${platform}-${arch}`)
  ignoreModules.push(name)
}

// node-pty's install script copies conpty.dll + OpenConsole.exe for the BUILD host's arch
// into build/Release/conpty, so the arm64 app (cross-built on x64) shipped x64 copies there
// (scripts/release/check-native-arch.mjs refuses them). Re-run that script for the TARGET
// arch: the folder then matches the prebuild it sits next to. It no-ops off Windows.
if (platform === 'win32') {
  execFileSync(
    process.execPath,
    [path.join(workspaceRoot, 'node_modules', 'node-pty', 'scripts', 'post-install.js')],
    { stdio: 'inherit', env: { ...process.env, npm_config_arch: arch } }
  )
}

// Mirrors app-builder-lib's util/yarn.js rebuild() options.
const rebuilder = rebuild({
  buildPath: appDir,
  projectRootPath: workspaceRoot,
  electronVersion: args['electron-version'],
  platform,
  arch,
  buildFromSource: false,
  mode: 'sequential',
  disablePreGypCopy: true,
  ignoreModules
})
rebuilder.lifecycle.on('module-found', (name) => console.log(`preparing ${name} (${arch})`))
rebuilder.lifecycle.on('module-done', (name) => console.log(`finished ${name} (${arch})`))
rebuilder.lifecycle.on('module-skip', (name) => console.log(`skipped ${name} (${arch})`))
await rebuilder
console.log('completed installing native dependencies')
