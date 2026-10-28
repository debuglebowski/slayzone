export { fetchGitHubRegistry, parseGitHubUrl } from './github-registry-fetcher'
export { normalizeSkillForPersistence } from './skill-normalize'
export {
  createAiConfigOps,
  createMarketplaceOps,
  initAiConfigOps,
  getAiConfigOps,
  getMarketplaceOps,
  type AiConfigOps,
  type MarketplaceOps
} from './ai-config-ops'

// `aiConfig.*` tRPC router (reads the ops registry above). Composed by `@slayzone/api`.
export { aiConfigRouter, type AiConfigRouter, type AiConfigMounts } from './ai-config-router'
