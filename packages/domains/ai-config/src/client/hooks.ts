// Hooks-only entry (`@slayzone/ai-config/client/hooks`): lets boot-path code use
// these without pulling the ContextManager/MCP settings UI behind the
// `./client` barrel into the startup module graph.
export { useStaleSkillCount } from './useStaleSkillCount'
export { useStaleSkillCounts } from './useStaleSkillCounts'
