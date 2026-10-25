import { promises as fsp } from 'fs'
import { join } from 'path'

// Finds Chrome extensions installed in the user's other Chromium browsers, for the
// browser panel's import list. Each browser keeps one Extensions/ dir per PROFILE,
// and the profile is often not `Default` (Chrome names later ones "Profile 1",
// "Profile 4", …), so every profile is scanned and labelled with the display name
// the browser shows for it (from its `Local State`).

/** macOS user-data dirs under ~/Library/Application Support. */
const KNOWN_BROWSERS = [
  { name: 'Chrome', dir: 'Google/Chrome' },
  { name: 'Arc', dir: 'Arc/User Data' },
  { name: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { name: 'Edge', dir: 'Microsoft Edge' },
  { name: 'Chromium', dir: 'Chromium' },
  { name: 'Vivaldi', dir: 'Vivaldi' }
]

export interface DiscoveredExtension {
  id: string
  name: string
  version: string
  path: string
  alreadyImported: boolean
  manifestVersion?: number
}

export interface DiscoveredBrowserGroup {
  name: string
  extensions: DiscoveredExtension[]
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf-8'))
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

/** Profile dirs with their display name (unnamed: the dir, or none for Default), Default first. */
async function listProfiles(userDataDir: string): Promise<{ dir: string; label: string | null }[]> {
  let names: Record<string, string> = {}
  try {
    const state = (await readJson(join(userDataDir, 'Local State'))) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> }
    }
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (typeof info?.name === 'string') names[dir] = info.name
    }
  } catch {
    names = {}
  }
  const dirs = (await readdirOrEmpty(userDataDir))
    .filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    .sort((a, b) =>
      a === 'Default' ? -1 : b === 'Default' ? 1 : profileNumber(a) - profileNumber(b)
    )
  return dirs.map((dir) => ({ dir, label: names[dir] ?? (dir === 'Default' ? null : dir) }))
}

function profileNumber(dir: string): number {
  return Number.parseInt(dir.replace('Profile ', ''), 10)
}

/** Installed version dirs look like "8.11.0_0"; compare their numeric parts. */
function compareVersionDirs(a: string, b: string): number {
  const pa = a.split(/[._]/).map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[._]/).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function localizedName(extPath: string, name: string): Promise<string> {
  if (!name.startsWith('__MSG_')) return name
  const key = name.slice(6, -2)
  for (const lang of ['en', 'en_US', 'en_GB']) {
    try {
      const msgs = (await readJson(join(extPath, '_locales', lang, 'messages.json'))) as Record<
        string,
        { message?: string }
      >
      if (msgs[key]?.message) return msgs[key].message as string
    } catch {
      /* try next lang */
    }
  }
  return name
}

async function readProfileExtensions(
  extensionsDir: string,
  loadedIds: Set<string>
): Promise<DiscoveredExtension[]> {
  const extensions: DiscoveredExtension[] = []
  for (const id of await readdirOrEmpty(extensionsDir)) {
    if (id === 'Temp' || id.startsWith('.')) continue
    const idDir = join(extensionsDir, id)
    const version = (await readdirOrEmpty(idDir)).sort(compareVersionDirs).pop()
    if (!version) continue
    const extPath = join(idDir, version)
    try {
      const manifest = (await readJson(join(extPath, 'manifest.json'))) as {
        name?: string
        version?: string
        manifest_version?: unknown
      }
      extensions.push({
        id,
        name: await localizedName(extPath, manifest.name || id),
        version: manifest.version || '?',
        path: extPath,
        alreadyImported: loadedIds.has(id),
        manifestVersion:
          typeof manifest.manifest_version === 'number' ? manifest.manifest_version : undefined
      })
    } catch {
      /* skip unreadable extensions */
    }
  }
  return extensions
}

export async function discoverBrowserExtensions(opts: {
  appSupportDir: string
  loadedIds: Set<string>
}): Promise<DiscoveredBrowserGroup[]> {
  const results: DiscoveredBrowserGroup[] = []
  for (const browser of KNOWN_BROWSERS) {
    const userDataDir = join(opts.appSupportDir, browser.dir)
    for (const profile of await listProfiles(userDataDir)) {
      const extensions = await readProfileExtensions(
        join(userDataDir, profile.dir, 'Extensions'),
        opts.loadedIds
      )
      if (extensions.length === 0) continue
      results.push({
        name: profile.label ? `${browser.name} (${profile.label})` : browser.name,
        extensions
      })
    }
  }
  return results
}
