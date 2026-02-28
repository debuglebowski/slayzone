import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { GitBranch, GitCommit } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'
import { AnimatedCursor } from './AnimatedCursor'
import { TerminalBanner } from './TerminalBanner'

interface FileTreeEntry {
  name: string
  indent: number
  folder?: boolean
  status?: '?' | 'M'
  added?: number
  removed?: number
}

const FILE_TREE: FileTreeEntry[] = [
  { name: 'src/middleware', indent: 0, folder: true },
  { name: 'auth.ts', indent: 1, status: '?', added: 42 },
  { name: 'src/routes', indent: 0, folder: true },
  { name: 'index.ts', indent: 1, status: 'M', added: 3, removed: 1 },
  { name: 'package.json', indent: 0, status: 'M', added: 1, removed: 0 },
]

interface DiffLine {
  old?: number
  new?: number
  text: string
  type: 'context' | 'add' | 'remove' | 'hunk'
}

const DIFF_CONTENT: DiffLine[] = [
  { old: undefined, new: undefined, text: '@@ -0,0 +1,14 @@', type: 'hunk' },
  { old: undefined, new: 1, text: "+import jwt from 'jsonwebtoken'", type: 'add' },
  { old: undefined, new: 2, text: "+import { Request, Response } from 'express'", type: 'add' },
  { old: undefined, new: 3, text: '+', type: 'add' },
  { old: undefined, new: 4, text: '+const SECRET = process.env.JWT_SECRET!', type: 'add' },
  { old: undefined, new: 5, text: '+', type: 'add' },
  { old: undefined, new: 6, text: '+export function authMiddleware(req, res, next) {', type: 'add' },
  { old: undefined, new: 7, text: "+  const token = req.headers.authorization?.split(' ')[1]", type: 'add' },
  { old: undefined, new: 8, text: '+  if (!token) {', type: 'add' },
  { old: undefined, new: 9, text: "+    res.status(401).json({ error: 'Unauthorized' })", type: 'add' },
  { old: undefined, new: 10, text: '+    return', type: 'add' },
  { old: undefined, new: 11, text: '+  }', type: 'add' },
  { old: undefined, new: 12, text: '+  const payload = jwt.verify(token, SECRET)', type: 'add' },
  { old: undefined, new: 13, text: '+  next()', type: 'add' },
  { old: undefined, new: 14, text: '+}', type: 'add' },
]

const COMMITS = [
  { msg: 'feat: add auth middleware for protected routes', hash: 'a3f82c1', time: '2 minutes ago' },
  { msg: 'feat: add JWT token verification', hash: 'e91b4d7', time: '15 minutes ago' },
  { msg: 'chore: install jsonwebtoken dependency', hash: '7c2e9f0', time: '18 minutes ago' },
  { msg: 'feat: create express route scaffolding', hash: 'b5d1a83', time: '1 hour ago' },
  { msg: 'chore: initial project setup', hash: 'f4a0c62', time: '2 hours ago' },
]

function GeneralTab(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      {/* Branch */}
      <div>
        <span className="text-[12px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Branch</span>
        <div className="mt-1.5 h-10 rounded border bg-muted/20 flex items-center gap-2 px-3">
          <GitBranch className="size-4 text-muted-foreground/60" />
          <span className="text-[14px] font-medium">feat/auth-middleware</span>
        </div>
      </div>

      {/* Worktree */}
      <div>
        <span className="text-[12px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Worktree</span>
        <div className="mt-1.5 h-10 rounded border bg-muted/20 flex items-center gap-2 px-3">
          <span className="text-muted-foreground/60">+</span>
          <span className="text-[14px] font-medium">Add Worktree</span>
        </div>
      </div>

      {/* Current changes */}
      <div>
        <span className="text-[12px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Current Changes</span>
        <div className="mt-1.5 h-10 rounded border bg-muted/20 flex items-center gap-2 px-3">
          <span className="text-[13px] font-semibold text-green-500 bg-green-500/10 px-2 py-0.5 rounded">1 staged</span>
          <span className="text-[13px] font-semibold text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded">3 modified</span>
          <span className="text-[13px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded">1 untracked</span>
        </div>
      </div>

      {/* Recent commits */}
      <div>
        <span className="text-[12px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Recent Commits</span>
        <div className="mt-1.5 rounded border bg-muted/20 overflow-hidden">
          {COMMITS.map((c, i) => (
            <div key={c.hash} className={`flex items-start gap-3 px-3 py-2.5 ${i > 0 ? 'border-t border-border/50' : ''}`}>
              <GitCommit className="size-4 text-muted-foreground/40 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{c.msg}</p>
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">{c.hash} · {c.time}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DiffTab(): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex min-h-0">
        {/* File tree */}
        <div className="w-[200px] shrink-0 border-r overflow-y-auto">
          <div className="px-3 py-2 text-[11px] text-muted-foreground/50 uppercase tracking-wider flex items-center justify-between">
            <span>Unstaged (3)</span>
            <span className="text-muted-foreground/30">+</span>
          </div>
          {FILE_TREE.map((f, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 px-3 py-1 text-[12px] ${'folder' in f ? 'text-muted-foreground/60' : ''}`}
              style={{ paddingLeft: 12 + f.indent * 16 }}
            >
              {'folder' in f ? (
                <>
                  <span className="text-muted-foreground/40">{'>'}</span>
                  <span className="truncate">{f.name}</span>
                </>
              ) : (
                <>
                  <span className={`font-bold w-3 shrink-0 ${f.status === '?' ? 'text-green-500' : 'text-yellow-500'}`}>{f.status}</span>
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="text-green-500 shrink-0">+{f.added}</span>
                  {'removed' in f && (f.removed ?? 0) > 0 && <span className="text-red-400 shrink-0">-{f.removed}</span>}
                </>
              )}
            </div>
          ))}
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-y-auto font-mono text-[12px] leading-[20px]">
          {DIFF_CONTENT.map((line, i) => {
            const bg = line.type === 'add' ? 'bg-green-500/10' : line.type === 'remove' ? 'bg-red-500/10' : line.type === 'hunk' ? 'bg-blue-500/10' : ''
            const color = line.type === 'add' ? 'text-green-400' : line.type === 'remove' ? 'text-red-400' : line.type === 'hunk' ? 'text-blue-400/60' : 'text-foreground/70'
            return (
              <div key={i} className={`flex ${bg} whitespace-pre`}>
                <span className="w-8 shrink-0 text-right pr-1 text-muted-foreground/25 select-none">{line.old ?? ''}</span>
                <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/25 select-none">{line.new ?? ''}</span>
                <span className={color}>{line.text}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Commit box */}
      <div className="border-t p-3 flex flex-col gap-2">
        <div className="h-10 rounded border bg-muted/20 px-3 flex items-center">
          <span className="text-[13px] text-muted-foreground/40">Commit message</span>
        </div>
        <div className="h-9 rounded bg-primary flex items-center justify-center">
          <span className="text-[13px] font-medium text-primary-foreground">Commit</span>
        </div>
      </div>
    </div>
  )
}

function GitPanel({ diffActive }: { diffActive: boolean }): React.JSX.Element {
  return (
    <motion.div
      className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-background"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="h-12 shrink-0 border-b flex items-center px-4 gap-1">
        <div className={`h-8 px-3 rounded text-[14px] font-medium flex items-center ${!diffActive ? 'bg-muted text-foreground' : 'text-muted-foreground/60'}`}>
          General
        </div>
        <div className={`h-8 px-3 rounded text-[14px] font-medium flex items-center ${diffActive ? 'bg-muted text-foreground' : 'text-muted-foreground/60'}`}>
          Diff
        </div>
      </div>

      <AnimatePresence mode="wait">
        {diffActive ? (
          <motion.div key="diff" className="flex-1 flex flex-col min-h-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <DiffTab />
          </motion.div>
        ) : (
          <motion.div key="general" className="flex-1 flex flex-col min-h-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <GeneralTab />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export function SceneGit(): React.JSX.Element {
  const [showGit, setShowGit] = useState(false)
  const [diffActive, setDiffActive] = useState(false)

  useEffect(() => {
    const t1 = setTimeout(() => setShowGit(true), 2000)
    const t2 = setTimeout(() => setDiffActive(true), 4000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  return (
    <SceneShell tabs={[{ label: 'Set up auth', active: true, dot: true }]}>
      <TaskHeader title="Set up authentication" panels={panelButtons('Terminal', ...(showGit ? ['Git'] as const : []))} />

      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal — full width initially, shrinks when git opens */}
        <div className={`${showGit ? 'w-2/5' : 'flex-1'} shrink-0 rounded-xl border overflow-hidden flex flex-col bg-neutral-950 transition-all duration-300`}>
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <TerminalBanner />
        </div>

        {/* Git panel — appears after click */}
        <AnimatePresence>
          {showGit && <GitPanel diffActive={diffActive} />}
        </AnimatePresence>
      </div>
      <AnimatedCursor waypoints={[
        { x: '50%', y: '50%', delay: 0.5, click: false },
        { x: '78%', y: '10%', delay: 1.8 },
        { x: '53%', y: '17%', delay: 3.8 },
      ]} />
    </SceneShell>
  )
}
