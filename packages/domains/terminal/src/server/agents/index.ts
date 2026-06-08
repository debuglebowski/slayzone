/**
 * Pure adapter parsers — re-exported on a dedicated subpath so renderer/test
 * code can call `parseLine` without dragging electron-only main barrel deps.
 */
export { claudeCodeAdapter } from './claude-code-adapter'
export { claudeChatBackend } from './claude-session-driver'
export type {
  AgentAdapter,
  AgentBackend,
  AgentSpawnOpts,
  ChatDriverContext,
  ChatSessionDriver,
  PermissionDecision,
  SpawnArgs
} from './types'
