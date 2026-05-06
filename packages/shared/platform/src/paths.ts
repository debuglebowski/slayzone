import { getStateDir } from './dirs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

let warnedHost: string | null = null

/**
 * Returns the root directory for SlayZone state (DB, artifacts, project icons,
 * backups, Electron internal data). Honors SLAYZONE_STORE_DIR override; otherwise
 * falls back to the platform default from getStateDir().
 */
export function getDataRoot(): string {
  const override = process.env.SLAYZONE_STORE_DIR
  if (override) return override
  return getStateDir()
}

/**
 * Returns the MCP server port from SLAYZONE_MCP_PORT, or undefined if unset/invalid.
 * Callers should fall back to a stored or auto-assigned port when undefined.
 */
export function getMcpPort(): number | undefined {
  const raw = process.env.SLAYZONE_MCP_PORT
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * Returns the tRPC server port from SLAYZONE_PORT, or undefined if unset/invalid.
 * Callers should fall back to a stored or auto-assigned port when undefined.
 */
export function getTrpcPort(): number | undefined {
  const raw = process.env.SLAYZONE_PORT
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * Returns the host the local server should bind to. Defaults to 127.0.0.1.
 * Warns once on stderr when bound to a non-loopback address.
 */
export function getServerHost(): string {
  const host = process.env.SLAYZONE_HOST || '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host) && warnedHost !== host) {
    warnedHost = host
    console.warn(
      `[slayzone] SLAYZONE_HOST=${host} binds the local server to a non-loopback address. ` +
        `Anyone on the network can reach it. Use 127.0.0.1 unless you have a reason.`,
    )
  }
  return host
}
