export type DateRange = '7d' | '30d' | '90d' | 'all'

export interface ProviderOption {
  /** Terminal mode id (e.g. 'claude-code', 'codex') */
  id: string
  label: string
  hasUsageData: boolean
}

/** Maps terminal mode IDs to whether we can parse their local usage data */
export const PROVIDER_USAGE_SUPPORT: Record<string, { label: string; supported: boolean }> = {
  'claude-code': { label: 'Claude', supported: true },
  codex: { label: 'Codex', supported: true },
  opencode: { label: 'OpenCode', supported: true },
  'qwen-code': { label: 'Qwen', supported: true },
  gemini: { label: 'Gemini', supported: false },
  'cursor-agent': { label: 'Cursor', supported: false },
  copilot: { label: 'Copilot', supported: false },
}

/** Special value meaning show all providers */
export const ALL_PROVIDERS = '__all__' as const

export interface UsageRecord {
  id: string
  provider: string
  model: string
  sessionId: string | null
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cwd: string | null
  taskId: string | null
}

export interface ProviderSummary {
  provider: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  sessions: number
}

export interface ModelSummary {
  provider: string
  model: string
  totalTokens: number
}

export interface DailySummary {
  date: string
  provider: string
  totalTokens: number
}

export interface TaskSummary {
  provider: string
  taskId: string
  taskTitle: string
  totalTokens: number
}

export interface AnalyticsSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalSessions: number
  cacheHitPercent: number
  byProvider: ProviderSummary[]
  byModel: ModelSummary[]
  byDay: DailySummary[]
  byTask: TaskSummary[]
}
