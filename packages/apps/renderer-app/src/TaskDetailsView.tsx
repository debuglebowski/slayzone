// TaskDetailsView — now driven by @slayzone/layout. Same look as before (title
// header + panel-toggle bar + horizontal panes) but powered by the recursive
// layout tree, with working divider resize, a native-pane seam (no-op host),
// localStorage persistence, and an overlay-plane demo dialog.
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  closeExtensionsModal,
  createEmbeddedTabHost,
  listExtensions,
  onExtensionsChanged,
  onNewView,
  openExtensionOptions,
  openExtensionPopup,
  openExtensionsModal,
  registerBrowserAdoption,
  setEmbeddedProfileKey,
  setExtensionsModalBounds,
  type ExtensionInfo
} from './embedded-tab-host'
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

// The id of the pane that holds a tile of `type` (so a new view can be inserted
// there as a sibling tab). Null if no such tile is open.
function findPaneIdOfType(node: LayoutNode | null, type: TileType): string | null {
  if (!node) return null
  if (isPane(node)) return node.tiles.some((t) => t.type === type) ? node.id : null
  if (isSplit(node)) {
    for (const child of node.children) {
      const found = findPaneIdOfType(child, type)
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
  const [extOpen, setExtOpen] = useState(false)

  // A page in a browser pane opened a new view (window.open / target=_blank):
  // open it as a new browser TAB in the browser pane, bound to the host's
  // already-created view (adoption), and foreground it.
  useEffect(() => {
    return onNewView(({ viewId, url }) => {
      const store = useLayoutStore.getState()
      const tile = makeTile('browser')
      const paneId = findPaneIdOfType(store.tree.root, 'browser')
      registerBrowserAdoption(tile.id, viewId, url)
      store.openTile(paneId, tile)
      if (paneId) store.setActiveTab(paneId, tile.id)
    })
  }, [])

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
    // Open the extensions modal: a real SlayZone modal (scrim + themed card +
    // header) whose body is a chromeless, borderless, child browser window
    // (Web Store / chrome://extensions + native install prompts) pinned to the
    // card's body rect. Opened on the task's CURRENT identity, so installs
    // (1Password) land in the profile that identity's panes use.
    setExtOpen(true)
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

      {extOpen && <ExtensionsModal profileKey={profile} onClose={() => setExtOpen(false)} />}
    </div>
  )
}

// Extensions modal — a real SlayZone modal whose body is the chromeless inlay
// window. The scrim + header pill + body panel are drawn here (React, in the
// shell); the native inlay window is pinned over the body panel's screen rect
// (reported via getBoundingClientRect → host → child-window bounds). Header and
// body are separate rounded panels so the inlay's uniform rounded corners (mac
// applies a single radius) line up with a rounded content panel, with the
// title/switch/close in a pill above it.
const segBtn: CSSProperties = { ...toggleBtnBase, padding: '5px 10px' }
const MODAL_MAX_W = 1600

// The modal's single active selection — the segmented control treats Web Store,
// Manage, and each extension as mutually-exclusive tabs (one is highlighted).
type ExtSelected =
  | { kind: 'store' }
  | { kind: 'manage' }
  | { kind: 'ext'; id: string; mode: 'popup' | 'options' }

// One icon in the header's extension toolbar. Loads the real extension icon
// from chrome://extension-icon; falls back to a letter avatar if it can't load.
// The icon opens the extension's popup (its action UI, e.g. the 1Password
// vault); a small gear opens its settings/options page when it has one.
function ExtIcon({
  ext,
  active,
  onPopup,
  onOptions
}: {
  ext: ExtensionInfo
  active: boolean
  onPopup: () => void
  onOptions: () => void
}) {
  const [broken, setBroken] = useState(false)
  // Primary action: popup if it has one, else settings, else nothing.
  const primary = ext.hasPopup ? onPopup : ext.hasOptions ? onOptions : undefined
  return (
    <div style={{ position: 'relative', width: 28, height: 28, flex: '0 0 auto' }}>
      <button
        type="button"
        onClick={primary}
        disabled={!primary}
        title={ext.hasPopup ? ext.name : ext.hasOptions ? `${ext.name} — settings` : `${ext.name} (no UI)`}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 7,
          cursor: primary ? 'pointer' : 'default',
          background: active ? COLORS.activeBg : 'transparent',
          padding: 0,
          opacity: primary ? 1 : 0.5
        }}
      >
        {broken ? (
          <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.muted }}>
            {ext.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img
            src={`chrome://extension-icon/${ext.id}/32/1`}
            alt={ext.name}
            width={20}
            height={20}
            style={{ borderRadius: 5 }}
            onError={() => setBroken(true)}
          />
        )}
      </button>
      {ext.hasOptions && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOptions()
          }}
          title={`${ext.name} settings`}
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 14,
            height: 14,
            borderRadius: 7,
            border: `1px solid ${COLORS.border}`,
            background: COLORS.bg,
            color: COLORS.muted,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            lineHeight: 1,
            padding: 0
          }}
        >
          ⚙
        </button>
      )}
    </div>
  )
}

function ExtensionsModal({ profileKey, onClose }: { profileKey: string; onClose: () => void }) {
  const [selected, setSelected] = useState<ExtSelected>({ kind: 'store' })
  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Switching identity resets the active tab to the Web Store.
  useEffect(() => setSelected({ kind: 'store' }), [profileKey])

  // List the identity's installed extensions for the toolbar.
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void listExtensions(profileKey).then((list) => {
        if (alive) setExts(list)
      })
    }
    refresh()
    // Live updates: the host pushes a change event on install/uninstall so a
    // freshly-installed extension appears without reopening the modal.
    const unsub = onExtensionsChanged(refresh)
    return () => {
      alive = false
      unsub()
    }
  }, [profileKey])

  // Pin the inlay window under the body panel. Open on mount / view-switch;
  // re-publish bounds on resize + for a short burst (scrim fade / layout settle).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const box = (): { x: number; y: number; width: number; height: number } => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    }
    // Navigate the inlay to the active selection. Web Store/Manage open (or
    // reuse) the inlay; an extension selection navigates the already-open inlay
    // to its popup (icon) or options page (gear).
    if (selected.kind === 'ext') {
      if (selected.mode === 'options') openExtensionOptions(selected.id)
      else openExtensionPopup(selected.id)
    } else {
      openExtensionsModal(box(), profileKey, selected.kind)
    }
    const ro = new ResizeObserver(() => setExtensionsModalBounds(box()))
    ro.observe(el)
    const onWin = (): void => setExtensionsModalBounds(box())
    window.addEventListener('resize', onWin)
    let raf = 0
    let n = 0
    const tick = (): void => {
      setExtensionsModalBounds(box())
      if (++n < 20) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      cancelAnimationFrame(raf)
    }
  }, [profileKey, selected])

  // Tear the inlay window down when the modal unmounts.
  useEffect(() => () => closeExtensionsModal(), [])

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const panelBase: CSSProperties = {
    width: '100%',
    maxWidth: MODAL_MAX_W,
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '4vh 4vw',
        background: 'rgba(0,0,0,0.5)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...panelBase,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '6px 10px',
          borderRadius: 10
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, flex: '0 0 auto' }}>Extensions</span>
        {/* Centered control: Web Store | Manage, with the identity's extensions
            appended on the right (click → popup, ⚙ → settings). */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 3,
            borderRadius: 8,
            background: COLORS.barBg,
            border: `1px solid ${COLORS.border}`,
            maxWidth: '70%',
            minWidth: 0
          }}
        >
          {(['store', 'manage'] as const).map((v) => {
            const on = selected.kind === v
            return (
              <button
                key={v}
                type="button"
                onClick={() => setSelected({ kind: v })}
                style={{ ...segBtn, flex: '0 0 auto', background: on ? COLORS.activeBg : 'transparent', color: on ? COLORS.text : COLORS.muted }}
              >
                {v === 'store' ? 'Web Store' : 'Manage'}
              </button>
            )
          })}
          {exts.length > 0 && (
            <>
              <div style={{ width: 1, height: 18, background: COLORS.border, flex: '0 0 auto', margin: '0 2px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', minWidth: 0 }}>
                {exts.map((e) => (
                  <ExtIcon
                    key={e.id}
                    ext={e}
                    active={selected.kind === 'ext' && selected.id === e.id}
                    onPopup={() => setSelected({ kind: 'ext', id: e.id, mode: 'popup' })}
                    onOptions={() => setSelected({ kind: 'ext', id: e.id, mode: 'options' })}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        <button type="button" onClick={onClose} style={{ ...segBtn, color: COLORS.muted, flex: '0 0 auto' }}>
          ✕
        </button>
      </div>

      {/* The chromeless inlay window is pinned over this full-width panel. */}
      <div
        ref={bodyRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: MODAL_MAX_W,
          flex: 1,
          minHeight: 0,
          borderRadius: 12,
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          overflow: 'hidden'
        }}
      />
    </div>
  )
}
