/**
 * The local computer on every hub the app lists.
 *
 * The desktop app's own computer (`local-computer-supervisor.ts`) always serves the
 * app's LOCAL hub — that is its primary, enrolled at boot. This module makes it serve
 * every REMOTE hub the client lists too, so work on any of them can run on this
 * machine. A hub joined here can disable the computer (it stays enrolled, gets no new
 * work); deleting it there only lasts until the app enrolls it again — the app's own
 * computer is never deleted from the client.
 *
 * How a hub is joined: the app mints a join token on that hub with the user's session
 * there (`POST /api/computers/join-token`, which every user may call for their own
 * computer), and hands the computer the hub's dial url, its name there and the token.
 * The computer enrolls once and keeps the credential (its own store, keyed by hub
 * host); from then on only the dial url is needed, so that is what this module keeps
 * (`stateFile`), with the computer's id there for the Settings list. Joining and
 * leaving happen at runtime — the computer is never restarted for it.
 *
 * A token is minted only when the computer has no credential on a hub yet, when it
 * asks for one (its credential stopped working: the computer was deleted there, the
 * hub's store was reset), and to recover a hub whose connection failed — at most once
 * per {@link RECOVERY_INTERVAL_MS} per hub, so a hub that refuses every token cannot
 * become a mint loop.
 *
 * @module app/main/local-computer-hubs
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { SecondaryHub, SecondaryHubEvent } from './local-computer-supervisor'

/** A remote hub the client lists. `url` is its client url, `ws(s)://host/trpc`. */
export type RemoteHubEntry = { id: string; label: string; url: string }

/** What a mint returns: the token and the hub's dial url for computers. */
export type MintedJoinToken = { token: string; hubUrl: string }

/** Where this computer stands on one remote hub. */
export type LocalComputerHubState = {
  /** `joining`: told to connect, not yet connected. `joined`: connected now.
   *  `offline`: joined before, not connected now. `failed`: see `error`. */
  state: 'joining' | 'joined' | 'offline' | 'failed'
  /** Its computer id on that hub, once it has enrolled there. */
  computerId: string | null
  error: string | null
}

export type LocalComputerHubsDeps = {
  /** JSON file holding, per hub id, the dial url and the computer's id there. */
  stateFile: string
  /** The remote hubs the client lists now. */
  listRemoteHubs: () => RemoteHubEntry[]
  /** Mint a join token on `hub` for this computer; throws with the reason. */
  mint: (hub: RemoteHubEntry, label: string) => Promise<MintedJoinToken>
  /** The name this computer enrolls under on remote hubs. */
  computerName: () => string
  /** The primary (local) hub's dial url, never joined as a secondary. */
  primaryHubUrl: () => string | null
  /** Hand the desired set to the computer (`LocalComputerHandle.setSecondaryHubs`). */
  apply: (hubs: SecondaryHub[]) => void
  /** Told whenever any hub's state changes (the Settings list re-reads). */
  onChange?: () => void
  log: (line: string) => void
  now?: () => number
}

/** At most one recovery mint per hub in this window. */
export const RECOVERY_INTERVAL_MS = 5 * 60_000

type Persisted = { version: 1; hubs: Record<string, { dialUrl: string; computerId?: string }> }

const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h.startsWith('127.')
}

/**
 * A dial url a remote hub may hand out. A hub without a public address embeds a
 * LOOPBACK url in its tokens: dialed from this machine that reaches this machine's own
 * ports — at best nothing, at worst the app's own local hub under the wrong identity.
 * Accepted only when the hub itself is on loopback too (a hub on this machine).
 */
export function checkDialUrl(
  hub: RemoteHubEntry,
  dialUrl: string,
  primary: string | null
): string | null {
  let dial: URL
  try {
    dial = new URL(dialUrl)
  } catch {
    return `the hub returned an invalid computer address (${dialUrl})`
  }
  if (dial.protocol !== 'ws:' && dial.protocol !== 'wss:') {
    return `the hub returned an invalid computer address (${dialUrl})`
  }
  const hubHost = new URL(hub.url).hostname
  if (isLoopbackHost(dial.hostname) && !isLoopbackHost(hubHost)) {
    return (
      'the hub has no public address for computers (its join tokens point at ' +
      `${dial.host}); set one on the hub (--public-address) so other machines can join`
    )
  }
  if (primary && dialUrl === primary) return 'that hub is this app’s own local hub'
  return null
}

export interface LocalComputerHubs {
  /** Reconcile with the hubs the client lists now: join new ones, leave removed ones. */
  sync: () => Promise<void>
  /** Feed the supervisor's secondary-hub reports here. */
  onEvent: (event: SecondaryHubEvent) => void
  /** Answer the computer's request for a fresh token on the hub it dials at `dialUrl`. */
  mintFor: (dialUrl: string) => Promise<string | null>
  /** Per remote hub id, where this computer stands there. */
  status: () => Record<string, LocalComputerHubState>
}

export function createLocalComputerHubs(deps: LocalComputerHubsDeps): LocalComputerHubs {
  const now = deps.now ?? Date.now
  let persisted: Persisted | null = null
  const states = new Map<string, LocalComputerHubState>()
  /** A token handed to the computer and not yet redeemed: re-sent until it connects. */
  const pendingTokens = new Map<string, string>()
  const lastRecovery = new Map<string, number>()
  let syncing: Promise<void> | null = null
  let again = false

  const load = async (): Promise<Persisted> => {
    if (persisted) return persisted
    try {
      const raw = JSON.parse(await fs.readFile(deps.stateFile, 'utf8')) as Partial<Persisted>
      const hubs: Persisted['hubs'] = {}
      for (const [id, entry] of Object.entries(raw.hubs ?? {})) {
        if (entry && typeof entry.dialUrl === 'string') {
          hubs[id] = {
            dialUrl: entry.dialUrl,
            ...(typeof entry.computerId === 'string' ? { computerId: entry.computerId } : {})
          }
        }
      }
      persisted = { version: 1, hubs }
    } catch {
      persisted = { version: 1, hubs: {} }
    }
    return persisted
  }

  const save = async (): Promise<void> => {
    if (!persisted) return
    await fs.mkdir(dirname(deps.stateFile), { recursive: true })
    const tmp = `${deps.stateFile}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 })
    await fs.rename(tmp, deps.stateFile)
  }

  const setState = (hubId: string, next: Partial<LocalComputerHubState>): void => {
    const prev = states.get(hubId) ?? { state: 'joining', computerId: null, error: null }
    const merged = { ...prev, ...next }
    if (
      prev.state === merged.state &&
      prev.computerId === merged.computerId &&
      prev.error === merged.error &&
      states.has(hubId)
    ) {
      return
    }
    states.set(hubId, merged)
    deps.onChange?.()
  }

  const hubIdForDialUrl = (dialUrl: string): string | null => {
    for (const [id, entry] of Object.entries(persisted?.hubs ?? {})) {
      if (entry.dialUrl === dialUrl) return id
    }
    return null
  }

  /** Mint on `hub`, validate the dial url, remember it. Throws with the reason. */
  const mintOn = async (hub: RemoteHubEntry): Promise<MintedJoinToken> => {
    const minted = await deps.mint(hub, deps.computerName())
    const refused = checkDialUrl(hub, minted.hubUrl, deps.primaryHubUrl())
    if (refused) throw new Error(refused)
    const state = await load()
    const prev = state.hubs[hub.id]
    if (prev?.dialUrl !== minted.hubUrl) {
      state.hubs[hub.id] = { dialUrl: minted.hubUrl }
      await save()
    }
    return minted
  }

  const desired = (): SecondaryHub[] => {
    const name = deps.computerName()
    const out: SecondaryHub[] = []
    const listed = new Set(deps.listRemoteHubs().map((h) => h.id))
    for (const [id, entry] of Object.entries(persisted?.hubs ?? {})) {
      if (!listed.has(id)) continue
      const token = pendingTokens.get(id)
      out.push({ url: entry.dialUrl, name, ...(token ? { joinToken: token } : {}) })
    }
    return out
  }

  const runSync = async (): Promise<void> => {
    const state = await load()
    const hubs = deps.listRemoteHubs()
    const listed = new Set(hubs.map((h) => h.id))
    // A hub the client no longer lists is left: the computer disconnects from it
    // (it stays enrolled there, offline, until someone deletes it).
    let dropped = false
    for (const id of Object.keys(state.hubs)) {
      if (!listed.has(id)) {
        delete state.hubs[id]
        pendingTokens.delete(id)
        states.delete(id)
        dropped = true
      }
    }
    if (dropped) {
      await save()
      deps.onChange?.()
    }
    for (const hub of hubs) {
      if (state.hubs[hub.id]) {
        if (!states.has(hub.id)) {
          setState(hub.id, {
            state: 'joining',
            computerId: state.hubs[hub.id].computerId ?? null,
            error: null
          })
        }
        continue
      }
      // Never enrolled there: the first join needs a token.
      setState(hub.id, { state: 'joining', error: null })
      try {
        const minted = await mintOn(hub)
        pendingTokens.set(hub.id, minted.token)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        deps.log(`[local-computer-hubs] could not join ${hub.label}: ${message}`)
        setState(hub.id, { state: 'failed', error: message })
      }
    }
    deps.apply(desired())
  }

  const sync = (): Promise<void> => {
    if (syncing) {
      again = true
      return syncing
    }
    syncing = (async () => {
      do {
        again = false
        await runSync().catch((err: unknown) =>
          deps.log(`[local-computer-hubs] sync failed: ${String(err)}`)
        )
      } while (again)
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  const recover = async (hubId: string): Promise<void> => {
    const at = now()
    const last = lastRecovery.get(hubId)
    if (last !== undefined && at - last < RECOVERY_INTERVAL_MS) return
    lastRecovery.set(hubId, at)
    const hub = deps.listRemoteHubs().find((h) => h.id === hubId)
    if (!hub) return
    try {
      const minted = await mintOn(hub)
      pendingTokens.set(hubId, minted.token)
      setState(hubId, { state: 'joining', error: null })
      deps.apply(desired())
    } catch (err) {
      setState(hubId, {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const onEvent = (event: SecondaryHubEvent): void => {
    const hubId = hubIdForDialUrl(event.hubUrl)
    if (!hubId) return
    switch (event.type) {
      case 'connected': {
        pendingTokens.delete(hubId)
        setState(hubId, { state: 'joined', computerId: event.computerId || null, error: null })
        const entry = persisted?.hubs[hubId]
        if (entry && event.computerId && entry.computerId !== event.computerId) {
          entry.computerId = event.computerId
          void save().catch((err: unknown) =>
            deps.log(`[local-computer-hubs] could not save: ${String(err)}`)
          )
        }
        return
      }
      case 'disconnected':
        setState(hubId, { state: 'offline' })
        return
      case 'hub-error':
        setState(hubId, { state: 'failed', error: event.message })
        void recover(hubId)
        return
    }
  }

  const mintFor = async (dialUrl: string): Promise<string | null> => {
    await load()
    const hubId = hubIdForDialUrl(dialUrl)
    const hub = hubId ? deps.listRemoteHubs().find((h) => h.id === hubId) : undefined
    if (!hub) return null
    try {
      const minted = await mintOn(hub)
      return minted.token
    } catch (err) {
      setState(hub.id, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  return {
    sync,
    onEvent,
    mintFor,
    status: () => Object.fromEntries(states)
  }
}
