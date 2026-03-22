import type { CliProvider, McpTarget, ProviderPathMapping } from './types'

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
    rootInstructions: 'GEMINI.md',
    skillsDir: '.gemini/skills',
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
}

export const GLOBAL_PROVIDER_PATHS: Record<string, GlobalProviderPaths> = {
  claude:   { label: 'Claude Code', baseDir: '.claude', instructions: 'CLAUDE.md' },
  codex:    { label: 'Codex',       baseDir: '.codex',  instructions: 'AGENTS.md' },
  gemini:   { label: 'Gemini',      baseDir: '.gemini', instructions: 'GEMINI.md', skillsDir: 'skills' },
  opencode: { label: 'OpenCode',    baseDir: '.config/opencode', instructions: 'AGENTS.md', skillsDir: 'skills' },
  qwen:     { label: 'Qwen Code',   baseDir: '.qwen',   instructions: 'QWEN.md',   skillsDir: 'skills' },
  copilot: { label: 'Copilot',    baseDir: '.copilot', instructions: 'AGENTS.md', skillsDir: 'skills' },
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
