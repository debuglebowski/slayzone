import { useCallback, useEffect, useState } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import type { HubEntry } from '@slayzone/types'
import { Button, Input, Label, toast } from '@slayzone/ui'
import { Trash2 } from 'lucide-react'
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
  const [multiHub, setMultiHub] = useState(false)
  const [remotes, setRemotes] = useState<HubEntry[]>([])
  const [defaultHubId, setDefaultHubId] = useState('local')
  const [localPresent, setLocalPresent] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Add-hub form
  const [newLabel, setNewLabel] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })

  const reload = useCallback(async () => {
    const [cfg, registry] = await Promise.all([
      electronBootstrap.getBootConfig(),
      electronBootstrap.getHubRegistry()
    ])
    setMultiHub(cfg.multiHub)
    setLocalPresent(registry.hubs.some((h) => h.kind === 'local'))
    setRemotes(registry.hubs.filter((h) => h.kind === 'remote'))
    setDefaultHubId(registry.defaultHubId)
    setDirty(false)
  }, [])

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
    setMultiHub(true)
    setNewLabel('')
    setNewUrl('')
    setProbe({ kind: 'idle' })
    setDirty(true)
  }

  const removeHub = (id: string): void => {
    setRemotes((prev) => prev.filter((h) => h.id !== id))
    // If the removed hub was default, fall back to local.
    setDefaultHubId((prev) => (prev === id ? 'local' : prev))
    setDirty(true)
  }

  const relabel = (id: string, label: string): void => {
    setRemotes((prev) => prev.map((h) => (h.id === id ? { ...h, label } : h)))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      // multi_hub stays on as long as there is ≥1 remote hub; removing the last
      // remote turns it off so the client reverts to the single-hub local path.
      const nextMultiHub = remotes.length > 0
      await electronBootstrap.setBootSettings({
        multi_hub: nextMultiHub,
        hubs: remotes,
        default_hub_id: defaultHubId
      })
      await electronBootstrap.relaunch()
      // Under Playwright relaunch is a no-op — reflect the saved state.
      setMultiHub(nextMultiHub)
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
        description="Connect to multiple full-data hubs at once. Each hub owns its own projects and tasks; the rail shows them all together. The local hub always runs on this machine. Pick a default hub for new projects."
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
            {localPresent && (
              <tr className="border-border border-t" data-testid="hub-row-local">
                <td className="py-2 pr-2 font-medium">Local</td>
                <td className="text-muted-foreground py-2 pr-2 font-mono text-xs">this machine</td>
                <td className="py-2 pr-2">
                  <input
                    type="radio"
                    name="default_hub"
                    checked={defaultHubId === 'local'}
                    onChange={() => {
                      setDefaultHubId('local')
                      setDirty(true)
                    }}
                    data-testid="hub-default-local"
                  />
                </td>
                <td className="text-muted-foreground py-2 text-xs">always on</td>
              </tr>
            )}
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
                <td className="text-muted-foreground py-2 pr-2 font-mono text-xs">{h.url}</td>
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
        {!multiHub && remotes.length === 0 && (
          <p className="text-muted-foreground text-xs">
            Single-hub mode. Add a remote hub below to federate.
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
