/**
 * The automation engine on the tRPC context. `@slayzone/trpc-server` cannot name an
 * automations type (it sits below the domains), so the context field is added here by
 * module augmentation of its `TrpcServerDeps` interface. When the automations router
 * moves into its domain, this file moves with it.
 *
 * @module api/automation-engine-context
 */
import type { AutomationRun } from '@slayzone/automations/shared'

/** Structural slice of AutomationEngine the automations router needs. Keeps
 *  transport decoupled from the engine's electron-laden value module — only the
 *  pure `AutomationRun` type (from /shared) is imported. */
export interface AutomationEngineLike {
  executeManual(id: string): Promise<AutomationRun>
}

declare module '@slayzone/trpc-server' {
  interface TrpcServerDeps {
    /** Optional — only the Electron-main host wires an engine. */
    automationEngine?: AutomationEngineLike
  }
}
