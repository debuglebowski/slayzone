import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { getDataRoot } from '@slayzone/platform'

export interface ServerConfig {
  port: number
  host: string
  dataRoot: string
  mcpPort: number | null
  worktreeRoot: string
  maxUploadBytes: number
  noAgentCheck: boolean
  lockForce: boolean
}

export interface ParseConfigOpts {
  env?: NodeJS.ProcessEnv
  argv?: string[]
}

const DEFAULT_MAX_UPLOAD = 100 * 1024 * 1024

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

function parseBoolEnv(raw: string | undefined): boolean {
  if (raw == null || raw === '') return false
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

export function parseConfig(opts: ParseConfigOpts = {}): ServerConfig {
  const env = opts.env ?? process.env
  const argv = opts.argv ?? process.argv.slice(2)

  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'data-dir': { type: 'string' },
      'mcp-port': { type: 'string' },
      'no-agent-check': { type: 'boolean' },
      'lock-force': { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
    allowPositionals: false,
  })

  const argPort = parsePort(values.port as string | undefined)
  const envPort = parsePort(env.SLAYZONE_PORT)
  const port = argPort ?? envPort ?? 0

  const argHost = values.host as string | undefined
  const host = argHost || env.SLAYZONE_HOST || '127.0.0.1'

  const argDataDir = values['data-dir'] as string | undefined
  if (argDataDir) env.SLAYZONE_STORE_DIR = argDataDir
  const dataRoot = getDataRoot()

  const argMcp = parsePort(values['mcp-port'] as string | undefined)
  const envMcp = parsePort(env.SLAYZONE_MCP_PORT)
  const mcpRaw = argMcp ?? envMcp ?? null
  const mcpPort = mcpRaw == null || mcpRaw === port ? null : mcpRaw

  const worktreeRoot = env.SLAYZONE_WORKTREE_ROOT || join(dataRoot, 'worktrees')

  const uploadEnv = env.SLAYZONE_MAX_UPLOAD_BYTES
  const uploadParsed = uploadEnv ? Number(uploadEnv) : NaN
  const maxUploadBytes =
    Number.isFinite(uploadParsed) && uploadParsed > 0 ? uploadParsed : DEFAULT_MAX_UPLOAD

  const noAgentCheck = Boolean(values['no-agent-check']) || parseBoolEnv(env.SLAYZONE_NO_AGENT_CHECK)
  const lockForce = Boolean(values['lock-force']) || parseBoolEnv(env.SLAYZONE_LOCK_FORCE)

  return { port, host, dataRoot, mcpPort, worktreeRoot, maxUploadBytes, noAgentCheck, lockForce }
}

export function isHelpRequested(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

export function isVersionRequested(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes('--version') || argv.includes('-v')
}

export const HELP_TEXT = `slayzone-server — SlayZone backend daemon

Usage:
  slayzone-server [options]

Options:
  --port <n>             Port to bind (default: 0 = OS-assigned). Env: SLAYZONE_PORT
  --host <host>          Bind interface (default: 127.0.0.1). Env: SLAYZONE_HOST
  --data-dir <path>      Data root override. Env: SLAYZONE_STORE_DIR
  --mcp-port <n>         Run MCP on a separate port (default: same as --port). Env: SLAYZONE_MCP_PORT
  --no-agent-check       Skip agent CLI PATH probe at boot. Env: SLAYZONE_NO_AGENT_CHECK
  --lock-force           Bypass cross-host lockfile refusal. Env: SLAYZONE_LOCK_FORCE
  --version, -v          Print version and exit
  --help, -h             Show this help

Other env vars:
  SLAYZONE_WORKTREE_ROOT     Worktree base dir (default: <dataRoot>/worktrees)
  SLAYZONE_MAX_UPLOAD_BYTES  Per-file upload cap (default: 104857600 = 100MB)

⚠  TRUSTED NETWORK ONLY  ⚠  This build has no authentication.
   Bind to 127.0.0.1 unless you have a private network with no untrusted users.
`
