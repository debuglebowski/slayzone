/**
 * Runtime mock for jsdom tests. Re-exports the typecheck shim; values are
 * no-ops that keep the generated bindings loadable without crashing.
 *
 * State-transport tests drive behavior via @slayzone/state's mock transport
 * rather than the Mojo runtime itself — this file exists so imports resolve
 * under Vitest when a test pulls in a *-webui.ts file directly.
 */

export { mojo } from './bindings-shim'
