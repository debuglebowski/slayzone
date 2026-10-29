/**
 * Shared handler wiring types. Each exec handler module closes over a
 * {@link HandlerContext} (the hub dialer for streaming notifications, the
 * computer config for the allowedRoots guard, and a logger) and exposes a table
 * of `method → handler` entries that `main.ts` merges into the single hub
 * request dispatcher.
 *
 * @module computer/handlers/types
 */

import type { ComputerConfig } from '../config'

/** Minimal slice of the HubDialer the handlers depend on (fire-and-forget). */
export interface ComputerDialer {
  /** Fire-and-forget notification to the hub; returns false when offline. */
  notify(method: string, params?: unknown): boolean
}

export type ComputerLog = (message: string, meta?: Record<string, unknown>) => void

export interface HandlerContext {
  dialer: ComputerDialer
  config: ComputerConfig
  log: ComputerLog
  /**
   * Computer loopback agent-hook URL (hub/computer split). When set, the pty handler
   * OVERLAYS `SLAYZONE_AGENT_HOOK_URL` in every spawned agent's env with this
   * value and STRIPS any `SLAYZONE_HUB_TOKEN` — so a computer-routed agent always
   * posts its lifecycle hook to the computer's OWN loopback relay (which forwards
   * to the hub over the authed ws channel), never to a hub URL the hub baked in,
   * and no per-agent hub bearer ever reaches the subprocess env. Absent (tests /
   * pre-init) → the env is passed through unchanged.
   */
  agentHookUrl?: string
  /**
   * The authority (`host[:port]`) THIS hub connection dials. When set, the pty and
   * proc handlers OVERLAY `SLAYZONE_HUB_ADDRESS` with it in every process they spawn,
   * so `slay` there talks to the hub that spawned it — never to a hub that
   * `slay hub use` / `hub login` stored on this machine. Set here, not by the hub:
   * only this side knows how this box reaches the hub (loopback for the desktop's
   * own computer, the public address for a cloud one). Absent (tests, or a dial url
   * with no authority form) → whatever the hub sent is passed through.
   */
  hubAddress?: string
}

/** A single hub→computer method handler. Params are validated inside. */
export type HubMethodHandler = (params: unknown) => Promise<unknown> | unknown

/** `method → handler` map merged into the dispatch table. */
export type HubMethodTable = Record<string, HubMethodHandler>
