export { appRouter, type AppRouter } from './router'
export { router, publicProcedure, middleware, mergeRouters } from './trpc'
export type { TrpcContext, TrpcServerDeps, TrpcContextFactory } from './context'
export { startTrpcServer, stopTrpcServer, type StartTrpcServerOpts } from './ws-server'
export { setChatDeps, getChatDeps, type ChatDeps } from './app-deps'
export { setPtyDeps, getPtyDeps, type PtyDeps } from './app-deps'
export { setIntegrationOps, getIntegrationOps } from './app-deps'
export { setTaskDeps, getTaskOps } from './app-deps'
export { setNotifyEvents, getNotifyEvents, type NotifyEventMap } from './app-deps'
export {
  setAutomationsEvents,
  getAutomationsEvents,
  type AutomationsEventMap
} from './app-deps'
export {
  setTelemetryEvents,
  getTelemetryEvents,
  type TelemetryEventMap
} from './app-deps'
export { setMenuEvents, getMenuEvents, type MenuEventMap } from './app-deps'
export { setAppDeps, getAppDeps, type AppDeps, type FloatingAgentState } from './app-deps'
export { setProcessesDeps, getProcessesDeps, type ProcessesDeps } from './app-deps'

// MCP server + REST API (moved from the Electron main in slice 6 so the
// standalone @slayzone/server can host them too — capability-slot injected).
export {
  startMcpServer,
  stopMcpServer,
  createMcpRestApp,
  type McpRestAppHandle
} from './http/mcp-server'
export { registerRestApi } from './http/rest-api'
export type {
  RestApiDeps,
  TerminalStateBridge,
  TaskOpsBus,
  PtyAccess,
  ProcessesAccess,
  BrowserAccess,
  BrowserWc,
  ArtifactExportAccess
} from './http/rest-api/types'
