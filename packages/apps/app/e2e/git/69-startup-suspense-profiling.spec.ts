import {
  test,
  expect,
  seed,
  resetApp,
  goHome,
  clickProject,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'working-notes',
  'performance'
)

function writePerfResults(name: string, data: unknown) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const filePath = path.join(RESULTS_DIR, `${name}.json`)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`\n📊 Results written to ${filePath}`)
}

interface MarkEntry {
  name: string
  startTime: number
}

interface StartupTimeline {
  timestamp: string
  marks: MarkEntry[]
  phases: Record<string, { startMs: number; endMs: number; durationMs: number }>
  waterfall: string[]
  summary: {
    tabStoreMs: number
    reactMountAt: number
    loadBoardDataMs: number
    dataReadyAt: number
    themeMs: number
    ptyMs: number
    appearanceMs: number
    telemetryMs: number
    appFirstRenderAt: number
    appMountedAt: number
    suspenseFallbackCount: number
    suspenseFallbackDurations: number[]
    totalStartupMs: number
  }
}

test.describe('Startup & Suspense Profiling', () => {
  const PROJ_ABBREV = 'SP'
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'StartupProf',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id

    // Seed tasks across statuses
    for (let i = 0; i < 8; i++) {
      const statuses = ['inbox', 'in_progress', 'done', 'in_progress']
      await s.createTask({ projectId, title: `Startup task ${i}`, status: statuses[i % 4] })
    }
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, PROJ_ABBREV)

    // Open 2 task tabs so Suspense boundaries fire on reload
    const tasks = await s.getTasks()
    for (const t of tasks.slice(0, 2)) {
      const card = mainWindow.getByText(t.title).first()
      if (await card.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await card.dblclick()
        await mainWindow.waitForTimeout(500)
      }
    }

    // Persist tab state so it survives reload
    await mainWindow.evaluate(() => {
      const store = (window as any).__slayzone_tabStore
      if (store) {
        const state = store.getState()
        window.getTrpcVanillaClient().settings.set.mutate({
          key: 'viewState',
          value: JSON.stringify({
            tabs: state.tabs,
            activeTabIndex: state.activeTabIndex,
            selectedProjectId: state.selectedProjectId
          })
        })
      }
    })
    await mainWindow.waitForTimeout(600) // Wait for debounced persistence
  })

  test('01 — profile startup after reload', async ({ mainWindow }) => {
    // Clear any existing marks
    await mainWindow.evaluate(() => {
      performance.clearMarks()
      performance.clearMeasures()
    })

    // Reload — this re-runs the full startup: tabStoreReady → providers → loadBoardData → dataReady
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 15_000 })

    // Wait for dataReady + Suspense resolution
    await mainWindow.waitForTimeout(3_000)

    // Collect all performance marks
    const marks: MarkEntry[] = await mainWindow.evaluate(() => {
      return performance
        .getEntriesByType('mark')
        .filter((e) => e.name.startsWith('sz:'))
        .map((e) => ({ name: e.name, startTime: Math.round(e.startTime * 100) / 100 }))
        .sort((a, b) => a.startTime - b.startTime)
    })

    console.log('\n=== STARTUP PERFORMANCE MARKS ===')
    console.log('─'.repeat(60))

    const baseline = marks.length > 0 ? marks[0].startTime : 0
    for (const m of marks) {
      const relative = Math.round((m.startTime - baseline) * 100) / 100
      console.log(`  +${String(relative).padStart(8)}ms  ${m.name}`)
    }

    // Build phases from start/end pairs
    const phases: Record<string, { startMs: number; endMs: number; durationMs: number }> = {}
    const phaseNames = ['tabStore', 'theme', 'pty', 'appearance', 'telemetry', 'loadBoardData']

    for (const phase of phaseNames) {
      const start = marks.find((m) => m.name === `sz:${phase}:start`)
      const end = marks.find((m) => m.name === `sz:${phase}:end`)
      if (start && end) {
        phases[phase] = {
          startMs: Math.round((start.startTime - baseline) * 100) / 100,
          endMs: Math.round((end.startTime - baseline) * 100) / 100,
          durationMs: Math.round((end.startTime - start.startTime) * 100) / 100
        }
      }
    }

    // Suspense fallback tracking
    const shellMounts = marks.filter((m) => m.name === 'sz:suspense:taskShell:mount')
    const shellUnmounts = marks.filter((m) => m.name === 'sz:suspense:taskShell:unmount')
    const suspenseDurations = shellMounts.map((mount, i) => {
      const unmount = shellUnmounts[i]
      return unmount ? Math.round((unmount.startTime - mount.startTime) * 100) / 100 : -1
    })

    // Key moments
    const getMarkTime = (name: string) => {
      const m = marks.find((e) => e.name === name)
      return m ? Math.round((m.startTime - baseline) * 100) / 100 : -1
    }

    const summary = {
      tabStoreMs: phases.tabStore?.durationMs ?? -1,
      reactMountAt: getMarkTime('sz:reactMount'),
      loadBoardDataMs: phases.loadBoardData?.durationMs ?? -1,
      dataReadyAt: getMarkTime('sz:dataReady'),
      themeMs: phases.theme?.durationMs ?? -1,
      ptyMs: phases.pty?.durationMs ?? -1,
      appearanceMs: phases.appearance?.durationMs ?? -1,
      telemetryMs: phases.telemetry?.durationMs ?? -1,
      appFirstRenderAt: getMarkTime('sz:app:render'),
      appMountedAt: getMarkTime('sz:app:mounted'),
      suspenseFallbackCount: shellMounts.length,
      suspenseFallbackDurations: suspenseDurations,
      totalStartupMs: getMarkTime('sz:dataReady')
    }

    // Build waterfall visualization
    const waterfall: string[] = []
    const maxTime = Math.max(...marks.map((m) => m.startTime - baseline), 1)
    const barWidth = 50

    waterfall.push(
      `${'Phase'.padEnd(22)} ${'Start'.padStart(7)} ${'Dur'.padStart(7)}  ${'Timeline'}`
    )
    waterfall.push('─'.repeat(22 + 7 + 7 + 2 + barWidth + 4))

    // Add phases as bars
    const allPhases = [
      { name: 'tabStore', label: 'Tab Store' },
      { name: 'reactMount', label: 'React Mount', point: true },
      { name: 'theme', label: 'Theme' },
      { name: 'pty', label: 'PTY Seed' },
      { name: 'appearance', label: 'Appearance' },
      { name: 'telemetry', label: 'Telemetry' },
      { name: 'loadBoardData', label: 'Load Board' },
      { name: 'dataReady', label: 'Data Ready', point: true },
      { name: 'appMounted', label: 'App Mounted', point: true }
    ]

    for (const p of allPhases) {
      if ('point' in p && p.point) {
        const time = getMarkTime(`sz:${p.name}`)
        if (time < 0) continue
        const pos = Math.round((time / maxTime) * barWidth)
        const bar = ' '.repeat(Math.max(0, pos)) + '▼'
        waterfall.push(
          `${p.label.padEnd(22)} ${String(time + 'ms').padStart(7)} ${''.padStart(7)}  |${bar}`
        )
      } else {
        const phase = phases[p.name]
        if (!phase) continue
        const startPos = Math.round((phase.startMs / maxTime) * barWidth)
        const endPos = Math.round((phase.endMs / maxTime) * barWidth)
        const len = Math.max(1, endPos - startPos)
        const bar = ' '.repeat(Math.max(0, startPos)) + '█'.repeat(len)
        waterfall.push(
          `${p.label.padEnd(22)} ${String(phase.startMs + 'ms').padStart(7)} ${String(phase.durationMs + 'ms').padStart(7)}  |${bar}`
        )
      }
    }

    // Add Suspense fallbacks
    for (let i = 0; i < shellMounts.length; i++) {
      const mountTime = Math.round((shellMounts[i].startTime - baseline) * 100) / 100
      const dur = suspenseDurations[i]
      const startPos = Math.round((mountTime / maxTime) * barWidth)
      const endPos = dur > 0 ? Math.round(((mountTime + dur) / maxTime) * barWidth) : startPos + 1
      const len = Math.max(1, endPos - startPos)
      const bar = ' '.repeat(Math.max(0, startPos)) + '░'.repeat(len)
      waterfall.push(
        `${'Suspense #' + (i + 1)}`.padEnd(22) +
          ` ${String(mountTime + 'ms').padStart(7)} ${String((dur > 0 ? dur : '?') + 'ms').padStart(7)}  |${bar}`
      )
    }

    console.log('\n=== STARTUP WATERFALL ===')
    for (const line of waterfall) console.log(line)

    console.log('\n=== SUMMARY ===')
    console.log(`  Tab Store hydration:  ${summary.tabStoreMs}ms`)
    console.log(`  React mount at:       ${summary.reactMountAt}ms`)
    console.log(`  Load board data:      ${summary.loadBoardDataMs}ms`)
    console.log(`  Data ready at:        ${summary.dataReadyAt}ms`)
    console.log(`  Theme init:           ${summary.themeMs}ms`)
    console.log(`  PTY seed:             ${summary.ptyMs}ms`)
    console.log(`  Appearance (19 IPC):  ${summary.appearanceMs}ms`)
    console.log(`  Telemetry init:       ${summary.telemetryMs}ms`)
    console.log(`  App first render at:  ${summary.appFirstRenderAt}ms`)
    console.log(`  App mounted at:       ${summary.appMountedAt}ms`)
    console.log(`  Suspense fallbacks:   ${summary.suspenseFallbackCount}`)
    if (summary.suspenseFallbackDurations.length > 0) {
      console.log(
        `  Fallback durations:   ${summary.suspenseFallbackDurations.map((d) => d + 'ms').join(', ')}`
      )
    }
    console.log(`  Total startup:        ${summary.totalStartupMs}ms`)

    const result: StartupTimeline = {
      timestamp: new Date().toISOString(),
      marks,
      phases,
      waterfall,
      summary
    }

    writePerfResults('startup-suspense-timeline', result)

    // Basic sanity: startup should complete within 5s
    if (summary.totalStartupMs > 0) {
      expect(summary.totalStartupMs).toBeLessThan(5_000)
    }
  })

  test('02 — profile task tab switch suspense', async ({ mainWindow }) => {
    // Go home first
    await goHome(mainWindow)
    await mainWindow.waitForTimeout(300)

    // Clear marks
    await mainWindow.evaluate(() => {
      performance.clearMarks()
      performance.clearMeasures()
    })

    // Open a task tab (triggers Suspense boundary)
    const s = seed(mainWindow)
    const tasks = await s.getTasks()
    if (tasks.length === 0) {
      console.log('No tasks to profile — skipping')
      return
    }

    const taskToOpen = tasks[0]
    await mainWindow.evaluate((taskId) => {
      performance.mark('sz:taskSwitch:start')
      const store = (window as any).__slayzone_tabStore
      store?.getState().openTask(taskId)
    }, taskToOpen.id)

    // Wait for Suspense to resolve
    await mainWindow.waitForTimeout(2_000)
    await mainWindow.evaluate(() => {
      performance.mark('sz:taskSwitch:end')
    })

    const marks: MarkEntry[] = await mainWindow.evaluate(() => {
      return performance
        .getEntriesByType('mark')
        .filter((e) => e.name.startsWith('sz:'))
        .map((e) => ({ name: e.name, startTime: Math.round(e.startTime * 100) / 100 }))
        .sort((a, b) => a.startTime - b.startTime)
    })

    const baseline = marks.length > 0 ? marks[0].startTime : 0

    console.log('\n=== TASK SWITCH SUSPENSE ===')
    for (const m of marks) {
      const relative = Math.round((m.startTime - baseline) * 100) / 100
      console.log(`  +${String(relative).padStart(8)}ms  ${m.name}`)
    }

    const shellMount = marks.find((m) => m.name === 'sz:suspense:taskShell:mount')
    const shellUnmount = marks.find((m) => m.name === 'sz:suspense:taskShell:unmount')
    if (shellMount && shellUnmount) {
      const dur = Math.round((shellUnmount.startTime - shellMount.startTime) * 100) / 100
      console.log(`\n  Suspense fallback visible for: ${dur}ms`)

      writePerfResults('task-switch-suspense', {
        timestamp: new Date().toISOString(),
        taskId: taskToOpen.id,
        marks,
        fallbackDurationMs: dur
      })
    } else {
      console.log('\n  No Suspense fallback triggered (data was cached)')
      writePerfResults('task-switch-suspense', {
        timestamp: new Date().toISOString(),
        taskId: taskToOpen.id,
        marks,
        fallbackDurationMs: 0,
        note: 'No fallback — data was cached'
      })
    }
  })

  test('03 — IPC waterfall during task detail fetch', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const tasks = await s.getTasks()
    if (tasks.length === 0) return

    // Measure the actual fetchTaskDetail IPC calls
    const ipcTimings = await mainWindow.evaluate(async (taskId: string) => {
      const timings: Array<{ name: string; durationMs: number }> = []
      const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const start = performance.now()
        const result = await fn()
        timings.push({ name, durationMs: Math.round((performance.now() - start) * 100) / 100 })
        return result
      }

      const totalStart = performance.now()

      // Replicate fetchTaskDetail's parallel calls
      const [task, tags, taskTags, projects, subTasks] = await Promise.all([
        time('db.getTask', () => window.getTrpcVanillaClient().task.get.query({ id: taskId })),
        time('tags.getTags', () => window.getTrpcVanillaClient().tags.list.query()),
        time('taskTags.getTagsForTask', () =>
          window.getTrpcVanillaClient().tags.getForTask.query({ taskId })
        ),
        time('db.getProjects', () => window.getTrpcVanillaClient().projects.list.query()),
        time('db.getSubTasks', () =>
          window.getTrpcVanillaClient().task.getSubTasks.query({ parentId: taskId })
        )
      ])

      // Sequential: parent task lookup
      if (task?.parent_id) {
        await time('db.getTask(parent)', () =>
          window.getTrpcVanillaClient().task.get.query({ id: task.parent_id! })
        )
      }

      const totalMs = Math.round((performance.now() - totalStart) * 100) / 100

      return {
        timings,
        totalMs,
        parallelBatchMs: Math.max(...timings.slice(0, 5).map((t) => t.durationMs))
      }
    }, tasks[0].id)

    console.log('\n=== TASK DETAIL IPC WATERFALL ===')
    console.log(
      `  Total: ${ipcTimings.totalMs}ms (parallel batch bottleneck: ${ipcTimings.parallelBatchMs}ms)`
    )
    for (const t of ipcTimings.timings) {
      const bar = '█'.repeat(Math.max(1, Math.round(t.durationMs / 2)))
      console.log(`  ${t.name.padEnd(28)} ${String(t.durationMs + 'ms').padStart(8)}  ${bar}`)
    }

    writePerfResults('task-detail-ipc-waterfall', {
      timestamp: new Date().toISOString(),
      taskId: tasks[0].id,
      ...ipcTimings
    })

    // Each IPC call should be under 50ms
    for (const t of ipcTimings.timings) {
      expect(t.durationMs).toBeLessThan(50)
    }
  })
})
