import type { McpConfigFileResult, McpServerConfig, McpTarget } from '../shared'
import { CURATED_MCP_SERVERS, type CuratedMcpServer } from '../shared/mcp-registry'

export const MCP_CONFIG_PATHS: Partial<Record<McpTarget, string>> = {
  claude: '.mcp.json',
  cursor: '.cursor/mcp.json',
  gemini: '.agents/settings.json',
  opencode: 'opencode.json',
  copilot: '.copilot/mcp-config.json'
}

export const MCP_PROVIDER_ORDER: McpTarget[] = ['claude', 'cursor', 'gemini', 'opencode', 'copilot']

export interface MergedServer {
  key: string
  name: string
  description?: string
  config: McpServerConfig | null
  providerConfigs: Partial<Record<McpTarget, McpServerConfig>>
  curated: CuratedMcpServer | null
  linkedToComputer: boolean
  providers: McpTarget[]
}

export function normalizeMcpConfig(config: McpServerConfig): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const envEntries = Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return {
    command: config.command,
    args: [...(config.args ?? [])],
    env: Object.fromEntries(envEntries)
  }
}

export function mcpConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(normalizeMcpConfig(a)) === JSON.stringify(normalizeMcpConfig(b))
}

export function mcpConfigToDisplay(config: McpServerConfig): string {
  return JSON.stringify(normalizeMcpConfig(config), null, 2)
}

export function buildMcpConfig(
  command: string,
  args: string,
  envRows: Array<{ key: string; value: string }>
): McpServerConfig {
  const config: McpServerConfig = {
    command: command.trim(),
    args: args.trim() ? args.trim().split(/\s+/) : []
  }
  const env = Object.fromEntries(
    envRows
      .map((row) => ({ key: row.key.trim(), value: row.value }))
      .filter((row) => row.key.length > 0)
      .map((row) => [row.key, row.value])
  )
  if (Object.keys(env).length > 0) config.env = env
  return config
}

export function parseComputerCustomServerIds(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const ids = parsed
      .map((entry) =>
        entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
      )
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    return new Set(ids)
  } catch {
    return new Set()
  }
}

export function buildMergedServers(
  configs: McpConfigFileResult[],
  computerCustomServerIds: Set<string>
): { merged: MergedServer[]; seen: Set<string> } {
  const merged: MergedServer[] = []
  const seen = new Set<string>()

  for (const cfg of configs) {
    for (const [key, config] of Object.entries(cfg.servers)) {
      if (!seen.has(key)) {
        const curated = CURATED_MCP_SERVERS.find((c) => c.id === key) ?? null
        merged.push({
          key,
          name: curated?.name ?? key,
          description: curated?.description,
          config,
          providerConfigs: { [cfg.provider]: config },
          curated,
          linkedToComputer: curated !== null || computerCustomServerIds.has(key),
          providers: [cfg.provider]
        })
        seen.add(key)
      } else {
        const existing = merged.find((m) => m.key === key)
        if (existing) {
          existing.providers.push(cfg.provider)
          existing.providerConfigs[cfg.provider] = config
        }
      }
    }
  }

  return { merged, seen }
}
