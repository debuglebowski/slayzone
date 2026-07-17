import { useCallback, useEffect, useState } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import type { HubEntry } from '@slayzone/types'
import {
  Button,
  Input,
  Label,
  toast,
  cn,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Trash2, RotateCw } from 'lucide-react'
import { SettingsTabIntro } from './SettingsTabIntro'

/**
 * Hubs tab (multi-hub federation) — manage the set of full-data hubs this client
 * connects to at once. The LOCAL hub is always present + always running and is
 * shown read-only; the user adds/removes/relabels REMOTE hubs and picks the
 * default (where new projects land).
 *
 * The registry lives in the pre-boot `boot-config.json` (a hub can't store the
 * list of hubs), so it is read via `getHubRegistry` and written via
 * `setBootSettings` (bootstrap IPCs). Enabling multi-hub / adding / removing a
 * hub changes what the client dials at boot, so it requires a relaunch — the
 * "Save & relaunch" button is the consent, mirroring the Server tab.
 */

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; normalizedUrl: string }
  | { kind: 'fail'; reason: string }

export function HubsSettingsTab() {
  const [remotes, setRemotes] = useState<HubEntry[]>([])
  const [defaultHubId, setDefaultHubId] = useState('local')
  // "Run a local hub" — the embedded backend on this machine. Authoritative via
  // server_mode (local = run it, remote = don't). Replaces the old Server tab's
  // Local/Remote radio. Off + ≥1 remote = pure thin client (no local backend).
  const [runLocalHub, setRunLocalHub] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // Add-hub form
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })

  // Sign-in form (per remote hub bearer auth)
  const [signInHubId, setSignInHubId] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signInState, setSignInState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok' } | { kind: 'fail'; error: string }
  >({ kind: 'idle' })
  const [authedHubIds, setAuthedHubIds] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const [registry, tokens] = await Promise.all([
      electronBootstrap.getHubRegistry(),
      electronBootstrap.getHubTokens()
    ])
    setRunLocalHub(registry.hubs.some((h) => h.kind === 'local'))
    setRemotes(registry.hubs.filter((h) => h.kind === 'remote'))
    setDefaultHubId(registry.defaultHubId)
    setAuthedHubIds(new Set(Object.keys(tokens)))
    setDirty(false)
  }, [])

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
    if (result.ok && result.normalizedUrl) setProbe({ kind: 'ok', normalizedUrl: result.normalizedUrl })
    else setProbe({ kind: 'fail', reason: result.error ?? 'Unreachable' })
  }

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
    const label = newLabel.trim() || new URL(url.replace(/^ws/, 'http')).host
    setRemotes((prev) => [...prev, { id, kind: 'remote', label, url }])
    setNewLabel('')
    setNewUrl('')
    setProbe({ kind: 'idle' })
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

  const relabel = (id: string, label: string): void => {
    setRemotes((prev) => prev.map((h) => (h.id === id ? { ...h, label } : h)))
    setDirty(true)
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
      await electronBootstrap.setBootSettings({
        server_mode: serverMode,
        multi_hub: nextMultiHub,
        hubs: remotes,
        default_hub_id: nextDefault
      })
      await electronBootstrap.relaunch()
      // Under Playwright relaunch is a no-op — reflect the saved state.
      setDirty(false)
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Hubs"
        description="Where SlayZone's backend runs. Run a local hub on this machine and/or connect to remote hubs — each hub owns its own projects and tasks, shown together in one rail. Pick a default hub for new projects."
      />

      {/* Hub list */}
      <div className="space-y-3">
        <Label className="text-base font-semibold">Hubs</Label>
        <table className="w-full text-sm" data-testid="hubs-table">
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th className="py-1 pr-2 font-medium">Name</th>
              <th className="py-1 pr-2 font-medium">Address</th>
              <th className="py-1 pr-2 font-medium">Default</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {/* Local hub — always listed; the toggle is the "run a local hub"
                switch (server_mode). Off requires ≥1 remote to fall back to. */}
            <tr className="border-border border-t" data-testid="hub-row-local">
              <td className="py-2 pr-2 font-medium">Local</td>
              <td className="text-muted-foreground py-2 pr-2 font-mono text-xs">this machine</td>
              <td className="py-2 pr-2">
                <input
                  type="radio"
                  name="default_hub"
                  checked={defaultHubId === 'local'}
                  disabled={!effectiveRunLocal}
                  onChange={() => {
                    setDefaultHubId('local')
                    setDirty(true)
                  }}
                  data-testid="hub-default-local"
                />
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={effectiveRunLocal}
                    disabled={!canDisableLocal}
                    onCheckedChange={(v) => {
                      setRunLocalHub(v)
                      if (!v && defaultHubId === 'local') setDefaultHubId(remotes[0]?.id ?? 'local')
                      setDirty(true)
                    }}
                    data-testid="hub-local-toggle"
                  />
                  <span className="text-muted-foreground">
                    {effectiveRunLocal ? 'running' : 'off'}
                  </span>
                  {effectiveRunLocal && (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={restarting}
                      title="Restart local hub (stops running agents + terminals; reconnects automatically)"
                      onClick={() => void restartLocal()}
                      data-testid="hub-local-restart"
                    >
                      <RotateCw className={cn('size-4', restarting && 'animate-spin')} />
                    </Button>
                  )}
                </div>
              </td>
            </tr>
            {remotes.map((h) => (
              <tr key={h.id} className="border-border border-t" data-testid="hub-row-remote">
                <td className="py-2 pr-2">
                  <Input
                    value={h.label}
                    onChange={(e) => relabel(h.id, e.target.value)}
                    className="h-7 max-w-[12rem]"
                    data-testid="hub-label-input"
                  />
                </td>
                <td className="text-muted-foreground py-2 pr-2 font-mono text-xs">
                  {h.url}
                  {authedHubIds.has(h.id) && (
                    <span className="ml-2 text-green-500" data-testid="hub-signed-in">
                      ● signed in
                    </span>
                  )}
                </td>
                <td className="py-2 pr-2">
                  <input
                    type="radio"
                    name="default_hub"
                    checked={defaultHubId === h.id}
                    onChange={() => {
                      setDefaultHubId(h.id)
                      setDirty(true)
                    }}
                    data-testid="hub-default-remote"
                  />
                </td>
                <td className="py-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeHub(h.id)}
                    data-testid="hub-remove"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {remotes.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Just the local hub. Add a remote hub below to connect to more.
          </p>
        )}
      </div>

      {/* Add a hub */}
      <div className="border-border space-y-3 border-t pt-6">
        <Label className="text-base font-semibold">Add a hub</Label>
        <div className="flex items-center gap-2">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Name (optional)"
            className="max-w-[12rem]"
            data-testid="hub-add-label"
          />
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
        </div>
        <div className="h-4 text-xs" data-testid="hub-probe-result">
          {probe.kind === 'ok' && (
            <span className="text-green-500">✓ reachable — {probe.normalizedUrl}</span>
          )}
          {probe.kind === 'fail' && <span className="text-destructive">✗ {probe.reason}</span>}
        </div>
      </div>

      {/* Sign in — only relevant when there's a remote hub to authenticate to. */}
      {remotes.length > 0 && (
        <div className="border-border space-y-3 border-t pt-6">
          <Label className="text-base font-semibold">Sign in to a hub</Label>
          <p className="text-muted-foreground max-w-lg text-xs">
            Remote hubs that require auth need a bearer token. Sign in with your hub account; the
            token is stored encrypted on this machine.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={signInHubId || remotes[0]?.id}
              onValueChange={(v) => {
                setSignInHubId(v)
                setSignInState({ kind: 'idle' })
              }}
            >
              <SelectTrigger className="max-w-[12rem]" data-testid="hub-signin-select">
                <SelectValue placeholder="Choose hub" />
              </SelectTrigger>
              <SelectContent>
                {remotes.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              type="email"
              className="max-w-[14rem]"
              data-testid="hub-signin-email"
            />
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type="password"
              className="max-w-[14rem]"
              data-testid="hub-signin-password"
            />
            <Button
              disabled={signInState.kind === 'busy' || !email.trim() || !password}
              onClick={() => {
                void signIn()
              }}
              data-testid="hub-signin"
            >
              {signInState.kind === 'busy' ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
          <div className="h-4 text-xs" data-testid="hub-signin-result">
            {signInState.kind === 'ok' && <span className="text-green-500">✓ signed in</span>}
            {signInState.kind === 'fail' && (
              <span className="text-destructive">✗ {signInState.error}</span>
            )}
          </div>
        </div>
      )}

      {/* Save */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={() => {
            void save()
          }}
          disabled={!dirty || saving}
          data-testid="hubs-save-relaunch"
        >
          {saving ? 'Saving…' : 'Save & relaunch'}
        </Button>
        {dirty && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
      </div>
    </div>
  )
}
