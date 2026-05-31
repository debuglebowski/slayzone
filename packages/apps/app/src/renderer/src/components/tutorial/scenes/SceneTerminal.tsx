import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVisibleInterval } from '@slayzone/ui'
import { Sparkles, ChevronDown, Plus, Calendar, Archive, Trash2 } from 'lucide-react'
import { SceneShell, TaskHeader, panelButtons } from './SceneShell'

// Phases of the terminal animation
// 1. Banner (instant)
// 2. Pause, then user types prompt char-by-char
// 3. Pause, then Claude streams response lines

const USER_PROMPT = 'Set up JWT auth middleware'
const TYPING_SPEED = 45 // ms per character
const PHASE_PAUSE = 600 // ms between phases
const LINE_INTERVAL = 260 // ms between response lines

interface ResponseLine {
  text: string
  color: string
}

const RESPONSE_LINES: ResponseLine[] = [
  { text: "I'll set up JWT authentication middleware.", color: 'text-neutral-300' },
  { text: 'Let me start by reading your route files.', color: 'text-neutral-300' },
  { text: '', color: '' },
  { text: '  Read src/routes/index.ts', color: 'text-blue-400' },
  { text: '  Read src/middleware/', color: 'text-blue-400' },
  { text: '', color: '' },
  { text: '  Write src/middleware/auth.ts', color: 'text-blue-400' },
  { text: "   + import jwt from 'jsonwebtoken'", color: 'text-green-400/70' },
  { text: '   + export function authenticate(…) {', color: 'text-green-400/70' },
  { text: '   +   …', color: 'text-green-400/70' },
  { text: '', color: '' },
  { text: '  Edit src/routes/index.ts', color: 'text-blue-400' },
  { text: "   - app.use('/api/user', handler)", color: 'text-red-400/70' },
  { text: "   + app.use('/api/user', auth, handler)", color: 'text-green-400/70' }
]

export function SceneTerminal(): React.JSX.Element {
  // phase: 'banner' → 'typing' → 'response'
  const [phase, setPhase] = useState<'banner' | 'typing' | 'response'>('banner')
  const [typedChars, setTypedChars] = useState(0)
  const [visibleLines, setVisibleLines] = useState(0)

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('typing'), PHASE_PAUSE)
    return () => clearTimeout(t1)
  }, [])

  const typedCharsRef = useRef(0)
  useEffect(() => {
    if (phase === 'typing') typedCharsRef.current = 0
  }, [phase])
  useVisibleInterval(
    () => {
      typedCharsRef.current += 1
      setTypedChars(typedCharsRef.current)
      if (typedCharsRef.current >= USER_PROMPT.length) {
        setTimeout(() => setPhase('response'), PHASE_PAUSE)
      }
    },
    TYPING_SPEED,
    { enabled: phase === 'typing' && typedChars < USER_PROMPT.length }
  )

  const visibleLinesRef = useRef(0)
  useEffect(() => {
    if (phase === 'response') visibleLinesRef.current = 0
  }, [phase])
  useVisibleInterval(
    () => {
      visibleLinesRef.current += 1
      setVisibleLines(visibleLinesRef.current)
    },
    LINE_INTERVAL,
    { enabled: phase === 'response' && visibleLines < RESPONSE_LINES.length }
  )

  const showCursor = phase === 'banner' || phase === 'typing'

  return (
    <SceneShell
      tabs={[{ label: 'Set up auth', active: true, dot: true }, { label: 'Build kanban' }]}
    >
      <TaskHeader title="Set up authentication" panels={panelButtons('Terminal', 'Settings')} />

      {/* Panels area */}
      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        {/* Terminal card — left */}
        <div className="flex-1 rounded-xl border overflow-hidden flex flex-col bg-neutral-950">
          <div className="h-12 shrink-0 border-b border-white/10 flex items-center px-4 gap-3">
            <div className="flex items-center gap-2 h-8 px-3 rounded bg-primary/20 shrink-0">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-[16px] text-primary font-semibold">claude-code</span>
            </div>
          </div>
          <div className="flex-1 p-4 font-mono overflow-hidden flex flex-col gap-0">
            {/* Banner */}
            <div className="mb-2">
              <div className="flex items-start gap-3">
                <pre className="text-[12px] leading-[14px] text-[#e4845b] shrink-0 select-none">
                  {' ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝'}
                </pre>
                <div className="flex flex-col pt-[2px]">
                  <span className="text-[16px] text-white font-bold">
                    Claude Code <span className="text-neutral-500 font-normal">v2.1.56</span>
                  </span>
                  <span className="text-[14px] text-neutral-500">Opus 4.6 · Claude Team</span>
                  <span className="text-[14px] text-neutral-500">~/dev/projects/slayzone</span>
                </div>
              </div>
            </div>

            {/* Separator + prompt */}
            <div className="h-[2px] bg-neutral-700 my-2" />
            <div className="flex items-center gap-0">
              <span className="text-[18px] text-neutral-500 mr-2">❯</span>
              {phase === 'banner' ? (
                <span className="text-[16px] text-neutral-600 italic">
                  Try &quot;edit TaskDetailPage.tsx to...&quot;
                </span>
              ) : (
                <>
                  <span className="text-[18px] text-white">{USER_PROMPT.slice(0, typedChars)}</span>
                  {showCursor && (
                    <motion.span
                      className="inline-block w-[10px] h-[22px] bg-white/70 ml-[2px]"
                      animate={{ opacity: [1, 0, 1] }}
                      transition={{ duration: 0.9, repeat: Infinity }}
                    />
                  )}
                </>
              )}
            </div>
            <div className="h-[2px] bg-neutral-700 my-2" />
            {phase === 'banner' && (
              <span className="text-[14px] text-neutral-600"> ? for shortcuts</span>
            )}

            {/* Response lines */}
            {phase === 'response' && (
              <div className="flex flex-col mt-3">
                <AnimatePresence initial={false}>
                  {RESPONSE_LINES.slice(0, visibleLines).map((line, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.08 }}
                      className={`text-[17px] leading-[30px] ${line.color}`}
                    >
                      {line.text || '\u200B'}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>

        {/* Settings panel card — right */}
        <motion.div
          className="w-1/4 shrink-0 rounded-xl border overflow-hidden flex flex-col bg-surface-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          <div className="flex-1 p-6 flex flex-col overflow-y-auto">
            <div className="relative rounded-lg border min-h-[96px] p-4 mb-4">
              <span className="text-[15px] text-muted-foreground/40">Add description...</span>
              <Sparkles className="size-5 text-muted-foreground/30 absolute bottom-3 right-3" />
            </div>

            <div className="border-t pt-3">
              <div className="flex items-center gap-2 py-2">
                <ChevronDown className="size-5 text-muted-foreground/50" />
                <span className="text-[16px] font-medium">Sub-tasks</span>
              </div>
              <div className="flex items-center gap-2 py-2 pl-7">
                <Plus className="size-4 text-muted-foreground/40" />
                <span className="text-[14px] text-muted-foreground/40">Add subtask</span>
              </div>
            </div>

            <div className="flex-1" />

            <div className="space-y-3">
              {[
                { label: 'Project', value: 'SlayZone', dot: 'bg-green-500' },
                { label: 'Status', value: 'In Progress' },
                { label: 'Priority', value: 'Medium' }
              ].map((field) => (
                <div key={field.label}>
                  <span className="text-[14px] text-muted-foreground/50">{field.label}</span>
                  <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center justify-between px-3">
                    <div className="flex items-center gap-2">
                      {field.dot && (
                        <span className={`w-3 h-3 rounded-full ${field.dot} shrink-0`} />
                      )}
                      <span className="text-[14px] font-medium">{field.value}</span>
                    </div>
                    <ChevronDown className="size-4 text-muted-foreground/40" />
                  </div>
                </div>
              ))}

              <div>
                <span className="text-[14px] text-muted-foreground/50">Due Date</span>
                <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center gap-2 px-3">
                  <Calendar className="size-4 text-muted-foreground/40" />
                  <span className="text-[14px] text-muted-foreground/40">No date</span>
                </div>
              </div>

              <div>
                <span className="text-[14px] text-muted-foreground/50">Tags</span>
                <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center px-3">
                  <span className="text-[14px] text-muted-foreground/40">None</span>
                </div>
              </div>

              <div>
                <span className="text-[14px] text-muted-foreground/50">Blocked By</span>
                <div className="h-10 mt-1 rounded border bg-muted/30 flex items-center justify-center px-3">
                  <span className="text-[14px] font-medium">Add blocker</span>
                </div>
              </div>

              <div className="pt-3">
                <span className="text-[13px] font-semibold text-muted-foreground/40 uppercase tracking-wide">
                  Danger Zone
                </span>
                <div className="flex gap-2 mt-2">
                  <div className="flex-1 h-9 rounded border bg-muted/30 flex items-center justify-center gap-1">
                    <Archive className="size-4 text-muted-foreground/60" />
                    <span className="text-[13px] font-medium">Archive</span>
                  </div>
                  <div className="flex-1 h-9 rounded border bg-muted/30 flex items-center justify-center gap-1">
                    <Trash2 className="size-4 text-red-400" />
                    <span className="text-[13px] font-medium text-red-400">Delete</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </SceneShell>
  )
}
