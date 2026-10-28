// `app.floatingAgent` tRPC router + the host seam it reads. Composed by
// `@slayzone/api` under `app`, which also wires the seam from its `AppDeps` registry.
export {
  appFloatingAgentRouter,
  type AppFloatingAgentRouter,
  type AppFloatingAgentMounts
} from './router'
export {
  setAgentPanelsRouterDeps,
  type AgentPanelsRouterDeps,
  type FloatingAgentHost,
  type FloatingAgentState
} from './router-deps'
