import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  electronBootstrap,
  useHubRegistryStore,
  useFederationOrNull,
  HubScope
} from '@slayzone/transport/client'
import type { HubEntry } from '@slayzone/types'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  toast,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@slayzone/ui'
import { Trash2, RotateCw, Plus, X, Pencil, PlugZap, Star, MoreHorizontal } from 'lucide-react'
import { ComputerActionsProvider } from './ComputerActions'
import { HubCard, HubCardShell, HubStatus, ComputersHeading } from './HubCard'

/**
 * Hubs tab (multi-hub federation) — manage the set of full-data hubs this client
 * connects to at once. The LOCAL hub is always present + always running and is
 * shown read-only; the user adds/removes/relabels REMOTE hubs and picks the
 * default (where new projects land).
 *
 * EACH HUB IS A CARD that owns its computers (`HubCard`).
 * A computer belongs to exactly one hub, fixed when its token is minted, so the
 * containment is the shape of the UI rather than a foreign-key column — which is
 * what lets enrollment drop its hub picker entirely. Cards rather than one table:
 * a hub row and a computer row share no column grid, and the border is what makes
 * "these computers are THIS hub's" legible without a Hub column saying it again.
 *
 * TWO REGISTRIES MEET HERE, and the difference is load-bearing. This tab edits the
 * DRAFT boot-config registry (`getHubRegistry` → `setBootSettings`), which can hold
 * rows the LIVE federation does not: a hub added but not yet saved, or the local
 * hub with its toggle off. A computer list can only exist for a hub that is actually
 * connected, so `hubCardFor` renders a named placeholder for the rest. Never an
 * empty list — "no computers enrolled" is a claim about that hub's configuration,
 * and it would be false.
 *
 * Adding a hub is a dashed card at the end of the list ("＋ Add new hub") that
 * expands into the url/probe form inline — the add affordance lives with the list,
 * not as a detached form. Signing in to an authed remote, editing it, and
 * verifying it are per-card actions (the card identifies which hub, so no picker
 * is needed); sign-in and edit open a modal for that hub.
 *
 * A remote row renders its name as TEXT, never a live input: an always-editable
 * field in the list makes every hub look mid-edit, marks the form dirty on a
 * stray keystroke, and leaves no room for the address. Renaming (and
 * re-addressing) is the explicit Edit action instead. Editing keeps the hub's
 * `id` even when the address changes — the id keys the stored bearer token and
 * `default_hub_id`, so re-deriving it from the new URL would orphan both.
 *
 * The registry lives in the pre-boot `boot-config.json` (a hub can't store the
 * list of hubs), so it is read via `getHubRegistry` and written via
 * `setBootSettings` (bootstrap IPCs). Enabling multi-hub / removing / reordering
 * a hub, toggling the local hub, or changing the default all change what the
 * client dials at boot, so those still require a relaunch — the "Save &
 * relaunch" button is the consent, mirroring the Server tab. A save that is a
 * PURE ADDITION (nothing else changed since the last reload/save) skips the
 * relaunch and pushes the new hub(s) into `useHubRegistryStore` instead — see
 * `save()`'s `isAddOnly` check. That live path exists because every consumer
 * below `FederatedRoot`/`FederationProvider` already resolves hubs reactively;
 * it's deliberately NOT extended to removal, since `FederationProvider`'s
 * per-hub `QueryClient` cache and the WS-client registry in `trpc.ts` have no
 * teardown path yet.
 */

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; normalizedUrl: string; authRequired: boolean | undefined }
  | { kind: 'fail'; reason: string }

/**
 * Does a hub demand a bearer token from its clients?
 *
 * 'unknown' is NOT merged into 'gated' or 'open' — it is the answer for a hub
 * that couldn't be asked (unreachable) or that predates `/health` reporting
 * `authRequired`. Those hubs keep the Sign in button, exactly as before this
 * check existed: hiding it would strip the only way to authenticate against a
 * hub that may well be gating.
 */
type AuthNeed = 'gated' | 'open' | 'unknown'

const authNeedFromProbe = (authRequired: boolean | undefined): AuthNeed =>
  authRequired === undefined ? 'unknown' : authRequired ? 'gated' : 'open'

export function HubsSettingsTab() {
  // OrNull: the Chromium fork renders this surface outside a FederationProvider.
  const fed = useFederationOrNull()
  const [remotes, setRemotes] = useState<HubEntry[]>([])
  const [defaultHubId, setDefaultHubId] = useState('local')
  // "Run a local hub" — the embedded backend on this machine. Authoritative via
  // server_mode (local = run it, remote = don't). Replaces the old Server tab's
  // Local/Remote radio. Off + ≥1 remote = pure thin client (no local backend).
  const [runLocalHub, setRunLocalHub] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // Add-hub row — collapsed to a "＋ Add new hub" button until expanded. Address
  // only; the name defaults to the host and is changed via the Edit action.
  const [addingHub, setAddingHub] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })

  // Edit-hub modal (rename / re-address one remote). `editHubId` non-empty = open.
  const [editHubId, setEditHubId] = useState('')
  const [editLabel, setEditLabel] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editProbe, setEditProbe] = useState<ProbeState>({ kind: 'idle' })

  // Per-row "Verify" — a live reachability probe of a hub already in the list,
  // keyed by hub id. Purely informational (it changes no saved state), so it
  // never marks the form dirty.
  const [verifyStates, setVerifyStates] = useState<Record<string, ProbeState>>({})

  // Whether each remote hub GATES its client API on a bearer token, keyed by hub
  // id — the hub's own answer (`/health` → `authRequired`), never a guess. A hub
  // enforces auth only when it runs in remote mode; a loopback/LAN hub accepts an
  // untokened connection, so offering "Sign in" there is noise. Absent key = not
  // asked yet. See `authNeedFromProbe` for why 'unknown' is a distinct state.
  const [authNeeds, setAuthNeeds] = useState<Record<string, AuthNeed>>({})

  // Sign-in modal (per remote hub bearer auth). `signInHubId` non-empty = open;
  // the row that launched it names the hub, so there's no picker.
  const [signInHubId, setSignInHubId] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signInState, setSignInState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok' } | { kind: 'fail'; error: string }
  >({ kind: 'idle' })
  const [authedHubIds, setAuthedHubIds] = useState<Set<string>>(new Set())

  // Baseline snapshot save() diffs against to detect a pure addition (see
  // `isAddOnly` below) — kept in a ref (not state) since it never drives a
  // render itself, only what save() compares NEXT save against.
  const originalRef = useRef<{ remotes: HubEntry[]; defaultHubId: string; runLocalHub: boolean }>({
    remotes: [],
    defaultHubId: 'local',
    runLocalHub: true
  })

  const reload = useCallback(async () => {
    const [registry, tokens] = await Promise.all([
      electronBootstrap.getHubRegistry(),
      electronBootstrap.getHubTokens()
    ])
    const nextRunLocalHub = registry.hubs.some((h) => h.kind === 'local')
    const nextRemotes = registry.hubs.filter((h) => h.kind === 'remote')
    setRunLocalHub(nextRunLocalHub)
    setRemotes(nextRemotes)
    setDefaultHubId(registry.defaultHubId)
    setAuthedHubIds(new Set(Object.keys(tokens)))
    setDirty(false)
    originalRef.current = {
      remotes: nextRemotes,
      defaultHubId: registry.defaultHubId,
      runLocalHub: nextRunLocalHub
    }
    // Ask every remote whether it gates, so the row can decide whether a Sign in
    // button is even meaningful. Deliberately NOT awaited: the list must render
    // immediately, and each answer lands independently (one slow/unreachable hub
    // can't hold up the others). `/health` answers before the auth gate, so this
    // works while signed out — which is the only state where it matters.
    for (const hub of nextRemotes) {
      if (!hub.url) continue
      void electronBootstrap.probeServerHealth(hub.url).then((result) => {
        setAuthNeeds((prev) => ({ ...prev, [hub.id]: authNeedFromProbe(result.authRequired) }))
      })
    }
  }, [])

  const openSignIn = (hubId: string): void => {
    setSignInHubId(hubId)
    setEmail('')
    setPassword('')
    setSignInState({ kind: 'idle' })
  }

  const closeSignIn = (): void => {
    setSignInHubId('')
    setPassword('')
    setSignInState({ kind: 'idle' })
  }

  const signIn = async (): Promise<void> => {
    const hub = remotes.find((h) => h.id === signInHubId)
    if (!hub?.url) return
    setSignInState({ kind: 'busy' })
    const result = await electronBootstrap.hubLogin({
      hubId: hub.id,
      url: hub.url,
      email: email.trim(),
      password
    })
    if (result.ok) {
      setSignInState({ kind: 'ok' })
      setPassword('')
      setAuthedHubIds((prev) => new Set(prev).add(hub.id))
      // Push the freshly-stored token into the live registry too — if this
      // hub was already live-added this session (see save()'s isAddOnly
      // path), FederationProvider needs the token without a relaunch.
      const tokens = await electronBootstrap.getHubTokens()
      useHubRegistryStore.getState().setTokens(tokens)
    } else {
      setSignInState({ kind: 'fail', error: result.error })
    }
  }

  useEffect(() => {
    void reload()
  }, [reload])

  const probeUrl = async (): Promise<void> => {
    setProbe({ kind: 'probing' })
    const result = await electronBootstrap.probeServerHealth(newUrl)
    if (result.ok && result.normalizedUrl)
      setProbe({
        kind: 'ok',
        normalizedUrl: result.normalizedUrl,
        authRequired: result.authRequired
      })
    else setProbe({ kind: 'fail', reason: result.error ?? 'Unreachable' })
  }

  const collapseAddHub = (): void => {
    setAddingHub(false)
    setNewUrl('')
    setProbe({ kind: 'idle' })
  }

  // Host of a hub URL — the fallback name when the user gives none.
  const hostOf = (url: string): string => new URL(url.replace(/^ws/, 'http')).host

  const addHub = (): void => {
    if (probe.kind !== 'ok') return
    const url = probe.normalizedUrl
    if (remotes.some((h) => h.url === url)) {
      toast.error('That hub is already in the list')
      return
    }
    // Stable id: the fingerprint is learned on first connect (Phase 6 pins it);
    // until then key by the normalized URL so the entry is idempotent.
    const id = `hub:${url}`
    setRemotes((prev) => [...prev, { id, kind: 'remote', label: hostOf(url), url }])
    // The Validate probe already asked this hub whether it gates — carry the
    // answer over so the new row decides about Sign in without a second probe.
    setAuthNeeds((prev) => ({ ...prev, [id]: authNeedFromProbe(probe.authRequired) }))
    collapseAddHub()
    setDirty(true)
  }

  const removeHub = (id: string): void => {
    setRemotes((prev) => {
      const next = prev.filter((h) => h.id !== id)
      // If the removed hub was default, fall back to local (if running) else the
      // first remaining remote.
      setDefaultHubId((cur) =>
        cur === id ? (runLocalHub ? 'local' : (next[0]?.id ?? 'local')) : cur
      )
      return next
    })
    setDirty(true)
  }

  const openEdit = (hub: HubEntry): void => {
    setEditHubId(hub.id)
    setEditLabel(hub.label)
    setEditUrl(hub.url ?? '')
    setEditProbe({ kind: 'idle' })
  }

  const closeEdit = (): void => {
    setEditHubId('')
    setEditProbe({ kind: 'idle' })
  }

  const probeEditUrl = async (): Promise<void> => {
    setEditProbe({ kind: 'probing' })
    const result = await electronBootstrap.probeServerHealth(editUrl)
    if (result.ok && result.normalizedUrl)
      setEditProbe({
        kind: 'ok',
        normalizedUrl: result.normalizedUrl,
        authRequired: result.authRequired
      })
    else setEditProbe({ kind: 'fail', reason: result.error ?? 'Unreachable' })
  }

  const saveEdit = (): void => {
    const hub = remotes.find((h) => h.id === editHubId)
    if (!hub) return
    const typedUrl = editUrl.trim()
    const urlChanged = typedUrl !== (hub.url ?? '')
    // A changed address must probe clean first — the same gate as adding a hub,
    // so a typo can't silently repoint an existing hub at nothing.
    if (urlChanged && editProbe.kind !== 'ok') return
    const nextUrl =
      urlChanged && editProbe.kind === 'ok' ? editProbe.normalizedUrl : (hub.url ?? '')
    if (remotes.some((h) => h.id !== hub.id && h.url === nextUrl)) {
      toast.error('That hub is already in the list')
      return
    }
    const label = editLabel.trim() || hostOf(nextUrl)
    // `id` is intentionally left alone even when the URL moves — see the file
    // header: it keys the stored token and default_hub_id.
    setRemotes((prev) => prev.map((h) => (h.id === hub.id ? { ...h, label, url: nextUrl } : h)))
    if (nextUrl !== hub.url) {
      // Any earlier Verify result described the OLD address. The new address was
      // just validated, so its gating answer replaces the old one outright.
      setVerifyStates((prev) => {
        const next = { ...prev }
        delete next[hub.id]
        return next
      })
      setAuthNeeds((prev) => ({
        ...prev,
        [hub.id]: authNeedFromProbe(editProbe.kind === 'ok' ? editProbe.authRequired : undefined)
      }))
    }
    setDirty(true)
    closeEdit()
  }

  const verifyHub = async (hub: HubEntry): Promise<void> => {
    if (!hub.url) return
    setVerifyStates((prev) => ({ ...prev, [hub.id]: { kind: 'probing' } }))
    const result = await electronBootstrap.probeServerHealth(hub.url)
    setVerifyStates((prev) => ({
      ...prev,
      [hub.id]:
        result.ok && result.normalizedUrl
          ? {
              kind: 'ok',
              normalizedUrl: result.normalizedUrl,
              authRequired: result.authRequired
            }
          : { kind: 'fail', reason: result.error ?? 'Unreachable' }
    }))
    // Same round trip also refreshes whether this hub gates — a hub that was
    // switched to remote mode (or back) since the tab opened is reflected here.
    if (result.ok) {
      setAuthNeeds((prev) => ({ ...prev, [hub.id]: authNeedFromProbe(result.authRequired) }))
    }
  }

  const restartLocal = async (): Promise<void> => {
    setRestarting(true)
    try {
      const result = await electronBootstrap.restartSidecar()
      if (result.ok) toast.success('Local hub restarted')
      else toast.error(`Restart failed: ${result.error ?? 'unknown error'}`)
    } catch (err) {
      toast.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestarting(false)
    }
  }

  // Can't turn the local hub off unless there's at least one remote to fall back
  // to — otherwise the client would have no hub at all.
  const canDisableLocal = remotes.length > 0
  const effectiveRunLocal = runLocalHub || !canDisableLocal

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      // multi_hub stays on as long as there is ≥1 remote hub; removing the last
      // remote turns it off so the client reverts to the single-hub local path.
      const nextMultiHub = remotes.length > 0
      // server_mode is the authoritative "run a local hub" switch. 'local' = run
      // the embedded backend; 'remote' = pure client (no local hub).
      const serverMode = effectiveRunLocal ? 'local' : 'remote'
      // Default must name a hub that will actually exist post-save.
      const nextDefault =
        defaultHubId === 'local' && !effectiveRunLocal ? (remotes[0]?.id ?? 'local') : defaultHubId

      // A pure addition — every previously-saved remote is still present,
      // unchanged (id/url/label), only new ones appended, and nothing else
      // (default hub, local toggle) changed — can go live without a
      // relaunch. Anything else (remove/reorder/relabel-of-existing/toggle/
      // default-change) still needs one, unchanged from before.
      const original = originalRef.current
      const isAddOnly =
        remotes.length > original.remotes.length &&
        original.remotes.every(
          (h, i) =>
            remotes[i]?.id === h.id && remotes[i]?.url === h.url && remotes[i]?.label === h.label
        ) &&
        defaultHubId === original.defaultHubId &&
        effectiveRunLocal === original.runLocalHub

      await electronBootstrap.setBootSettings({
        server_mode: serverMode,
        multi_hub: nextMultiHub,
        hubs: remotes,
        default_hub_id: nextDefault
      })

      if (isAddOnly) {
        useHubRegistryStore.getState().addHubs(remotes.slice(original.remotes.length))
        originalRef.current = { remotes, defaultHubId, runLocalHub: effectiveRunLocal }
        setDirty(false)
      } else {
        await electronBootstrap.relaunch()
        // Under Playwright relaunch is a no-op — reflect the saved state.
        setDirty(false)
      }
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const signInHub = remotes.find((h) => h.id === signInHubId)
  const editHub = remotes.find((h) => h.id === editHubId)
  const editUrlChanged = !!editHub && editUrl.trim() !== (editHub.url ?? '')

  // Hubs the client is actually connected to. A listed hub may have no url (an
  // offline remote the registry still knows), and an unresolvable hub cannot answer
  // a query — so it is not a scope we can mount a computer list in.
  const liveHubIds = new Set((fed?.hubs ?? []).filter((h) => !!h.url).map((h) => h.id))

  const NOT_CONNECTED = 'not connected yet — save and relaunch, then enroll computers'

  // Same heading as a card with a real list, so a card always names what its body
  // is about — the note just replaces the rail instead of hanging under it.
  const placeholder = (text: string): ReactNode => (
    <ComputersHeading note={text} noteTestId="hub-computers-unavailable" />
  )

  /**
   * One hub's card. A hub whose computers CAN be listed gets `HubCard`, which owns
   * the query and fills in both the header's computer cluster and the body. The
   * three that cannot each say why, in a plain shell — never an empty list, since
   * "no computers enrolled" is a claim about that hub's configuration and it would
   * be false here.
   */
  const hubCardFor = (
    hubId: string,
    hubLabel: string,
    isLocalHub: boolean,
    headerTestId: string,
    slots: { identity: ReactNode; status: ReactNode; primary?: ReactNode; more: ReactNode }
  ): ReactNode => {
    const shell = (text: string): ReactNode => (
      <HubCardShell
        key={hubId}
        hubId={hubId}
        headerTestId={headerTestId}
        {...slots}
        body={placeholder(text)}
      />
    )
    const card = (
      <HubCard
        key={hubId}
        hubId={hubId}
        hubLabel={hubLabel}
        isLocalHub={isLocalHub}
        headerTestId={headerTestId}
        {...slots}
      />
    )
    if (isLocalHub && !effectiveRunLocal)
      return shell('local hub is off — turn it on to run work on this machine')
    // No federation = the Chromium fork, whose single hub IS the local one: there
    // is no scope to enter, the ambient client is the only hub there is. A REMOTE
    // hub in that build has no client to query at all, so it gets the placeholder
    // rather than a list that would silently describe the local hub.
    if (!fed) return isLocalHub ? card : shell(NOT_CONNECTED)
    if (!liveHubIds.has(hubId)) return shell(NOT_CONNECTED)
    return (
      <HubScope key={hubId} hubId={hubId}>
        {card}
      </HubScope>
    )
  }

  /**
   * "Default hub" as a star ON THE NAME, not a control in the action cluster.
   *
   * It sat beside Sign in / Verify / Remove and was styled like them, but it is not
   * an action of the same kind: on the default hub it asserted a fact ("this is the
   * default"), on every other hub it offered a change ("make this the default").
   * One widget, two meanings, indistinguishable — the defect worth fixing here.
   *
   * Moved onto the identity, a filled star is unambiguously a PROPERTY of this hub,
   * and clicking a hollow one obviously moves that property. Still `role="radio"`:
   * exactly one hub can hold it, and the star alone does not say so.
   */
  const defaultStar = (hubId: string, testId: string, disabled = false): ReactNode => {
    const isDefault = defaultHubId === hubId
    return (
      <IconButton
        variant="ghost"
        size="icon-sm"
        role="radio"
        aria-checked={isDefault}
        aria-label={isDefault ? 'Default hub for new projects' : 'Make this the default hub'}
        disabled={disabled || isDefault}
        title={
          isDefault ? 'New projects land on this hub' : 'Make this the default hub for new projects'
        }
        onClick={() => {
          setDefaultHubId(hubId)
          setDirty(true)
        }}
        className={cn('shrink-0', isDefault ? 'text-foreground' : 'text-muted-foreground/50')}
        data-testid={testId}
      >
        <Star className={cn('size-3.5', isDefault && 'fill-current')} />
      </IconButton>
    )
  }

  /**
   * A remote hub's status, in the shared vocabulary.
   *
   * Ordered by how recently we learned it: a Verify result is the freshest thing we
   * know, so it outranks a stored token. Every branch is something we were TOLD —
   * there is no branch that guesses, because the honest answer when nothing has
   * been asked is "not verified", not "reachable".
   */
  const remoteStatus = (h: HubEntry): ReactNode => {
    const verify = verifyStates[h.id]
    if (verify?.kind === 'probing') return <HubStatus tone="idle" label="Checking…" />
    if (verify?.kind === 'fail')
      return <HubStatus tone="bad" label="Unreachable" title={verify.reason} />
    if (authedHubIds.has(h.id)) return <HubStatus tone="ok" label="Signed in" />
    if (verify?.kind === 'ok') return <HubStatus tone="ok" label="Reachable" />
    if (authNeeds[h.id] === 'gated') return <HubStatus tone="idle" label="Signed out" />
    return <HubStatus tone="idle" label="Not verified" />
  }

  return (
    <ComputerActionsProvider>
      <div className="space-y-6">
        {/* Hub list — one card per hub, each owning its computers. */}
        <div className="space-y-3" data-testid="hubs-list">
          {/* Local hub — always listed; the toggle is the "run a local hub"
              switch (server_mode). Off requires ≥1 remote to fall back to. */}
          {hubCardFor('local', 'Local', true, 'hub-row-local', {
            identity: (
              <>
                {defaultStar('local', 'hub-default-local', !effectiveRunLocal)}
                <span className="text-base font-semibold">Local</span>
                <span className="text-muted-foreground truncate font-mono text-xs">
                  this machine
                </span>
              </>
            ),
            status: effectiveRunLocal ? (
              <HubStatus tone="ok" label="Running" />
            ) : (
              <HubStatus tone="idle" label="Off" />
            ),
            // Restarting is the main thing you do to a running local hub, so it
            // takes the primary slot; when the hub is off there is nothing to cycle.
            primary: effectiveRunLocal ? (
              <IconButton
                variant="ghost"
                size="icon-sm"
                disabled={restarting}
                aria-label="Restart local hub"
                title="Restart local hub (stops running agents + terminals; reconnects automatically)"
                onClick={() => void restartLocal()}
                data-testid="hub-local-restart"
              >
                <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} />
              </IconButton>
            ) : null,
            more: (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More local hub actions"
                    data-testid="hub-more-local"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* A checkbox item, not a plain action: "run a local hub" is a
                    persistent setting, and the menu has to show which way it is
                    set without being opened twice to find out. */}
                  <DropdownMenuCheckboxItem
                    checked={effectiveRunLocal}
                    disabled={!canDisableLocal}
                    onCheckedChange={(v) => {
                      setRunLocalHub(v)
                      if (!v && defaultHubId === 'local') setDefaultHubId(remotes[0]?.id ?? 'local')
                      setDirty(true)
                    }}
                    data-testid="hub-local-toggle"
                  >
                    Run a local hub
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })}
          {remotes.map((h) => {
            const verifyState = verifyStates[h.id]
            const authNeed = authNeeds[h.id]
            // Offer Sign in only when this hub actually gates — or when we
            // could not find out ('unknown': unreachable, or a hub too old to
            // report it), where withholding the button would strip the only
            // way to authenticate. An absent entry means the probe is still in
            // flight; stay quiet rather than flash a button that may not apply.
            const showSignIn =
              !authedHubIds.has(h.id) && (authNeed === 'gated' || authNeed === 'unknown')
            return hubCardFor(h.id, h.label, false, 'hub-row-remote', {
              identity: (
                <>
                  {defaultStar(h.id, 'hub-default-remote')}
                  <span
                    className="truncate text-base font-semibold"
                    title={h.label}
                    data-testid="hub-label"
                  >
                    {h.label}
                  </span>
                  {/* The address no longer carries state spans appended to it — the
                    signed-in / verify result the identity used to grow now live in
                    the status slot, where they line up across cards. `hub-signed-in`
                    stays as a marker so the fact remains separately assertable. */}
                  <span className="text-muted-foreground truncate font-mono text-xs" title={h.url}>
                    {h.url}
                  </span>
                  {authedHubIds.has(h.id) && (
                    <span className="sr-only" data-testid="hub-signed-in">
                      signed in
                    </span>
                  )}
                </>
              ),
              status: remoteStatus(h),
              // Sign in is the only remote action worth a labelled button — it is
              // the one that unblocks everything else. Verify/Edit/Remove are
              // occasional, so they go behind `⋯`.
              primary: showSignIn ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  title={
                    authNeed === 'gated'
                      ? 'This hub requires a signed-in account'
                      : "Could not confirm whether this hub requires sign-in — it's offered just in case"
                  }
                  onClick={() => openSignIn(h.id)}
                  data-testid="hub-signin-open"
                >
                  Sign in
                </Button>
              ) : null,
              more: (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More actions for ${h.label}`}
                      data-testid="hub-more-remote"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={verifyState?.kind === 'probing' || !h.url}
                      onSelect={() => void verifyHub(h)}
                      data-testid="hub-verify"
                    >
                      <PlugZap className="size-3.5" />
                      {verifyState?.kind === 'probing' ? 'Checking…' : 'Verify reachable'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openEdit(h)} data-testid="hub-edit-open">
                      <Pencil className="size-3.5" />
                      Edit name &amp; address
                    </DropdownMenuItem>
                    {/* Separated: removing a hub is the one item here that destroys
                      configuration, and it must not sit one slip away from Edit. */}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => removeHub(h.id)}
                      data-testid="hub-remove"
                    >
                      <Trash2 className="size-3.5" />
                      Remove hub
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            })
          })}
          {/* Add-hub card — dashed, so it reads as a slot rather than a hub. */}
          <div className="border-border rounded-lg border border-dashed" data-testid="hub-add-row">
            {addingHub ? (
              <div className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={newUrl}
                    onChange={(e) => {
                      setNewUrl(e.target.value)
                      setProbe({ kind: 'idle' })
                    }}
                    placeholder="https://box.lan:7800 or wss://box.lan:7800/trpc"
                    className="max-w-lg font-mono"
                    data-testid="hub-add-url"
                  />
                  <Button
                    variant="outline"
                    disabled={probe.kind === 'probing' || !newUrl.trim()}
                    onClick={() => {
                      void probeUrl()
                    }}
                    data-testid="hub-probe"
                  >
                    {probe.kind === 'probing' ? 'Checking…' : 'Validate'}
                  </Button>
                  <Button disabled={probe.kind !== 'ok'} onClick={addHub} data-testid="hub-add">
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={collapseAddHub}
                    data-testid="hub-add-cancel"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="h-4 text-xs" data-testid="hub-probe-result">
                  {probe.kind === 'ok' && (
                    <span className="text-green-500">✓ reachable — {probe.normalizedUrl}</span>
                  )}
                  {probe.kind === 'fail' && (
                    <span className="text-destructive">✗ {probe.reason}</span>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingHub(true)}
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2.5 text-sm"
                data-testid="hub-add-open"
              >
                <Plus className="size-4" />
                Add new hub
              </button>
            )}
          </div>
          {dirty && (
            <Button
              className="w-full"
              onClick={() => {
                void save()
              }}
              disabled={saving}
              data-testid="hubs-save-relaunch"
            >
              {saving ? 'Saving…' : 'Save & relaunch'}
            </Button>
          )}
        </div>

        {/* Edit — modal launched from a remote row. Owns the hub's name (the list
          shows it read-only) and its address; a changed address must validate
          before it can be saved. */}
        <Dialog open={!!editHubId} onOpenChange={(open) => !open && closeEdit()}>
          <DialogContent data-testid="hub-edit-dialog">
            <DialogHeader>
              <DialogTitle>Edit hub</DialogTitle>
              <DialogDescription>
                Rename this hub or point it at a different address. Changes take effect after
                saving; a new address must be validated first.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Name"
                data-testid="hub-edit-label"
              />
              <div className="flex items-center gap-2">
                <Input
                  value={editUrl}
                  onChange={(e) => {
                    setEditUrl(e.target.value)
                    setEditProbe({ kind: 'idle' })
                  }}
                  placeholder="https://box.lan:7800 or wss://box.lan:7800/trpc"
                  className="font-mono"
                  data-testid="hub-edit-url"
                />
                <Button
                  variant="outline"
                  disabled={editProbe.kind === 'probing' || !editUrl.trim() || !editUrlChanged}
                  onClick={() => {
                    void probeEditUrl()
                  }}
                  data-testid="hub-edit-probe"
                >
                  {editProbe.kind === 'probing' ? 'Checking…' : 'Validate'}
                </Button>
              </div>
              <div className="h-4 text-xs" data-testid="hub-edit-probe-result">
                {editProbe.kind === 'ok' && (
                  <span className="text-green-500">✓ reachable — {editProbe.normalizedUrl}</span>
                )}
                {editProbe.kind === 'fail' && (
                  <span className="text-destructive">✗ {editProbe.reason}</span>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeEdit}>
                Cancel
              </Button>
              <Button
                disabled={!editUrl.trim() || (editUrlChanged && editProbe.kind !== 'ok')}
                onClick={saveEdit}
                data-testid="hub-edit-save"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Sign in — modal launched from a remote row. The row names the hub. */}
        <Dialog open={!!signInHubId} onOpenChange={(open) => !open && closeSignIn()}>
          <DialogContent data-testid="hub-signin-dialog">
            <DialogHeader>
              <DialogTitle>Sign in to {signInHub?.label ?? 'hub'}</DialogTitle>
              <DialogDescription>
                This remote hub requires auth. Sign in with your hub account; the token is stored
                encrypted on this machine.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email"
                type="email"
                data-testid="hub-signin-email"
              />
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                type="password"
                data-testid="hub-signin-password"
              />
              <div className="h-4 text-xs" data-testid="hub-signin-result">
                {signInState.kind === 'ok' && <span className="text-green-500">✓ signed in</span>}
                {signInState.kind === 'fail' && (
                  <span className="text-destructive">✗ {signInState.error}</span>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeSignIn}>
                {signInState.kind === 'ok' ? 'Done' : 'Cancel'}
              </Button>
              <Button
                disabled={signInState.kind === 'busy' || !email.trim() || !password}
                onClick={() => {
                  void signIn()
                }}
                data-testid="hub-signin"
              >
                {signInState.kind === 'busy' ? 'Signing in…' : 'Sign in'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ComputerActionsProvider>
  )
}
