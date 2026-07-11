/**
 * Runner configuration — env-first with an optional JSON config file
 * (`SLAYZONE_RUNNER_CONFIG=/path/to/config.json`). Env vars win over the
 * file so operators can override a checked-in config per host.
 *
 * @module runner/config
 */

import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { delimiter } from 'node:path'
import { z } from 'zod'

export const runnerConfigSchema = z.object({
  /** `ws://` or `wss://` hub fleet endpoint. */
  hubUrl: z.string().min(1),
  /** Required for first contact; later runs reconnect with stored credentials. */
  joinToken: z.string().min(1).optional(),
  /** Human-readable runner name shown on the hub. Defaults to the hostname. */
  name: z.string().min(1),
  /** Filesystem roots this runner may operate under (fs./git. commands). */
  allowedRoots: z.array(z.string().min(1)),
  /** Capability tags advertised at enrollment. */
  capabilities: z.array(z.string().min(1)),
  /** sha256 pin of the hub TLS leaf cert (lowercase hex; colons tolerated). */
  pinnedCertSha256: z.string().min(1).optional(),
  /** Override for the credential-store directory (tests, packaging). */
  credentialsDir: z.string().min(1).optional(),
  heartbeatIntervalMs: z.number().int().positive().optional()
})
export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export const ENV_VARS = {
  hubUrl: 'SLAYZONE_HUB_URL',
  joinToken: 'SLAYZONE_JOIN_TOKEN',
  name: 'SLAYZONE_RUNNER_NAME',
  allowedRoots: 'SLAYZONE_RUNNER_ALLOWED_ROOTS',
  capabilities: 'SLAYZONE_RUNNER_CAPABILITIES',
  pinnedCertSha256: 'SLAYZONE_HUB_CERT_SHA256',
  credentialsDir: 'SLAYZONE_RUNNER_CREDENTIALS_DIR',
  heartbeatIntervalMs: 'SLAYZONE_RUNNER_HEARTBEAT_MS',
  configFile: 'SLAYZONE_RUNNER_CONFIG'
} as const

export const DEFAULT_CAPABILITIES = ['pty'] as const

type Env = Record<string, string | undefined>

function splitList(value: string | undefined, separator: string): string[] | undefined {
  if (value === undefined) return undefined
  const parts = value
    .split(separator)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  return parts
}

function readConfigFile(path: string): Partial<RunnerConfig> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read runner config file '${path}': ${String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`runner config file '${path}' is not valid JSON: ${String(err)}`)
  }
  const result = runnerConfigSchema.partial().safeParse(parsed)
  if (!result.success) {
    throw new Error(`runner config file '${path}' is invalid: ${result.error.message}`)
  }
  return result.data
}

/**
 * Assemble the effective config: defaults ← config file ← environment.
 * Throws with a readable message when required fields are missing.
 */
export function loadRunnerConfig(env: Env = process.env): RunnerConfig {
  const fromFile = env[ENV_VARS.configFile] ? readConfigFile(env[ENV_VARS.configFile] as string) : {}

  const heartbeatRaw = env[ENV_VARS.heartbeatIntervalMs]
  const heartbeatFromEnv = heartbeatRaw === undefined ? undefined : Number(heartbeatRaw)
  if (heartbeatFromEnv !== undefined && !Number.isInteger(heartbeatFromEnv)) {
    throw new Error(`${ENV_VARS.heartbeatIntervalMs} must be an integer, got '${heartbeatRaw}'`)
  }

  const merged = {
    name: hostname(),
    allowedRoots: [] as string[],
    capabilities: [...DEFAULT_CAPABILITIES],
    ...fromFile,
    ...(env[ENV_VARS.hubUrl] !== undefined ? { hubUrl: env[ENV_VARS.hubUrl] } : {}),
    ...(env[ENV_VARS.joinToken] !== undefined ? { joinToken: env[ENV_VARS.joinToken] } : {}),
    ...(env[ENV_VARS.name] !== undefined ? { name: env[ENV_VARS.name] } : {}),
    ...(splitList(env[ENV_VARS.allowedRoots], delimiter) !== undefined
      ? { allowedRoots: splitList(env[ENV_VARS.allowedRoots], delimiter) }
      : {}),
    ...(splitList(env[ENV_VARS.capabilities], ',') !== undefined
      ? { capabilities: splitList(env[ENV_VARS.capabilities], ',') }
      : {}),
    ...(env[ENV_VARS.pinnedCertSha256] !== undefined
      ? { pinnedCertSha256: env[ENV_VARS.pinnedCertSha256] }
      : {}),
    ...(env[ENV_VARS.credentialsDir] !== undefined
      ? { credentialsDir: env[ENV_VARS.credentialsDir] }
      : {}),
    ...(heartbeatFromEnv !== undefined ? { heartbeatIntervalMs: heartbeatFromEnv } : {})
  }

  const result = runnerConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(
      `invalid runner configuration (${issues}). Set ${ENV_VARS.hubUrl} (and ${ENV_VARS.joinToken} for first contact) or provide ${ENV_VARS.configFile}.`
    )
  }
  return result.data
}
