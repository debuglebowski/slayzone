import type { McpServerConfig, McpTarget } from '../../shared'
import { getConfigurableMcpTargets } from '../../shared/provider-registry'
import type { CustomMcpServer } from './types'

export async function loadCustomServers(): Promise<CustomMcpServer[]> {
  const raw = await window.api.settings.get('mcp_custom_servers')
  return raw ? (JSON.parse(raw) as CustomMcpServer[]) : []
}

export async function saveCustomServers(servers: CustomMcpServer[]): Promise<void> {
  await window.api.settings.set('mcp_custom_servers', JSON.stringify(servers))
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
