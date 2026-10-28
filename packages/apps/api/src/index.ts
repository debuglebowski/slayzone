export { appRouter, type AppRouter } from './router'
export {
  router,
  publicProcedure,
  openProcedure,
  middleware,
  mergeRouters,
  setAuthGate,
  getAuthGate,
  type PrincipalRole,
  type TrpcContext,
  type TrpcServerDeps,
  type TrpcContextFactory
} from '@slayzone/trpc-server'
export type { AutomationEngineLike } from './automation-engine-context'
export {
  SCOPE_POLICY,
  requiredScope,
  isPathAllowed,
  type Scope,
  type PrincipalScope,
  type ProcedureScope
} from '@slayzone/transport/scopes'
export {
  ADMIN_ONLY,
  CONDITIONAL_ADMIN,
  MCP_ADMIN_POLICY,
  REST_ADMIN_POLICY,
  TRPC_ADMIN_POLICY,
  roleAllows,
  type AccessClass
} from './admin-policy'
export { startTrpcServer, stopTrpcServer, type StartTrpcServerOpts } from './ws-server'
export { setChatDeps, getChatDeps, type ChatDeps } from './app-deps'
export {
  setWorkspaceDeps,
  getWorkspaceDeps,
  type WorkspaceDeps,
  type WorkspaceComputerTarget
} from './app-deps'
export { setPtyDeps, getPtyDeps, type PtyDeps } from './app-deps'
export { setIntegrationOps, getIntegrationOps } from './app-deps'
export { setTaskDeps, getTaskOps } from './app-deps'
export { setNotifyEvents, getNotifyEvents, type NotifyEventMap } from './app-deps'
export {
  setAutomationsEvents,
  getAutomationsEvents,
  type AutomationsEventMap
} from './app-deps'
export { setMenuEvents, getMenuEvents, type MenuEventMap } from './app-deps'
export { setAuthEvents, getAuthEvents, type AuthEventMap } from './app-deps'
export {
  requestGithubSignInStart,
  hubGithubSignInConvexUrl,
  parseAuthCallbackUrl,
  type GithubSignInStart
} from './auth-github'
export {
  setAppDeps,
  getAppDeps,
  setBackupOps,
  getBackupOps,
  type AppDeps,
  type BackupOps,
  type FloatingAgentState
} from './app-deps'
export {
  setComputersDeps,
  getComputersDeps,
  getComputersDepsOrNull,
  type ComputersDeps,
  type ComputerGateway
} from './app-deps'
export {
  setHubDescribeDeps,
  getHubDescribeDepsOrNull,
  type HubDescribeDeps
} from './app-deps'
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
export {
  registerRestApi,
  processAgentHook,
  evictAgentTree,
  resetAgentHookStateForTest
} from './http/rest-api'
export { bindRestPrincipal, restPrincipalOf } from './http/rest-api/principal'
export type {
  RestApiDeps,
  RestPrincipal,
  TerminalStateBridge,
  TaskOpsBus,
  PtyAccess,
  ProcessesAccess,
  BrowserAccess,
  ArtifactExportAccess
} from './http/rest-api/types'
// Owner checks (T-17): the ONE access function, the tRPC classification and its gate.
export {
  canAccess,
  createAccessScope,
  invalidateAccessCache,
  resolveOwnership,
  resource,
  RESOURCE_KINDS,
  type AccessRequest,
  type AccessScope,
  type OwnedResource,
  type Ownership,
  type ResourceKind
} from './access'
export {
  TRPC_OWNER_POLICY,
  isCustomRef,
  type OwnerMark,
  type OwnerRule,
  type Ref as OwnerRef
} from './owner-policy'
export { accessRequestOf, checkOwnership, isNotOwnedError } from './owner-gate'
// Owner checks on REST, MCP and agent hooks (T-18): the classification and the hook rule.
export {
  REST_OWNER_POLICY,
  MCP_OWNER_POLICY,
  type HttpIdRef,
  type HttpOwnerRule
} from './http-owner-policy'
export type { HookReporter } from './http/rest-api/agent-hook-owner'
// Computers (T-19): use = the owner (canAccess `computer`), manage = the owner or an
// admin, serve = the work's owner.
export {
  computerOwnerOf,
  computerServes,
  filterManagedComputers,
  mayManageComputer,
  mayUseComputer,
  type ComputerManagerRequest
} from './computer-access'
