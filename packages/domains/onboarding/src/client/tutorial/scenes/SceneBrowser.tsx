import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ArrowRight, RefreshCw, Lock } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

function UnderConstructionPage(): React.JSX.Element {
  return (
    <div className="w-full h-full bg-white flex flex-col overflow-hidden">
      {/* Half-built nav */}
      <div className="h-14 border-b border-dashed border-neutral-300 flex items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500" />
          <span className="text-[16px] font-bold text-neutral-800">MyApp</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-12 h-3 rounded bg-neutral-100" />
          <div className="w-12 h-3 rounded bg-neutral-100" />
          <div className="h-8 w-20 rounded-lg border-2 border-dashed border-neutral-300" />
        </div>
      </div>

      {/* Hero — real text, incomplete styling */}
      <div className="px-6 pt-8">
        <h1 className="text-[24px] font-bold text-neutral-800 leading-tight">
          Build faster with
          <br />
          modern tooling
        </h1>
        <p className="text-[13px] text-neutral-400 mt-2 max-w-[300px]">
          Ship products your users love. Get started in minutes with our developer platform.
        </p>
        <div className="flex gap-3 mt-4">
          <div className="h-10 px-5 rounded-lg bg-blue-500 flex items-center">
            <span className="text-[13px] font-semibold text-white">Get started</span>
          </div>
          <div className="h-10 px-5 rounded-lg border-2 border-dashed border-neutral-300 flex items-center">
            <span className="text-[13px] text-neutral-300">TODO: docs link</span>
          </div>
        </div>
      </div>

      {/* Feature cards — two done, one still a skeleton */}
      <div className="px-6 pt-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-neutral-200 p-4">
          <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center text-[16px]">
            ⚡
          </div>
          <p className="text-[13px] font-semibold text-neutral-800 mt-2">Lightning fast</p>
          <p className="text-[11px] text-neutral-400 mt-1">
            Sub-millisecond response times with edge deployment.
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 p-4">
          <div className="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center text-[16px]">
            🔒
          </div>
          <p className="text-[13px] font-semibold text-neutral-800 mt-2">Secure by default</p>
          <p className="text-[11px] text-neutral-400 mt-1">
            Enterprise-grade security built into every layer.
          </p>
        </div>
        <div className="rounded-xl border-2 border-dashed border-neutral-200 p-4 flex flex-col items-center justify-center">
          <span className="text-[11px] text-neutral-300 italic">need copy</span>
        </div>
      </div>

      {/* Image placeholder — missing hero image */}
      <div className="mx-6 mt-5 flex-1 rounded-xl bg-neutral-50 border-2 border-dashed border-neutral-200 flex items-center justify-center">
        <span className="text-[12px] text-neutral-300">hero-screenshot.png</span>
      </div>

      <div className="h-3" />
    </div>
  )
}

function BrowserPanel(): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex flex-col"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="h-14 shrink-0 border-b flex items-center gap-3 px-4 bg-muted/20">
        <div className="flex items-center gap-1">
          <ArrowLeft className="size-5 text-muted-foreground/40" />
          <ArrowRight className="size-5 text-muted-foreground/40" />
          <RefreshCw className="size-5 text-muted-foreground/60" />
        </div>
        <div className="flex-1 h-8 rounded bg-surface-1 border flex items-center gap-2 px-3">
          <Lock className="size-4 text-muted-foreground/40 shrink-0" />
          <span
            className="text-[15px] text-muted-foreground/70"
            style={{ fontFamily: 'monospace' }}
          >
            localhost:5173
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <UnderConstructionPage />
      </div>
    </motion.div>
  )
}

export function SceneBrowser(): React.JSX.Element {
  const [showBrowser, setShowBrowser] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShowBrowser(true), 2000)
    return () => clearTimeout(t)
  }, [])

  return (
    <SceneShell tabs={[{ label: 'Set up auth', active: true, dot: true }]}>
      <TaskHeader
        title="Set up authentication"
        panels={panelButtons('Terminal', ...(showBrowser ? (['Browser'] as const) : []))}
      />

      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal — full width initially, shrinks when browser opens */}
        <div
          className={`${showBrowser ? 'w-2/5' : 'flex-1'} shrink-0 rounded-xl border overflow-hidden flex flex-col bg-neutral-950 transition-all duration-300`}
        >
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        {/* Browser — appears after click */}
        <AnimatePresence>{showBrowser && <BrowserPanel />}</AnimatePresence>
      </div>
      <AnimatedCursor
        waypoints={[
          { x: '50%', y: '50%', delay: 0.5, click: false },
          { x: '72%', y: '10%', delay: 1.8 }
        ]}
      />
    </SceneShell>
  )
}
