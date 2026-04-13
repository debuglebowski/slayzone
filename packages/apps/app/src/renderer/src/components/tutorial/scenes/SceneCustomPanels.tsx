import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal, Globe, FileCode, GitBranch, SlidersHorizontal, RefreshCw, Trash2, Pencil, X } from 'lucide-react'
import { useShortcutDisplay } from '@slayzone/ui'
import { SceneShell } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

function Toggle({ on }: { on: boolean }): React.JSX.Element {
  return (
    <div className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors duration-200 ${on ? 'bg-primary' : 'bg-muted-foreground/20'}`}>
      <motion.div
        className="w-4 h-4 rounded-full bg-white shadow-sm"
        animate={{ x: on ? 16 : 0 }}
        transition={{ duration: 0.2 }}
      />
    </div>
  )
}

function Kbd({ children }: { children: string }): React.JSX.Element {
  return <span className="text-[11px] text-muted-foreground/40 bg-muted px-1.5 py-0.5 rounded font-mono">{children}</span>
}

const SIDEBAR_TABS = ['General', 'Appearance', 'Panels', 'Tags', 'Import & Export', 'Telemetry', 'Labs', 'About']

const NATIVE_PANELS = [
  { icon: Terminal, label: 'Terminal', shortcutId: 'panel-terminal' },
  { icon: Globe, label: 'Browser', shortcutId: 'panel-browser' },
  { icon: FileCode, label: 'Editor', shortcutId: 'panel-editor' },
  { icon: GitBranch, label: 'Diff', shortcutId: 'panel-git-diff' },
  { icon: SlidersHorizontal, label: 'Settings', shortcutId: 'panel-settings' },
]

function NativePanelRow({ icon: Icon, label, shortcutId }: { icon: typeof Terminal; label: string; shortcutId: string }): React.JSX.Element {
  const shortcut = useShortcutDisplay(shortcutId)
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-surface-1">
      <Icon className="size-4 text-muted-foreground/50 shrink-0" />
      <span className="text-[13px] font-medium flex-1">{label}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
      <Toggle on />
    </div>
  )
}

const EXTERNAL_PANELS = [
  { label: 'Figma', url: 'https://figma.com', shortcut: '⌘Y' },
  { label: 'Notion', url: 'https://notion.so', shortcut: '⌘N' },
  { label: 'GitHub', url: 'https://github.com', shortcut: '⌘H' },
  { label: 'Excalidraw', url: 'https://excalidraw.com', shortcut: '⌘X' },
]

function SettingsView({ figmaOn, excalidrawOn }: { figmaOn: boolean; excalidrawOn: boolean }): React.JSX.Element {
  const getEnabled = (label: string): boolean => {
    if (label === 'Figma') return figmaOn
    if (label === 'Excalidraw') return excalidrawOn
    return false
  }

  return (
    <div className="w-full h-full flex bg-surface-0 rounded-2xl overflow-hidden">
      {/* Left sidebar */}
      <div className="w-44 shrink-0 border-r flex flex-col p-3 gap-0.5">
        <div className="px-3 py-2 mb-2">
          <span className="text-[16px] font-semibold">Settings</span>
        </div>
        {SIDEBAR_TABS.map((tab) => (
          <div
            key={tab}
            className={`px-3 py-1.5 rounded text-[13px] ${
              tab === 'Panels'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground/60'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
        {/* Native section */}
        <div>
          <h3 className="text-[15px] font-semibold">Native</h3>
          <p className="text-[12px] text-muted-foreground/40 mt-0.5">Built-in panels. Disabled panels won't appear in any task.</p>
          <div className="flex flex-col gap-1.5 mt-3">
            {NATIVE_PANELS.map((p) => (
              <NativePanelRow key={p.label} icon={p.icon} label={p.label} shortcutId={p.shortcutId} />
            ))}
          </div>
        </div>

        {/* External section */}
        <div>
          <h3 className="text-[15px] font-semibold">External</h3>
          <p className="text-[12px] text-muted-foreground/40 mt-0.5">Web views embedded as panels inside tasks.</p>
          <div className="flex flex-col gap-1.5 mt-3">
            {EXTERNAL_PANELS.map(({ label, url, shortcut }) => (
              <div key={label} className="flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-surface-1">
                <Globe className="size-4 text-muted-foreground/50 shrink-0" />
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-[11px] text-muted-foreground/30 flex-1">{url}</span>
                <Trash2 className="size-3.5 text-muted-foreground/20 shrink-0" />
                <Pencil className="size-3.5 text-muted-foreground/20 shrink-0" />
                <Kbd>{shortcut}</Kbd>
                <Toggle on={getEnabled(label)} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Close button */}
      <div className="absolute top-4 right-4">
        <X className="size-5 text-muted-foreground/30" />
      </div>
    </div>
  )
}

function WebPanelHeader({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="h-10 shrink-0 border-b flex items-center gap-2 px-3 bg-muted/20">
      <Globe className="size-4 text-muted-foreground/50" />
      <span className="text-[13px] font-medium truncate">{name}</span>
      <div className="flex-1" />
      <RefreshCw className="size-3.5 text-muted-foreground/30" />
    </div>
  )
}

function FigmaPanel(): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-surface-1"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
    >
      <WebPanelHeader name="Figma" />
      <div className="flex-1 flex bg-neutral-100 dark:bg-neutral-900 overflow-hidden">
        {/* Left toolbar */}
        <div className="w-10 shrink-0 border-r bg-neutral-200 dark:bg-neutral-800 flex flex-col items-center gap-2 pt-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="w-5 h-5 rounded bg-neutral-300 dark:bg-neutral-700" />
          ))}
        </div>
        {/* Canvas */}
        <div className="flex-1 relative p-4">
          {/* Frame 1 */}
          <div className="absolute top-6 left-6 w-[55%] h-[40%] border-2 border-blue-400 rounded-lg bg-white dark:bg-neutral-800 p-3">
            <div className="text-[10px] text-blue-400 font-medium mb-2">Login Page</div>
            <div className="w-3/4 h-2 rounded bg-neutral-200 dark:bg-neutral-700 mb-2" />
            <div className="w-1/2 h-2 rounded bg-neutral-200 dark:bg-neutral-700 mb-3" />
            <div className="w-full h-6 rounded bg-blue-500/20 border border-blue-400/30" />
            <div className="w-full h-6 rounded bg-blue-500/20 border border-blue-400/30 mt-1.5" />
            <div className="w-full h-6 rounded bg-blue-500 mt-2" />
          </div>
          {/* Frame 2 */}
          <div className="absolute bottom-6 right-4 w-[40%] h-[35%] border-2 border-purple-400 rounded-lg bg-white dark:bg-neutral-800 p-3">
            <div className="text-[10px] text-purple-400 font-medium mb-2">Dashboard</div>
            <div className="flex gap-1 mb-2">
              <div className="flex-1 h-8 rounded bg-neutral-100 dark:bg-neutral-700" />
              <div className="flex-1 h-8 rounded bg-neutral-100 dark:bg-neutral-700" />
              <div className="flex-1 h-8 rounded bg-neutral-100 dark:bg-neutral-700" />
            </div>
            <div className="w-full h-4 rounded bg-neutral-100 dark:bg-neutral-700" />
          </div>
        </div>
        {/* Right panel */}
        <div className="w-12 shrink-0 border-l bg-neutral-200 dark:bg-neutral-800 flex flex-col items-center gap-2 pt-3">
          <div className="w-5 h-5 rounded bg-neutral-300 dark:bg-neutral-700" />
          <div className="w-5 h-5 rounded bg-neutral-300 dark:bg-neutral-700" />
        </div>
      </div>
    </motion.div>
  )
}

function ExcalidrawPanel(): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-surface-1"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: 0.1 }}
    >
      <WebPanelHeader name="Excalidraw" />
      <div className="flex-1 relative bg-white dark:bg-neutral-900 overflow-hidden">
        {/* Top toolbar */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 h-8 flex items-center gap-1 px-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 border shadow-sm">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="w-6 h-6 rounded bg-neutral-200 dark:bg-neutral-700" />
          ))}
        </div>
        {/* Hand-drawn shapes */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 300">
          {/* Rectangle - hand drawn style */}
          <rect x="60" y="60" width="120" height="80" rx="3" fill="none" stroke="#1e88e5" strokeWidth="2" strokeDasharray="none" />
          <text x="95" y="105" fill="#1e88e5" fontSize="11" fontFamily="sans-serif">Auth Flow</text>
          {/* Arrow */}
          <path d="M180 100 L240 100" fill="none" stroke="#666" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
          <defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#666" /></marker></defs>
          {/* Diamond */}
          <polygon points="300,70 340,100 300,130 260,100" fill="none" stroke="#e67e22" strokeWidth="2" />
          <text x="282" y="104" fill="#e67e22" fontSize="9" fontFamily="sans-serif">Valid?</text>
          {/* Circle */}
          <circle cx="120" cy="210" r="35" fill="none" stroke="#27ae60" strokeWidth="2" />
          <text x="98" y="214" fill="#27ae60" fontSize="10" fontFamily="sans-serif">JWT</text>
          {/* Arrow down */}
          <path d="M120 140 L120 175" fill="none" stroke="#666" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
          {/* Dotted connector */}
          <path d="M155 210 L260 100" fill="none" stroke="#999" strokeWidth="1" strokeDasharray="4,4" />
        </svg>
      </div>
    </motion.div>
  )
}

function TaskView({ showPanels }: { showPanels: boolean }): React.JSX.Element {
  const panels = [
    { icon: Terminal, label: 'Terminal', always: true },
    { icon: Globe, label: 'Figma', always: false },
    { icon: Globe, label: 'Excalidraw', always: false },
  ]

  return (
    <>
      {/* Custom task header with web panels */}
      <div className="h-16 shrink-0 border-b flex items-center justify-between px-6">
        <h2 className="text-[20px] font-semibold truncate">Set up authentication</h2>
        <div className="flex items-center gap-1">
          {panels.filter((p) => p.always || showPanels).map(({ icon: Icon, label }) => (
            <div key={label} className="h-10 px-3 rounded flex items-center gap-2 text-[16px] bg-muted text-foreground">
              <Icon className="size-5" />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal */}
        <div className={`${showPanels ? 'w-1/3' : 'flex-1'} shrink-0 rounded-xl border overflow-hidden flex flex-col bg-neutral-950 transition-all duration-300`}>
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        <AnimatePresence>
          {showPanels && (
            <>
              <FigmaPanel />
              <ExcalidrawPanel />
            </>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

export function SceneCustomPanels(): React.JSX.Element {
  const [figmaOn, setFigmaOn] = useState(false)
  const [excalidrawOn, setExcalidrawOn] = useState(false)
  const [showModal, setShowModal] = useState(true)

  useEffect(() => {
    const t1 = setTimeout(() => setFigmaOn(true), 2500)
    const t2 = setTimeout(() => setExcalidrawOn(true), 4000)
    const t3 = setTimeout(() => setShowModal(false), 5000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])

  return (
    <SceneShell tabs={[{ label: 'Set up auth', active: true, dot: true }]}>
      <TaskView showPanels={!showModal} />

      {/* Settings modal overlay */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            className="absolute inset-0 z-10 flex items-center justify-center"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50 rounded-2xl" />
            {/* Modal */}
            <motion.div
              className="relative w-[85%] h-[80%] rounded-xl border shadow-2xl overflow-hidden"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2 }}
            >
              <SettingsView figmaOn={figmaOn} excalidrawOn={excalidrawOn} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showModal && (
        <AnimatedCursor waypoints={[
          { x: '50%', y: '50%', delay: 0.5, click: false },
          { x: '88%', y: '48%', delay: 2.3 },
          { x: '88%', y: '62%', delay: 3.8 },
        ]} />
      )}
    </SceneShell>
  )
}
