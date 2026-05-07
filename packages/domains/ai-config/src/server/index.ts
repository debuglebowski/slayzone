import type { Database } from 'better-sqlite3'
import { createAiConfigOps } from './handlers-store'
import { createMarketplaceOps } from './marketplace-store'

export { fetchGitHubRegistry, parseGitHubUrl } from './github-registry-fetcher'
export { normalizeSkillForPersistence } from './skill-normalize'
export { createAiConfigOps, createMarketplaceOps }

export type AiConfigOps = ReturnType<typeof createAiConfigOps>
export type MarketplaceOps = ReturnType<typeof createMarketplaceOps>

let aiConfigOps: AiConfigOps | null = null
let marketplaceOps: MarketplaceOps | null = null

export function initAiConfigOps(db: Database): { ai: AiConfigOps; market: MarketplaceOps } {
  aiConfigOps = createAiConfigOps(db)
  marketplaceOps = createMarketplaceOps(db)
  return { ai: aiConfigOps, market: marketplaceOps }
}

export function getAiConfigOps(): AiConfigOps {
  if (!aiConfigOps) throw new Error('aiConfigOps not initialized — call initAiConfigOps(db) first')
  return aiConfigOps
}

export function getMarketplaceOps(): MarketplaceOps {
  if (!marketplaceOps) throw new Error('marketplaceOps not initialized — call initAiConfigOps(db) first')
  return marketplaceOps
}
