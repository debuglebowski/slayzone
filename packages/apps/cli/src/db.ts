import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import fs from 'fs'
import path from 'path'
import os from 'os'



function defaultDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'slayzone')
    case 'win32':
      return path.join(process.env.APPDATA ?? os.homedir(), 'slayzone')
    default:
      return path.join(os.homedir(), '.config', 'slayzone')
  }
}

function getDbPath(dev: boolean): string {
  // Full path override — used by e2e tests to share the running app's DB
  if (process.env.SLAYZONE_DB_PATH) return process.env.SLAYZONE_DB_PATH
  const dir = process.env.SLAYZONE_DB_DIR ?? defaultDir()
  const name = dev ? 'slayzone.dev.sqlite' : 'slayzone.sqlite'
  return path.join(dir, name)
}

type SqlParams = Record<string, string | number | bigint | null | Uint8Array>

export interface SlayDb {
  query<T extends object>(sql: string, params?: SqlParams): T[]
  run(sql: string, params?: SqlParams): void
  close(): void
}

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

export function notifyApp(): Promise<void> {
  const port = getMcpPort()
  if (!port) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/notify', method: 'POST' },
      (res) => {
        res.resume() // drain response so socket closes cleanly
        res.on('end', resolve)
      },
    )
    req.on('error', () => resolve()) // app not running — silent fail
    req.setTimeout(3000, () => { req.destroy(); resolve() })
    req.end()
  })
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
