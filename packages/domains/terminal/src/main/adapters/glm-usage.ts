import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { ProviderUsage, UsageWindow } from '@slayzone/terminal/shared'

const TIMEOUT_MS = 10_000

interface GlmApiResponse {
  code: number
  msg: string
  success: boolean
  data?: {
    limits: Array<{
      type: 'TIME_LIMIT' | 'TOKENS_LIMIT'
      unit: number
      number: number
      usage?: number
      currentValue?: number
      remaining?: number
      percentage: number
      nextResetTime: number
      usageDetails?: Array<{ modelCode: string; usage: number }>
    }>
    level: string
  }
}

interface GlmSettings {
  env?: {
    ANTHROPIC_AUTH_TOKEN?: string
    GLM_API_KEY?: string
    [key: string]: string | undefined
  }
  ANTHROPIC_AUTH_TOKEN?: string
  GLM_API_KEY?: string
  [key: string]: unknown
}

async function getGlmApiKey(): Promise<string | null> {
  try {
    const settingsPath = join(homedir(), '.ccs', 'glm.settings.json')
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as GlmSettings
    // Check nested env object first (CCS format), then top-level
    return (
      settings.env?.ANTHROPIC_AUTH_TOKEN ||
      settings.env?.GLM_API_KEY ||
      settings.ANTHROPIC_AUTH_TOKEN ||
      settings.GLM_API_KEY ||
      null
    )
  } catch {
    return null
  }
}

function mapWindow(limit: NonNullable<GlmApiResponse['data']>['limits'][0]): UsageWindow | null {
  if (!limit.nextResetTime) return null
  return {
    utilization: limit.percentage,
    resetsAt: new Date(limit.nextResetTime).toISOString()
  }
}

async function fetchGlmUsage(): Promise<ProviderUsage> {
  const now = Date.now()
  const apiKey = await getGlmApiKey()

  if (!apiKey) {
    return {
      provider: 'glm',
      label: 'GLM (Z.AI)',
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      error: 'No API key found in ~/.ccs/glm.settings.json',
      fetchedAt: now
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      return {
        provider: 'glm',
        label: 'GLM (Z.AI)',
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        error: `HTTP ${res.status}`,
        fetchedAt: now
      }
    }

    const data = (await res.json()) as GlmApiResponse

    if (!data.success || !data.data?.limits) {
      return {
        provider: 'glm',
        label: 'GLM (Z.AI)',
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        error: data.msg || 'Invalid response format',
        fetchedAt: now
      }
    }

    // Find TIME_LIMIT (30-day window) and TOKENS_LIMIT (5-hour quota)
    const timeLimit = data.data.limits.find((l) => l.type === 'TIME_LIMIT')
    const tokensLimit = data.data.limits.find((l) => l.type === 'TOKENS_LIMIT')

    // Build usage windows
    // 5h: uses TOKENS_LIMIT percentage with TOKENS_LIMIT reset time
    // 30d: uses TIME_LIMIT percentage with TIME_LIMIT reset time
    const fiveHourWindow = tokensLimit && timeLimit
      ? {
          utilization: tokensLimit.percentage,
          resetsAt: new Date(tokensLimit.nextResetTime).toISOString()
        }
      : tokensLimit
        ? mapWindow(tokensLimit)
        : timeLimit
          ? mapWindow(timeLimit)
          : null

    const sevenDayWindow = timeLimit && tokensLimit
      ? {
          utilization: timeLimit.percentage,
          resetsAt: new Date(timeLimit.nextResetTime).toISOString()
        }
      : timeLimit
        ? mapWindow(timeLimit)
        : tokensLimit
          ? mapWindow(tokensLimit)
          : null

    return {
      provider: 'glm',
      label: 'GLM (Z.AI)',
      fiveHour: fiveHourWindow,
      sevenDay: sevenDayWindow,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      error: null,
      fetchedAt: now
    }
  } catch (err) {
    clearTimeout(timeoutId)
    const errorMsg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Request timeout'
        : err instanceof Error
          ? err.message
          : 'Unknown error'

    return {
      provider: 'glm',
      label: 'GLM (Z.AI)',
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      error: errorMsg,
      fetchedAt: now
    }
  }
}

export { fetchGlmUsage }
