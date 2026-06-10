// TaskDetailsView — now driven by @slayzone/layout. Same look as before (title
// header + panel-toggle bar + horizontal panes) but powered by the recursive
// layout tree, with working divider resize, a native-pane seam (no-op host),
// localStorage persistence, and an overlay-plane demo dialog.
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import {
  COLORS,
  LayoutRoot,
  collectTileTypes,
  isPane,
  isSplit,
  loadTree,
  makePane,
  makeSplit,
  newId,
  useLayoutStore,
  useLayoutTree
} from '@slayzone/layout'
import type { LayoutNode, LayoutTree, PanelProps, PanelRegistry, Tile, TileType } from '@slayzone/layout'
import { createEmbeddedTabHost, setEmbeddedProfileKey } from './embedded-tab-host'
import { makeBrowserPanel } from './BrowserPanel'

const TASK_ID = 'sample-task'
const DEFAULT_BROWSER_URL = 'https://example.com'

interface PanelDef {
  type: TileType
  label: string
  glyph: string
  native?: boolean
}

// Mirrors the real panel set (terminal=Agent, diff=Git). `browser` is native.
const PANELS: PanelDef[] = [
  { type: 'terminal', label: 'Agent', glyph: '›_' },
  { type: 'browser', label: 'Browser', glyph: '◍', native: true },
  { type: 'editor', label: 'Editor', glyph: '</>' },
  { type: 'artifacts', label: 'Artifacts', glyph: '▤' },
  { type: 'git', label: 'Git', glyph: '⑂' },
  { type: 'settings', label: 'Settings', glyph: '⚙' }
]
const LABELS = new Map<TileType, string>(PANELS.map((p) => [p.type, p.label]))
const NATIVE_TYPES = new Set<TileType>(PANELS.filter((p) => p.native).map((p) => p.type))
const DEFAULT_TYPES: TileType[] = ['terminal', 'browser', 'editor']

function makeTile(type: TileType): Tile {
  return {
    id: newId('tile'),
    type,
    title: LABELS.get(type) ?? type,
    renderKind: NATIVE_TYPES.has(type) ? 'native' : 'dom'
  }
}

function buildInitialLayout(): LayoutTree {
  const panes = DEFAULT_TYPES.map((t) => makePane([makeTile(t)]))
  return { root: panes.length === 1 ? panes[0] : makeSplit('row', panes) }
}

function findTileIdOfType(node: LayoutNode | null, type: TileType): string | null {
  if (!node) return null
  if (isPane(node)) return node.tiles.find((t) => t.type === type)?.id ?? null
  if (isSplit(node)) {
    for (const child of node.children) {
      const found = findTileIdOfType(child, type)
      if (found) return found
    }
  }
  return null
}

// Seed the store synchronously at module load (renderer-only) so the first
// synchronous render — including the headless screenshot — already has a tree.
useLayoutStore.getState().bindTask(TASK_ID, loadTree(TASK_ID) ?? buildInitialLayout())

// ── dom panel placeholder (browser is native → not in the registry) ──────────
function Placeholder({ tile }: PanelProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: COLORS.faint,
        fontSize: 12
      }}
    >
      {tile.title} panel — placeholder
    </div>
  )
}

// Native surface host: real embedded-tab views over window.api.browser (mojo).
// Inert when the transport is absent (plain-browser dev), so this is safe as
// the single host for all contexts.
const EMBEDDED_HOST = createEmbeddedTabHost(TASK_ID, DEFAULT_BROWSER_URL)

const REGISTRY: PanelRegistry = {
  terminal: Placeholder,
  browser: makeBrowserPanel(EMBEDDED_HOST),
  editor: Placeholder,
  artifacts: Placeholder,
  git: Placeholder,
  settings: Placeholder
}

const toggleBtnBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  border: 'none',
  borderRadius: 7,
  cursor: 'pointer',
  font: '12px ui-sans-serif, system-ui, sans-serif',
  fontWeight: 500
}

function PanelToggle({ active, onToggle }: { active: Set<string>; onToggle: (type: TileType) => void }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: 4,
        borderRadius: 10,
        background: COLORS.barBg,
        border: `1px solid ${COLORS.border}`
      }}
    >
      {PANELS.map((p) => {
        const on = active.has(p.type)
        return (
          <button
            key={p.type}
            type="button"
            onClick={() => onToggle(p.type)}
            style={{ ...toggleBtnBase, background: on ? COLORS.activeBg : 'transparent', color: on ? COLORS.text : COLORS.muted }}
          >
            <span style={{ font: '12px ui-monospace, monospace', color: on ? COLORS.accent : COLORS.faint }}>
              {p.glyph}
            </span>
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

export function TaskDetailsView() {
  const tree = useLayoutTree()
  const activeTypes = useMemo(() => collectTileTypes(tree.root), [tree])
  const [profile, setProfile] = useState('')

  // Per-task identity (pooled profile): each choice = its own Google login +
  // 1Password. Changing it re-creates the browser pane on the new profile.
  const onProfileChange = (key: string): void => {
    setProfile(key)
    setEmbeddedProfileKey(key)
    const store = useLayoutStore.getState()
    const browserTileId = findTileIdOfType(store.tree.root, 'browser')
    if (browserTileId) {
      store.closeTile(browserTileId)
      setTimeout(() => useLayoutStore.getState().openTile(null, makeTile('browser')), 60)
    }
  }

  const toggle = (type: TileType): void => {
    const store = useLayoutStore.getState()
    if (activeTypes.has(type)) {
      const tileId = findTileIdOfType(store.tree.root, type)
      if (tileId) store.closeTile(tileId)
    } else {
      store.openTile(null, makeTile(type))
    }
  }

  const openDemoDialog = (): void => {
    // cap-layout-p4 — prefer the NATIVE overlay surface (dialog above the live
    // embedded tab, nothing hidden) when the shell host exposes it AND a native
    // tile is showing. Fall back to the DOM portal (which the occlusion policy
    // pairs with hiding native tiles) everywhere else.
    const native = (
      window as unknown as { __slayzoneNativeOverlay?: { show(id: string): Promise<boolean> } }
    ).__slayzoneNativeOverlay
    if (native && activeTypes.has('browser')) {
      void native.show('dialog').then((ok) => {
        if (!ok) openDomDialog()
      })
      return
    }
    openDomDialog()
  }

  const openExtensions = (): void => {
    // Open the VISIBLE extension-management window (chrome://extensions + Web
    // Store + native install prompts) on the shared profile. Calls the raw shim
    // directly (NOT the pane adapter) via the "slayzone:open-extensions"
    // sentinel — so it doesn't register a phantom pane tile.
    const api = (
      window as unknown as {
        api?: { browser?: { createView(o: unknown): Promise<string> } }
      }
    ).api
    void api?.browser?.createView({
      taskId: 'extensions',
      tabId: 'extensions',
      url: 'slayzone:open-extensions',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      // Open the management window on the task's CURRENT identity, so installs
      // (1Password) land in the profile that identity's panes use.
      profileKey: profile
    })
  }

  const openDomDialog = (): void => {
    useLayoutStore.getState().openOverlay({
      id: 'demo',
      kind: 'dialog',
      render: () => (
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Demo dialog</div>
          <div style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.5 }}>
            Rendered on the overlay plane — above the panes (and, once wired, above a live native browser).
          </div>
        </div>
      )
    })
  }

  return (
    <div
      id="task-detail"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: COLORS.bg,
        color: COLORS.text,
        font: '13px ui-sans-serif, system-ui, sans-serif'
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '14px 16px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid #e0a042', flex: '0 0 auto' }} />
          <span style={{ fontSize: 20, fontWeight: 700, whiteSpace: 'nowrap' }}>Sample Task</span>
          <span style={{ fontSize: 12, color: COLORS.muted }}>· placeholder</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PanelToggle active={activeTypes} onToggle={toggle} />
          <select
            value={profile}
            onChange={(e) => onProfileChange(e.target.value)}
            title="Identity this task browses as (own Google login + 1Password)"
            style={{
              ...toggleBtnBase,
              background: COLORS.barBg,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.muted,
              appearance: 'none'
            }}
          >
            <option value="">Profile: Default</option>
            <option value="work">Profile: Work</option>
            <option value="personal">Profile: Personal</option>
          </select>
          <button
            type="button"
            onClick={openExtensions}
            style={{ ...toggleBtnBase, background: COLORS.barBg, border: `1px solid ${COLORS.border}`, color: COLORS.muted }}
          >
            Extensions
          </button>
          <button
            type="button"
            onClick={openDemoDialog}
            style={{ ...toggleBtnBase, background: COLORS.barBg, border: `1px solid ${COLORS.border}`, color: COLORS.muted }}
          >
            Open dialog
          </button>
        </div>
      </header>

      <div id="task-panels" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 16 }}>
          <LayoutRoot registry={REGISTRY} host={EMBEDDED_HOST} />
        </div>
      </div>
    </div>
  )
}
