import type { CliProvider, McpTarget, McpServerConfig, ProviderPathMapping } from './types'

export const PROVIDER_PATHS: Record<CliProvider, ProviderPathMapping> = {
  claude: {
    rootInstructions: 'CLAUDE.md',
    skillsDir: '.claude/skills',
  },
  codex: {
    rootInstructions: 'AGENTS.md',
    skillsDir: '.agents/skills',
  },
  cursor: {
    rootInstructions: 'AGENTS.md',
    skillsDir: '.cursor/skills',
  },
  gemini: {
    rootInstructions: 'AGENTS.md',
    skillsDir: '.agents/skills',
  },
  opencode: {
    rootInstructions: 'OPENCODE.md',
    skillsDir: 'skill',
  },
  qwen: {
    rootInstructions: 'QWEN.md',
    skillsDir: '.qwen/skills',
  },
  copilot: {
    rootInstructions: 'AGENTS.md',
    skillsDir: '.copilot/skills',
  },
}

export interface GlobalProviderPaths {
  label: string
  baseDir: string        // relative to $HOME
  instructions?: string  // relative to baseDir
  skillsDir?: string     // relative to baseDir
  mcpConfig?: string     // relative to baseDir
  hint?: string          // tooltip explaining what reads from this dir
}

export const GLOBAL_PROVIDER_PATHS: Record<string, GlobalProviderPaths> = {
  claude:   { label: 'Claude Code', baseDir: '.claude', instructions: 'CLAUDE.md', skillsDir: 'skills', mcpConfig: '.mcp.json', hint: 'Used by Claude Code CLI' },
  codex:    { label: 'Codex',       baseDir: '.codex',  instructions: 'AGENTS.md', hint: 'Used by Codex CLI' },
  cursor:   { label: 'Cursor',      baseDir: '.cursor', mcpConfig: 'mcp.json', hint: 'Used by Cursor Agent' },
  agents:   { label: 'Agents (shared)', baseDir: '.agents', skillsDir: 'skills', mcpConfig: 'settings.json', hint: 'Shared skills directory read by Codex and Gemini' },
  gemini:   { label: 'Gemini',      baseDir: '.gemini', instructions: 'GEMINI.md', hint: 'Used by Gemini CLI' },
  opencode: { label: 'OpenCode',    baseDir: '.config/opencode', instructions: 'AGENTS.md', skillsDir: 'skills', mcpConfig: 'opencode.json', hint: 'Used by OpenCode CLI' },
  qwen:     { label: 'Qwen Code',   baseDir: '.qwen',   instructions: 'QWEN.md',   skillsDir: 'skills', hint: 'Used by Qwen Code CLI' },
  copilot:  { label: 'Copilot',     baseDir: '.copilot', instructions: 'AGENTS.md', skillsDir: 'skills', mcpConfig: 'mcp-config.json', hint: 'Used by GitHub Copilot CLI' },
}

export const PROVIDER_LABELS: Record<CliProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor Agent',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  copilot: 'Copilot',
}

export interface ProviderCapabilities {
  configurable: boolean
  mcpReadable: boolean
  mcpWritable: boolean
}

export const PROVIDER_CAPABILITIES: Record<CliProvider, ProviderCapabilities> = {
  claude: { configurable: true, mcpReadable: true, mcpWritable: true },
  codex: { configurable: true, mcpReadable: false, mcpWritable: false },
  cursor: { configurable: true, mcpReadable: true, mcpWritable: true },
  gemini: { configurable: true, mcpReadable: true, mcpWritable: false },
  opencode: { configurable: true, mcpReadable: true, mcpWritable: false },
  qwen: { configurable: true, mcpReadable: true, mcpWritable: true },
  copilot: { configurable: true, mcpReadable: true, mcpWritable: false },
}

export interface McpTargetCapabilities {
  configurable: boolean
  writable: boolean
}

export const MCP_TARGET_CAPABILITIES: Record<McpTarget, McpTargetCapabilities> = {
  claude: { configurable: PROVIDER_CAPABILITIES.claude.mcpReadable, writable: PROVIDER_CAPABILITIES.claude.mcpWritable },
  codex: { configurable: PROVIDER_CAPABILITIES.codex.mcpReadable, writable: PROVIDER_CAPABILITIES.codex.mcpWritable },
  cursor: { configurable: PROVIDER_CAPABILITIES.cursor.mcpReadable, writable: PROVIDER_CAPABILITIES.cursor.mcpWritable },
  gemini: { configurable: PROVIDER_CAPABILITIES.gemini.mcpReadable, writable: PROVIDER_CAPABILITIES.gemini.mcpWritable },
  opencode: { configurable: PROVIDER_CAPABILITIES.opencode.mcpReadable, writable: PROVIDER_CAPABILITIES.opencode.mcpWritable },
  qwen: { configurable: PROVIDER_CAPABILITIES.qwen.mcpReadable, writable: PROVIDER_CAPABILITIES.qwen.mcpWritable },
  copilot: { configurable: PROVIDER_CAPABILITIES.copilot.mcpReadable, writable: PROVIDER_CAPABILITIES.copilot.mcpWritable },
}

const MCP_TARGET_ORDER: McpTarget[] = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'qwen', 'copilot']

export function isConfigurableCliProvider(provider: string): provider is CliProvider {
  if (!Object.hasOwn(PROVIDER_CAPABILITIES, provider)) return false
  return PROVIDER_CAPABILITIES[provider as CliProvider].configurable
}

export function filterConfigurableCliProviders(providers: readonly string[]): CliProvider[] {
  const filtered: CliProvider[] = []
  for (const provider of providers) {
    if (!isConfigurableCliProvider(provider)) continue
    if (!filtered.includes(provider)) filtered.push(provider)
  }
  return filtered
}

export function isConfigurableMcpTarget(target: string): target is McpTarget {
  if (!Object.hasOwn(MCP_TARGET_CAPABILITIES, target)) return false
  return MCP_TARGET_CAPABILITIES[target as McpTarget].configurable
}

export function getConfigurableMcpTargets(opts?: { writableOnly?: boolean }): McpTarget[] {
  const writableOnly = opts?.writableOnly ?? false
  return MCP_TARGET_ORDER.filter((target) => {
    const cap = MCP_TARGET_CAPABILITIES[target]
    if (!cap.configurable) return false
    if (writableOnly && !cap.writable) return false
    return true
  })
}

// MCP config spec — shared adapter interface for reading/writing MCP config files
export interface McpConfigSpec {
  relativePath: string
  writable: boolean
  read(content: string): Record<string, McpServerConfig>
  write(existing: string | null, servers: Record<string, McpServerConfig>): string
}

function jsonMcpSpec(relativePath: string, serversKey: string, opts?: { writable?: boolean }): McpConfigSpec {
  return {
    relativePath,
    writable: opts?.writable ?? true,
    read(content) {
      try {
        const parsed = JSON.parse(content)
        return (parsed?.[serversKey] as Record<string, McpServerConfig>) ?? {}
      } catch { return {} }
    },
    write(existing, servers) {
      let doc: Record<string, unknown> = {}
      if (existing) { try { doc = JSON.parse(existing) } catch { /* ignore */ } }
      doc[serversKey] = servers
      return JSON.stringify(doc, null, 2) + '\n'
    },
  }
}

const opencodeMcpSpec: McpConfigSpec = {
  relativePath: 'opencode.json',
  writable: false,
  read(content) {
    try {
      const parsed = JSON.parse(content)
      const raw = parsed?.mcp as Record<string, McpServerConfig & { type?: string }> | undefined
      if (!raw) return {}
      const out: Record<string, McpServerConfig> = {}
      for (const [k, v] of Object.entries(raw)) {
        out[k] = { command: v.command, args: v.args ?? [], env: v.env }
      }
      return out
    } catch { return {} }
  },
  write(existing, servers) {
    let doc: Record<string, unknown> = {}
    if (existing) { try { doc = JSON.parse(existing) } catch { /* ignore */ } }
    const mcp: Record<string, McpServerConfig & { type: string }> = {}
    for (const [k, v] of Object.entries(servers)) {
      mcp[k] = { type: 'local', command: v.command, args: v.args, env: v.env }
    }
    doc.mcp = mcp
    return JSON.stringify(doc, null, 2) + '\n'
  },
}

// Project-level MCP config specs (relative to project root)
export const PROJECT_MCP_SPECS: Partial<Record<McpTarget, McpConfigSpec>> = {
  claude:   jsonMcpSpec('.mcp.json', 'mcpServers'),
  cursor:   jsonMcpSpec('.cursor/mcp.json', 'mcpServers'),
  gemini:   jsonMcpSpec('.agents/settings.json', 'mcpServers', { writable: false }),
  opencode: opencodeMcpSpec,
  copilot:  jsonMcpSpec('.copilot/mcp-config.json', 'mcpServers', { writable: false }),
}

// Global (computer-level) MCP config specs (relative to $HOME)
export const GLOBAL_MCP_SPECS: Partial<Record<McpTarget, McpConfigSpec>> = {
  claude:   jsonMcpSpec('.claude/.mcp.json', 'mcpServers'),
  cursor:   jsonMcpSpec('.cursor/mcp.json', 'mcpServers'),
  gemini:   jsonMcpSpec('.agents/settings.json', 'mcpServers', { writable: false }),
  opencode: { ...opencodeMcpSpec, relativePath: '.config/opencode/opencode.json' },
  copilot:  jsonMcpSpec('.copilot/mcp-config.json', 'mcpServers', { writable: false }),
}
