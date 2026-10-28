import type { FindJoinTokenAccount } from './join-token-policy'

// Computers / computer deps — the hub/computer-split surface the `computersRouter`
// reads from its host: the live computer gateway (computer-WS connection
// status) plus the value `mintJoinToken` bakes into a join token (the computer WS URL
// a computer dials). Both are exposed as GETTERS, not snapshots: the gateway is built
// asynchronously (auth migrations) and the URL is only known after the server binds
// its port, so the registry must read the live refs each call.
//
// Populated once composeServer + the server host wire it (always, barring init failure); when
// the computer init failed it is not set and `getComputersDeps()` throws — the router's
// computer-dependent procedures fail cleanly and nothing calls them (the UI is
// wave 3). The pure computer-binding mutations (setTaskComputer / … / revokeComputer)
// go straight through `ctx.db` and never touch this registry, so they work
// regardless. `getComputersDepsOrNull()` lets `list` degrade gracefully (store rows
// with no live status) instead of throwing when the gateway isn't wired.

/** Structural slice of the computer gateway the computers router reads — connection
 *  status only. Kept structural (not the full `HubComputerGateway`) so this package
 *  stays decoupled from `@slayzone/computer-transport`.
 *
 *  NOTE: structural mirrors of a real interface drift silently (that class of bug
 *  cost four wire-contract fixes in the computer handlers). Keep this a strict
 *  SUBSET of `HubComputerGateway`'s member names/shapes so the real gateway is
 *  always assignable to it. */
export type ComputerGateway = {
  /** Socket-open computers. Says nothing about liveness. */
  listComputers: () => ReadonlyArray<{
    computerId: string
    connectedAt: number
    lastSeenAt: number
  }>
  /** Computers that can actually take work now (open + inside the heartbeat window).
   *  This is what a dispatch decision should read; `listComputers` is for display. */
  listUsableComputers: () => ReadonlyArray<{
    computerId: string
    connectedAt: number
    lastSeenAt: number
  }>
}

export type ComputersDeps = {
  /**
   * Push connection changes to subscribers. Wired in `composition.ts`, where the
   * real gateway and its typed event map are in scope — a structural mirror of a
   * generic `TypedEventEmitter` would have to lie about its types, which is the
   * drift the ComputerGateway note above warns about. Absent = no live updates,
   * which is the fork sidecar's honest state.
   */
  subscribeComputerStatus?: (
    listener: (change: { computerId: string; connected: boolean }) => void
  ) => () => void
  /** Live computer gateway, or null until the async computer init resolves. */
  getGateway: () => ComputerGateway | null
  /** ws(s)://host:port/computers URL a join token embeds for the computer to dial.
   *  Null until the computer listener's port is bound. */
  getHubUrl: () => string | null
  /**
   * The person a join token is minted FOR, by account id or email (T-20,
   * `join-token-policy.ts`). Wired by the hub over hub-auth; consulted only on a hub
   * with login, where a mint without it fails rather than guessing an owner.
   */
  findAccount?: FindJoinTokenAccount
}

let computersDeps: ComputersDeps | null = null

export function setComputersDeps(deps: ComputersDeps): void {
  computersDeps = deps
}

export function getComputersDeps(): ComputersDeps {
  if (!computersDeps)
    throw new Error(
      'computersDeps not initialized — composeServer/server host have not wired it yet'
    )
  return computersDeps
}

/** Non-throwing read for the `list` procedure, which must still return store
 *  rows (with no live connection status) when the gateway isn't wired. */
export function getComputersDepsOrNull(): ComputersDeps | null {
  return computersDeps
}
