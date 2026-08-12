/**
 * Shared handler wiring types. Each exec handler module closes over a
 * {@link HandlerContext} (the hub dialer for streaming notifications, the
 * runner config for the allowedRoots guard, and a logger) and exposes a table
 * of `method → handler` entries that `main.ts` merges into the single hub
 * request dispatcher.
 *
 * @module runner/handlers/types
 */

import type { RunnerConfig } from '../config'

/** Minimal slice of the HubDialer the handlers depend on (fire-and-forget). */
export interface RunnerDialer {
  /** Fire-and-forget notification to the hub; returns false when offline. */
  notify(method: string, params?: unknown): boolean
}

export type RunnerLog = (message: string, meta?: Record<string, unknown>) => void

export interface HandlerContext {
  dialer: RunnerDialer
  config: RunnerConfig
  log: RunnerLog
  /**
   * Runner loopback agent-hook URL (hub/runner split). When set, the pty handler
   * OVERLAYS `SLAYZONE_AGENT_HOOK_URL` in every spawned agent's env with this
   * value and STRIPS any `SLAYZONE_HUB_TOKEN` — so a runner-routed agent always
   * posts its lifecycle hook to the runner's OWN loopback relay (which forwards
   * to the hub over the authed ws channel), never to a hub URL the hub baked in,
   * and no per-agent hub bearer ever reaches the subprocess env. Absent (tests /
   * pre-init) → the env is passed through unchanged.
   */
  agentHookUrl?: string
}

/** A single hub→runner method handler. Params are validated inside. */
export type HubMethodHandler = (params: unknown) => Promise<unknown> | unknown

/** `method → handler` map merged into the dispatch table. */
export type HubMethodTable = Record<string, HubMethodHandler>
