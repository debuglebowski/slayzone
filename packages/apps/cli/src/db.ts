import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getStateDir } from '@slayzone/platform'
export { resolveProject, resolveProjectByPath } from './db-helpers.mjs'
export type { SlayDb } from './db-helpers.mjs'
import type { SlayDb } from './db-helpers.mjs'

function defaultDir(): string {
  const dir = getStateDir()
  if (fs.existsSync(dir)) return dir
  // Fallback: CLI runs before app has migrated data on Linux
  // TODO: remove legacy fallback once Linux migration has been out for a few releases
  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const legacyDir = path.join(configHome, 'slayzone')
    if (fs.existsSync(legacyDir)) return legacyDir
  }
  return dir
}

function getDbPath(dev: boolean): string {
  // Full path override — used by e2e tests to share the running app's DB
  if (process.env.SLAYZONE_DB_PATH) return process.env.SLAYZONE_DB_PATH
  const dir = process.env.SLAYZONE_DB_DIR ?? defaultDir()
  const name = dev ? 'slayzone.dev.sqlite' : 'slayzone.sqlite'
  return path.join(dir, name)
}

type SqlParams = Record<string, string | number | bigint | null | Uint8Array>

export function getMcpPort(): number | null {
  if (process.env.SLAYZONE_MCP_PORT) return parseInt(process.env.SLAYZONE_MCP_PORT, 10) || null
  try {
    const db = openDb()
    const row = db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'mcp_server_port' LIMIT 1`)
    db.close()
    const port = parseInt(row[0]?.value ?? '', 10)
    return (port > 0 && port <= 65535) ? port : null
  } catch {
    return null
  }
}

function getAlternateMcpPort(): number | null {
  if (process.env.SLAYZONE_DB_PATH || process.env.SLAYZONE_MCP_PORT) return null
  const dev = process.env.SLAYZONE_DEV === '1'
  const altPath = getDbPath(!dev)
  if (!fs.existsSync(altPath)) return null
  try {
    const altDb = new DatabaseSync(altPath)
    const row = altDb.prepare(`SELECT value FROM settings WHERE key = 'mcp_server_port' LIMIT 1`).get() as { value: string } | undefined
    altDb.close()
    const port = parseInt(row?.value ?? '', 10)
    return (port > 0 && port <= 65535) ? port : null
  } catch {
    return null
  }
}

export function postJson(port: number, path: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST' },
      (res) => {
        res.resume()
        res.on('end', () => {
          const code = res.statusCode ?? 0
          resolve(code >= 200 && code < 300)
        })
      },
    )
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function probePort(port: number): Promise<boolean> {
  return postJson(port, '/api/notify', 1000)
}

export async function notifyApp(): Promise<void> {
  const port = getMcpPort()
  if (port) {
    const ok = await postJson(port, '/api/notify')
    if (!ok) {
      console.error('Warning: app notify failed (POST /api/notify) — app may be stale or unreachable')
    }
    return
  }

  // No MCP port in current DB — check if app is running on the other DB
  const altPort = getAlternateMcpPort()
  if (altPort && await probePort(altPort)) {
    const dev = process.env.SLAYZONE_DEV === '1'
    const hint = dev ? 'without --dev' : 'with --dev'
    console.error(`Warning: SlayZone app is running ${hint}. Changes were saved but the app was not notified.`)
    console.error(`  Re-run ${dev ? 'without --dev' : 'with --dev'} to target the same database.`)
  }
}

export function getAssetsDir(): string {
  const dir = process.env.SLAYZONE_DB_DIR ?? defaultDir()
  return path.join(dir, 'assets')
}

export function openDb(): SlayDb {
  const dev = process.env.SLAYZONE_DEV === '1'
  const dbPath = getDbPath(dev)

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`)
    console.error('Make sure SlayZone has been launched at least once.')
    process.exit(1)
  }

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')

  return {
    query<T extends object>(sql: string, params: SqlParams = {}): T[] {
      return db.prepare(sql).all(params) as T[]
    },
    run(sql: string, params: SqlParams = {}) {
      db.prepare(sql).run(params)
    },
    close() {
      db.close()
    },
  }
}
