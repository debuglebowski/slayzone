import type { AgentProbeResult } from './agents-check'

export interface BannerInput {
  version: string
  host: string
  port: number
  mcpPort: number | null
  dataRoot: string
  lockPath: string | null
  pid: number
  agents: AgentProbeResult[] | null
}

export function formatBanner(b: BannerInput): string {
  const baseUrl = `http://${b.host}:${b.port}`
  const wsUrl = `ws://${b.host}:${b.port}/trpc`
  const mcpUrl =
    b.mcpPort == null || b.mcpPort === b.port
      ? `${baseUrl}/mcp`
      : `http://${b.host}:${b.mcpPort}/mcp`

  const lines: string[] = []
  lines.push(`SlayZone Server v${b.version}`)
  lines.push(`Listening: ${baseUrl}  (${wsUrl})`)
  lines.push(`MCP:       ${mcpUrl}`)
  lines.push(`Data:      ${b.dataRoot}`)
  if (b.lockPath) lines.push(`Lock:      ${b.lockPath} (pid ${b.pid})`)

  if (b.agents) {
    lines.push('')
    lines.push('Agent CLIs:')
    for (const a of b.agents) {
      const mark = a.found ? '✓' : '✗'
      const detail = a.found ? a.path : 'not in PATH'
      lines.push(`  ${mark} ${a.name.padEnd(10)} ${detail ?? ''}`.trimEnd())
    }
  }

  lines.push('')
  lines.push('⚠  TRUSTED NETWORK ONLY  ⚠')
  lines.push('   No authentication in this build. Default bind is loopback (127.0.0.1).')
  lines.push('   Setting SLAYZONE_HOST=0.0.0.0 exposes the server to your network —')
  lines.push('   anyone reaching this port gets shell access via PTY. Run only on')
  lines.push('   trusted LAN/VPN. Auth + reverse proxy is your responsibility.')

  return lines.join('\n')
}
