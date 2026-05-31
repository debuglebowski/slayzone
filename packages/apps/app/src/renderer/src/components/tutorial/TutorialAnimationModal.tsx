import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Dialog, DialogContent, Button, cn, useVisibleInterval } from '@slayzone/ui'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { SceneProjects } from './scenes/SceneProjects'
import { SceneOpenTask } from './scenes/SceneOpenTask'
import { SceneTerminal } from './scenes/SceneTerminal'
import { SceneEditor } from './scenes/SceneEditor'
import { SceneBrowser } from './scenes/SceneBrowser'
import { SceneGit } from './scenes/SceneGit'
import { SceneProcesses } from './scenes/SceneProcesses'
import { SceneCustomPanels } from './scenes/SceneCustomPanels'

interface TutorialStep {
  title: string
  subtitle: string
  Component: () => React.JSX.Element
  /** Scene duration in ms. Defaults to 6000. */
  duration?: number
}

interface TutorialTab {
  id: string
  label: string
  category: string
  steps: TutorialStep[]
}

const TABS: TutorialTab[] = [
  {
    id: 'projects',
    label: 'Projects',
    category: 'Home',
    steps: [
      {
        title: 'Work across multiple projects',
        subtitle: 'Switch between projects — each with its own kanban board and tasks.',
        Component: SceneProjects
      }
    ]
  },
  {
    id: 'open-task',
    label: 'Open task',
    category: 'Home',
    steps: [
      {
        title: 'Open a task to start working',
        subtitle: 'Each task opens with an AI terminal and its own workspace.',
        Component: SceneOpenTask
      }
    ]
  },
  {
    id: 'terminal',
    label: 'Terminal',
    category: 'Task',
    steps: [
      {
        title: 'AI terminals, per task',
        subtitle: 'Each task gets its own AI terminal — Claude Code, Codex, Gemini, and more.',
        Component: SceneTerminal
      }
    ]
  },
  {
    id: 'browser',
    label: 'Browser',
    category: 'Task',
    steps: [
      {
        title: 'Preview right next to your terminal',
        subtitle: 'Built-in browser panel — see your changes without leaving the app.',
        Component: SceneBrowser
      }
    ]
  },
  {
    id: 'git',
    label: 'Git',
    category: 'Task',
    steps: [
      {
        title: 'Git & worktrees',
        subtitle: 'Manage branches, review diffs, and commit — all from within the task.',
        Component: SceneGit
      }
    ]
  },
  {
    id: 'processes',
    label: 'Processes',
    category: 'Task',
    steps: [
      {
        title: 'Background processes',
        subtitle: 'Run dev servers, watchers, and scripts — scoped to each task or global.',
        Component: SceneProcesses
      }
    ]
  },
  {
    id: 'editor',
    label: 'Editor',
    category: 'Task',
    steps: [
      {
        title: 'Code editor built in',
        subtitle: 'Edit files directly in the app — no context switching.',
        Component: SceneEditor
      }
    ]
  },
  {
    id: 'custom-panels',
    label: 'Custom panels',
    category: 'Settings',
    steps: [
      {
        title: 'Add your own panels',
        subtitle: 'Enable Figma, Excalidraw, or any web app — right next to your terminal.',
        Component: SceneCustomPanels,
        duration: 10000
      }
    ]
  }
]

const slideEase = [0.25, 0.46, 0.45, 0.94] as const

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 48 : -48, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { duration: 0.12, ease: slideEase, delay: 0.06 } },
  exit: (dir: number) => ({
    x: dir > 0 ? -48 : 48,
    opacity: 0,
    transition: { duration: 0.12, ease: slideEase }
  })
}

interface Props {
  open: boolean
  onClose: () => void
}

export function TutorialAnimationModal({ open, onClose }: Props): React.JSX.Element | null {
  const [tabIndex, setTabIndex] = useState(0)
  const [stepIndex, setStepIndex] = useState(0)
  const [direction, setDirection] = useState(1)
  const [cycle, setCycle] = useState(0)
  const [sceneScale, setSceneScale] = useState(1)

  useEffect(() => {
    if (!open) return
    const update = (): void => {
      // 368px = sidebar w-68 (272) + p-12 padding (96)
      const scaleW = (window.innerWidth * 0.9 - 368) / 1440
      // 200px ≈ p-12 padding (96) + caption (~70) + timer (~10) + margin
      const scaleH = (window.innerHeight * 0.9 - 200) / 1080
      setSceneScale(Math.max(Math.min(scaleW, scaleH, 1), 0.15))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])

  useEffect(() => {
    if (open) {
      setTabIndex(0)
      setStepIndex(0)
      setDirection(1)
      setCycle(0)
    }
  }, [open])

  // Replay scene animations on the same interval as the timer bar
  const cycleDur = TABS[tabIndex].steps[stepIndex].duration ?? 6000
  useVisibleInterval(() => setCycle((c) => c + 1), cycleDur, { enabled: open })

  const currentTab = TABS[tabIndex]
  const currentStep = currentTab.steps[stepIndex]
  const { Component, title, subtitle } = currentStep
  const sceneDuration = currentStep.duration ?? 6000

  const isLastStep = stepIndex === currentTab.steps.length - 1
  const isLastTab = tabIndex === TABS.length - 1
  const isEnd = isLastStep && isLastTab

  const goNext = (): void => {
    if (!isLastStep) {
      setDirection(1)
      setStepIndex((s) => s + 1)
    } else if (!isLastTab) {
      setDirection(1)
      setTabIndex((t) => t + 1)
      setStepIndex(0)
    } else {
      onClose()
    }
  }

  const goBack = (): void => {
    if (stepIndex > 0) {
      setDirection(-1)
      setStepIndex((s) => s - 1)
    } else if (tabIndex > 0) {
      setDirection(-1)
      const prevTab = TABS[tabIndex - 1]
      setTabIndex((t) => t - 1)
      setStepIndex(prevTab.steps.length - 1)
    }
  }

  const jumpToTab = (i: number): void => {
    setDirection(i > tabIndex ? 1 : -1)
    setTabIndex(i)
    setStepIndex(0)
  }

  const isAtStart = tabIndex === 0 && stepIndex === 0

  // Unique key so AnimatePresence re-mounts on tab, step, or cycle change
  const sceneKey = `${tabIndex}-${stepIndex}-${cycle}`

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent
        className="!w-auto !max-w-[90vw] !max-h-[90vh] !h-auto p-0 overflow-hidden bg-surface-1 border shadow-2xl"
        showCloseButton={false}
      >
        <div className="flex p-12">
          {/* Tab cards — grouped by category */}
          <div className="w-68 shrink-0 flex flex-col pr-12 gap-0 overflow-y-auto">
            {(() => {
              const groups = TABS.reduce<{ category: string; indices: number[] }[]>(
                (acc, tab, i) => {
                  const last = acc[acc.length - 1]
                  if (last && last.category === tab.category) {
                    last.indices.push(i)
                  } else {
                    acc.push({ category: tab.category, indices: [i] })
                  }
                  return acc
                },
                []
              )
              return groups.map(({ category, indices }) => (
                <div key={category} className="mb-5">
                  <div className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-3 pt-1 pb-1.5">
                    {category}
                  </div>
                  <div className="flex flex-col gap-1">
                    {indices.map((i) => (
                      <button
                        key={TABS[i].id}
                        onClick={() => jumpToTab(i)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap',
                          i === tabIndex
                            ? 'bg-background border shadow-sm text-foreground'
                            : 'bg-background/50 border border-transparent text-muted-foreground hover:text-foreground hover:bg-background/80'
                        )}
                      >
                        {TABS[i].label}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            })()}
          </div>

          {/* Right side: caption + scene + controls */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Caption + controls row */}
            <div className="shrink-0 pb-4 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="wait">
                  {(title || subtitle) && (
                    <motion.div
                      key={sceneKey + '-caption'}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18 }}
                    >
                      {title && <h3 className="text-2xl font-semibold tracking-tight">{title}</h3>}
                      {subtitle && (
                        <p className="text-base text-muted-foreground mt-1">{subtitle}</p>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  onClick={goBack}
                  disabled={isAtStart}
                  className="text-muted-foreground gap-1"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </Button>
                <Button onClick={goNext} className="gap-1">
                  {isEnd ? 'Get started' : 'Next'}
                  {!isEnd && <ChevronRight className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            {/* Scene area — rendered at 1440px design size, scaled to fit */}
            <div className="relative overflow-hidden">
              <div
                className="mx-auto overflow-hidden"
                style={{
                  width: 1440 * sceneScale,
                  height: 1080 * sceneScale
                }}
              >
                <div
                  className="w-[1440px] flex flex-col items-center origin-top-left"
                  style={{ aspectRatio: '4 / 3', transform: `scale(${sceneScale})` }}
                >
                  {/* Monitor frame — static */}
                  <div className="w-full flex-1 min-h-0 rounded-2xl overflow-hidden shadow-2xl bg-neutral-700 flex flex-col p-[5px]">
                    <div className="flex-1 min-h-0 rounded-xl overflow-hidden relative">
                      <AnimatePresence mode="popLayout" custom={direction}>
                        <motion.div
                          key={`${tabIndex}-${stepIndex}`}
                          custom={direction}
                          variants={slideVariants}
                          initial="enter"
                          animate="center"
                          exit="exit"
                          className="absolute inset-0"
                        >
                          <motion.div
                            key={cycle}
                            className="w-full h-full"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: [0, 1, 1, 0] }}
                            transition={{
                              duration: sceneDuration / 1000,
                              times: [0, 0.033, 0.967, 1],
                              ease: 'linear'
                            }}
                          >
                            <Component />
                          </motion.div>
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Timer bar */}
            <div className="shrink-0 w-1/2 mx-auto h-[2px] mt-2 rounded-full bg-muted/30">
              <motion.div
                key={sceneKey + '-timer'}
                className="h-full bg-muted-foreground/40 rounded-full"
                initial={{ width: '0%' }}
                animate={{ width: '100%' }}
                transition={{ duration: sceneDuration / 1000, ease: 'linear' }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
