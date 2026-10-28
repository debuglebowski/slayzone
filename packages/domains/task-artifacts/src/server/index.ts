export * from './artifact-store'
export * from './blob-store'
export * from './db'
export * from './diff'
export * from './errors'
export * from './integrity'
export * from './mutations'
export * from './prune'
export * from './resolve'
export * from './search'
export * from './seed'
export * from './telemetry'

// `artifacts.*` tRPC router + the host seam it reads. Composed by `@slayzone/api`,
// which wires the seam (`api/src/domain-router-deps.ts`).
export { artifactsRouter, type ArtifactsRouter, type ArtifactsMounts } from './artifacts-router'
export {
  setArtifactsRouterDeps,
  getArtifactsRouterDeps,
  type ArtifactsRouterDeps
} from './artifacts-router-deps'
