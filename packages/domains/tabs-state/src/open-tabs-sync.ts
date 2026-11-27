/**
 * The desktop tab bar ↔ each hub's open tabs (`openTabs` router, tabs-state server).
 *
 * The desktop keeps its whole tab bar in `viewState` (home, order across hubs, which
 * tab is active). Each hub keeps the signed-in user's open tabs of ITS OWN tasks, the
 * list the iPad shows and edits. This module keeps the two agreeing, per hub, with a
 * three-way merge against the list both last agreed on (`openTabsSync[hubId]`, saved
 * in `viewState`): whatever either side opened or closed since is applied to the other.
 * So a tab closed on the iPad while the desktop was offline closes here once it
 * reconnects, and one opened here offline reaches the hub — neither side overwrites
 * the other.
 *
 * Order: the hub takes this client's order of its tabs whenever that order changed
 * here since the last sync (opened, closed or moved). An order changed only elsewhere
 * is not pushed back, so two desktops of one user never take turns rewriting it.
 *
 * Active tab: never synced — each screen shows its own task.
 *
 * Started once per main window (`loadTabStoreState`); a hub that cannot answer (down,
 * signed out, older than `openTabs`) is retried on the next change or reconnect.
 */
import { getHubClient, listHubClients, type TabsStateTrpcClient } from './trpc'

export interface OpenTabsMerge {
  /** Opened elsewhere: open here. */
  openLocally: string[]
  /** Closed elsewhere: close here. */
  closeLocally: string[]
  /** Opened here: open on the hub. */
  pushOpen: string[]
  /** Closed here: close on the hub. */
  pushClose: string[]
}

/**
 * @param base the hub's tabs as both sides last agreed (undefined: never synced — the
 *   two lists are joined, nothing is closed)
 * @param local this client's open tabs known to belong to this hub
 * @param remote the hub's list now
 * @param openAnywhere every task tab open on this client, whichever hub — a tab whose
 *   hub is not known yet is still open, and must not read as closed here
 */
export function mergeOpenTabs(input: {
  base: readonly string[] | undefined
  local: readonly string[]
  remote: readonly string[]
  openAnywhere: ReadonlySet<string>
}): OpenTabsMerge {
  const { base, local, remote, openAnywhere } = input
  const remoteSet = new Set(remote)
  if (base === undefined) {
    return {
      openLocally: remote.filter((id) => !openAnywhere.has(id)),
      closeLocally: [],
      pushOpen: local.filter((id) => !remoteSet.has(id)),
      pushClose: []
    }
  }
  const baseSet = new Set(base)
  return {
    openLocally: remote.filter((id) => !baseSet.has(id) && !openAnywhere.has(id)),
    closeLocally: base.filter((id) => !remoteSet.has(id) && openAnywhere.has(id)),
    pushOpen: local.filter((id) => !baseSet.has(id) && !remoteSet.has(id)),
    pushClose: base.filter((id) => !openAnywhere.has(id) && remoteSet.has(id))
  }
}

/** This client's order of the hub's tabs to push, or null when unchanged since `base`. */
export function orderToPush(
  base: readonly string[] | undefined,
  localAfter: readonly string[]
): string[] | null {
  if (base && base.length === localAfter.length && base.every((id, i) => localAfter[i] === id))
    return null
  return [...localAfter]
}

// ── runtime ───────────────────────────────────────────────────────────────────

/** What the sync needs from the tab store (injected: keeps this file store-free). */
export interface OpenTabsSyncHost {
  /** Task tabs in tab-bar order, with the hub each is known to belong to. */
  taskTabs(): { taskId: string; hubId?: string }[]
  openInBackground(taskId: string): void
  close(taskId: string): void
  base(hubId: string): readonly string[] | undefined
  setBase(hubId: string, taskIds: string[]): void
  /** Called with a listener for any tab change; returns the unsubscribe. */
  onTabsChanged(listener: () => void): () => void
}

type HubClientOf = (hubId: string) => TabsStateTrpcClient | null

interface HubSync {
  running: boolean
  again: boolean
  unsubscribe: () => void
}

const TAB_CHANGE_DEBOUNCE_MS = 300
const HUB_SCAN_MS = 1_000

export function startOpenTabsSync(
  host: OpenTabsSyncHost,
  opts: {
    hubIds?: () => string[]
    clientOf?: HubClientOf
  } = {}
): () => void {
  const hubIds = opts.hubIds ?? (() => listHubClients().map((h) => h.id))
  const clientOf: HubClientOf = opts.clientOf ?? ((id) => getHubClient(id)?.client ?? null)
  const hubs = new Map<string, HubSync>()
  let stopped = false

  const syncHub = async (hubId: string, client: TabsStateTrpcClient): Promise<void> => {
    const remote = await client.openTabs.list.query()
    if (stopped) return
    const tabs = host.taskTabs()
    const openAnywhere = new Set(tabs.map((t) => t.taskId))
    const localOf = () =>
      host
        .taskTabs()
        .filter((t) => t.hubId === hubId)
        .map((t) => t.taskId)
    const base = host.base(hubId)
    const merge = mergeOpenTabs({ base, local: localOf(), remote, openAnywhere })
    for (const id of merge.closeLocally) host.close(id)
    for (const id of merge.openLocally) host.openInBackground(id)
    // Each push on its own: one the hub refuses must not hold back the others. A
    // refused one stays out of the agreed list (open) or in it (close), so the next
    // sync sends it again instead of undoing it here.
    // What the hub holds once these pushes land: its list, plus the opens it took,
    // minus the closes it took.
    const onHub = new Set(remote)
    for (const id of merge.pushOpen) {
      try {
        await client.openTabs.open.mutate({ taskId: id })
        onHub.add(id)
      } catch {
        // stays off the hub, so out of the agreed list: pushed open again next sync
      }
    }
    for (const id of merge.pushClose) {
      try {
        await client.openTabs.close.mutate({ taskId: id })
        onHub.delete(id)
      } catch {
        // stays on the hub, so in the agreed list: pushed closed again next sync
      }
    }
    if (stopped) return
    // The tab bar NOW, after every await above: tabs may have been opened or closed
    // meanwhile. A tab whose hub is not recorded yet (just opened from the hub, or its
    // task not seen yet) but which this hub holds is this hub's: it counts in this
    // hub's order already, so a close elsewhere still reaches it.
    const after = host
      .taskTabs()
      .filter((t) => t.hubId === hubId || (t.hubId === undefined && onHub.has(t.taskId)))
      .map((t) => t.taskId)
    // Agreed = exactly what the hub holds, in this client's order. Never a tab the hub
    // was not sent: one opened here mid-sync would read as "closed on the hub" next
    // sync and close here. Never missing one the hub still holds: one closed here
    // mid-sync would read as "opened elsewhere" and reopen.
    const ordered = after.filter((id) => onHub.has(id))
    const inOrder = new Set(ordered)
    const agreed = [...ordered, ...[...onHub].filter((id) => !inOrder.has(id))]
    const order = orderToPush(base, agreed)
    if (order && ordered.length > 1) await client.openTabs.reorder.mutate({ taskIds: ordered })
    if (!stopped && order) host.setBase(hubId, agreed)
  }

  const run = (hubId: string): void => {
    const state = hubs.get(hubId)
    const client = clientOf(hubId)
    if (!state || !client || stopped) return
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    state.again = false
    void syncHub(hubId, client)
      .catch(() => {
        // Unreachable, signed out or an older hub: nothing changes; the next tab
        // change or reconnect tries again.
      })
      .then(() => {
        state.running = false
        if (state.again) run(hubId)
      })
  }

  const watch = (): void => {
    for (const hubId of hubIds()) {
      if (hubs.has(hubId)) continue
      const client = clientOf(hubId)
      if (!client) continue
      const state: HubSync = { running: false, again: false, unsubscribe: () => undefined }
      hubs.set(hubId, state)
      // Started fires on every (re)connect: catch up with what changed meanwhile.
      const sub = client.openTabs.onChanged.subscribe(undefined, {
        onStarted: () => run(hubId),
        onData: () => run(hubId),
        onError: () => {
          // An older hub has no `openTabs`: forget it, so a later reconnect (an
          // upgraded hub) is watched again.
          hubs.delete(hubId)
        }
      })
      state.unsubscribe = () => sub.unsubscribe()
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const offTabs = host.onTabsChanged(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      watch()
      for (const hubId of hubs.keys()) run(hubId)
    }, TAB_CHANGE_DEBOUNCE_MS)
  })
  watch()
  // Hub clients come and go after boot (the app opens a hub's socket once it renders;
  // a hub is added, or answers again after an upgrade): look for new ones regularly,
  // not only when a tab changes — an idle desktop must still hear the iPad.
  const scan = setInterval(watch, HUB_SCAN_MS)

  return () => {
    stopped = true
    clearInterval(scan)
    if (timer) clearTimeout(timer)
    offTabs()
    for (const state of hubs.values()) state.unsubscribe()
    hubs.clear()
  }
}
