import type { useTRPCClient } from '@slayzone/transport/client'
import type { McpServerConfig, McpTarget } from '../../shared'
import { getConfigurableMcpTargets } from '../../shared/provider-registry'
import type { CustomMcpServer } from './types'

/** Vanilla tRPC client shape (`client.<router>.<proc>.query/mutate(input)`). */
type TrpcClient = ReturnType<typeof useTRPCClient>

export async function loadCustomServers(trpcClient: TrpcClient): Promise<CustomMcpServer[]> {
  const raw = await trpcClient.settings.get.query({ key: 'mcp_custom_servers' })
  return raw ? (JSON.parse(raw) as CustomMcpServer[]) : []
}

export async function saveCustomServers(
  trpcClient: TrpcClient,
  servers: CustomMcpServer[]
): Promise<void> {
  await trpcClient.settings.set.mutate({
    key: 'mcp_custom_servers',
    value: JSON.stringify(servers)
  })
}

export function matchesSearch(query: string, ...fields: (string | undefined)[]) {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((f) => f?.toLowerCase().includes(q))
}

export function buildConfig(
  command: string,
  args: string,
  envVars: Array<{ key: string; value: string }>
): McpServerConfig {
  const config: McpServerConfig = {
    command: command.trim(),
    args: args.trim() ? args.trim().split(/\s+/) : []
  }
  const env = Object.fromEntries(
    envVars.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value])
  )
  if (Object.keys(env).length > 0) config.env = env
  return config
}

export const PROVIDER_LABELS: Partial<Record<McpTarget, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'Copilot'
}

export const ALL_PROVIDERS: McpTarget[] = getConfigurableMcpTargets({ writableOnly: true })
