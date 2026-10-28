/**
 * The tRPC server runtime: the one `initTRPC` instance, the procedure builders and the
 * gate chain every procedure runs through. Domains build their routers from here;
 * only `@slayzone/api` composes them. See README.md.
 */
export {
  router,
  middleware,
  mergeRouters,
  publicProcedure,
  hubLocalProcedure,
  openProcedure
} from './trpc'
export type { PrincipalRole, TrpcContext, TrpcServerDeps, TrpcContextFactory } from './context'
export type { Scope } from './scope'
export { setAuthGate, getAuthGate } from './auth-gate'
export { ADMIN_ONLY, roleAllows, type AccessClass } from './access-class'
export {
  AdminOnlyError,
  isAdminOnlyError,
  auditAdminDenied,
  adminOnlyTrpcError,
  callerIsNotAdmin
} from './admin-gate'
export {
  setProcedurePolicy,
  procedurePolicy,
  type ProcedurePolicy,
  type OwnerCheckRequest,
  type OwnedResultFilter
} from './procedure-policy'
export { registerAppCode, type AppCodeOf } from './app-codes'
export { trpcTransformer, serializeOutput } from './trpc-transformer'
