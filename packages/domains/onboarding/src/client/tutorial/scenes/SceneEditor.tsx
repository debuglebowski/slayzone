import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileCode, Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

const c = {
  kw: 'text-blue-400',
  type: 'text-teal-400 dark:text-teal-300',
  str: 'text-amber-400',
  fn: 'text-purple-400',
  dim: 'text-muted-foreground/60',
  base: 'text-foreground/90',
  comment: 'text-green-600/70 dark:text-green-500/60'
}

const CODE = [
  [
    { text: 'import', color: c.kw },
    { text: ' jwt ', color: c.base },
    { text: 'from', color: c.kw },
    { text: " 'jsonwebtoken'", color: c.str }
  ],
  [
    { text: 'import', color: c.kw },
    { text: ' { Request, Response } ', color: c.base },
    { text: 'from', color: c.kw },
    { text: " 'express'", color: c.str }
  ],
  [],
  [
    { text: 'const', color: c.kw },
    { text: ' SECRET = process.env.JWT_SECRET', color: c.base },
    { text: '!', color: c.dim }
  ],
  [],
  [{ text: '// Verify JWT on protected routes', color: c.comment }],
  [
    { text: 'export function', color: c.kw },
    { text: ' ', color: c.base },
    { text: 'authMiddleware', color: c.fn },
    { text: '(req, res, next) {', color: c.dim }
  ],
  [
    { text: '  const', color: c.kw },
    { text: ' token = req.headers.authorization', color: c.base },
    { text: '?.', color: c.dim },
    { text: 'split', color: c.fn },
    { text: "(', ')[1]", color: c.dim }
  ],
  [
    { text: '  ', color: c.base },
    { text: 'if', color: c.kw },
    { text: ' (!token) {', color: c.base }
  ],
  [
    { text: '    res.', color: c.base },
    { text: 'status', color: c.fn },
    { text: '(401).', color: c.dim },
    { text: 'json', color: c.fn },
    { text: '({', color: c.dim },
    { text: " error: 'Unauthorized'", color: c.str },
    { text: ' })', color: c.dim }
  ],
  [
    { text: '    ', color: c.base },
    { text: 'return', color: c.kw }
  ],
  [{ text: '  }', color: c.dim }],
  [
    { text: '  ', color: c.base },
    { text: 'const', color: c.kw },
    { text: ' payload = jwt.', color: c.base },
    { text: 'verify', color: c.fn },
    { text: '(token, SECRET)', color: c.dim }
  ],
  [
    { text: '  next', color: c.fn },
    { text: '()', color: c.dim }
  ],
  [{ text: '}', color: c.dim }]
]

function EditorPanel(): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex bg-surface-1"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* File tree — full height */}
      <div className="w-48 shrink-0 border-r p-3 flex flex-col gap-0.5 text-[14px] overflow-hidden">
        <div className="flex items-center gap-2 py-1 text-muted-foreground/80">
          <ChevronDown className="size-4 shrink-0" />
          <FolderOpen className="size-4 text-blue-400 shrink-0" />
          <span className="truncate">src</span>
        </div>
        <div className="flex items-center gap-2 py-1 pl-6 text-muted-foreground/80">
          <ChevronDown className="size-4 shrink-0" />
          <FolderOpen className="size-4 text-blue-400 shrink-0" />
          <span className="truncate">middleware</span>
        </div>
        <div className="flex items-center gap-2 py-1 pl-12 bg-muted/50 rounded text-foreground font-medium">
          <FileCode className="size-4 text-blue-400 shrink-0" />
          <span className="truncate">auth.ts</span>
        </div>
        <div className="flex items-center gap-2 py-1 pl-6 text-muted-foreground/80">
          <ChevronRight className="size-4 shrink-0" />
          <Folder className="size-4 text-blue-400 shrink-0" />
          <span className="truncate">routes</span>
        </div>
        <div className="flex items-center gap-2 py-1 pl-6 text-muted-foreground/60">
          <FileCode className="size-4 text-muted-foreground/40 shrink-0" />
          <span className="truncate">index.ts</span>
        </div>
        <div className="flex items-center gap-2 py-1 text-muted-foreground/60">
          <FileCode className="size-4 text-muted-foreground/40 shrink-0" />
          <span className="truncate">package.json</span>
        </div>
        <div className="flex items-center gap-2 py-1 text-muted-foreground/60">
          <FileCode className="size-4 text-muted-foreground/40 shrink-0" />
          <span className="truncate">tsconfig.json</span>
        </div>
      </div>

      {/* Tab bar + code area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-12 shrink-0 flex items-center border-b">
          <div className="h-full px-6 flex items-center gap-3 border-r text-[16px] font-medium">
            <FileCode className="size-5 text-blue-400" />
            auth.ts
          </div>
        </div>
        <div className="flex-1 overflow-hidden font-mono text-[16px] leading-[28px] flex">
          <div className="w-12 shrink-0 flex flex-col items-end pr-3 pt-3 text-muted-foreground/30 select-none">
            {CODE.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <div className="flex-1 pt-3 pl-3 overflow-hidden">
            {CODE.map((tokens, i) => (
              <div key={i} className="whitespace-pre">
                {tokens.map((t, j) => (
                  <span key={j} className={t.color}>
                    {t.text}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export function SceneEditor(): React.JSX.Element {
  const [showEditor, setShowEditor] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShowEditor(true), 2000)
    return () => clearTimeout(t)
  }, [])

  return (
    <SceneShell tabs={[{ label: 'Set up auth', active: true, dot: true }]}>
      <TaskHeader
        title="Set up authentication"
        panels={panelButtons('Terminal', ...(showEditor ? (['Editor'] as const) : []))}
      />

      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal — full width initially, shrinks when editor opens */}
        <div
          className={`${showEditor ? 'w-2/5' : 'flex-1'} shrink-0 rounded-xl border overflow-hidden flex flex-col bg-neutral-950 transition-all duration-300`}
        >
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        {/* Editor — appears after click */}
        <AnimatePresence>{showEditor && <EditorPanel />}</AnimatePresence>
      </div>
      <AnimatedCursor
        waypoints={[
          { x: '50%', y: '50%', delay: 0.5, click: false },
          { x: '62%', y: '10%', delay: 1.8 }
        ]}
      />
    </SceneShell>
  )
}
