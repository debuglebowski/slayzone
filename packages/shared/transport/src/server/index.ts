export { appRouter, type AppRouter } from './router'
export { router, publicProcedure, openProcedure, middleware, mergeRouters } from './trpc'
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
export {
  setAgentLifecycleEvents,
  getAgentLifecycleEvents,
  type AgentLifecycleEventMap
} from './app-deps'
export { setAuthEvents, getAuthEvents, type AuthEventMap } from './app-deps'
export {
  requestGithubSignInStart,
  parseAuthCallbackUrl,
  type GithubSignInStart
} from './auth-github'
export { setAppDeps, getAppDeps, type AppDeps, type FloatingAgentState } from './app-deps'
export { setProcessesDeps, getProcessesDeps, type ProcessesDeps } from './app-deps'
export {
  setRunnersDeps,
  getRunnersDeps,
  getRunnersDepsOrNull,
  type RunnersDeps,
  type RunnerGateway
} from './app-deps'
export {
  setHubDescribeDeps,
  getHubDescribeDepsOrNull,
  type HubDescribeDeps
} from './app-deps'
export { setAuthGate, getAuthGate } from './app-deps'
export {
  setPowerResumeEvents,
  getPowerResumeEvents,
  type PowerResumeEventMap
} from './app-deps'
export { setTaskTriggerBus, getTaskTriggerBus, type TaskTriggerBus } from './app-deps'

// Capability bridge — host↔side-car seam (slice 9). The Electron host serves
// `capabilityBridgeRouter`; the side-car forwards its Electron-only `AppDeps`
// calls over it and re-emits host events from the `events` stream.
export {
  capabilityBridgeRouter,
  type CapabilityBridgeRouter,
  type CapabilityEventFrame,
  type CapabilityEventChannel
} from './capability-bridge'

// MCP server + REST API (moved from the Electron main in slice 6 so the
// standalone @slayzone/hub can host them too — capability-slot injected).
// Callers mux the app onto their own listener (hub server + host bridge server).
export {
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
