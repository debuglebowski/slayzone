/**
 * The demo hub: a SlayZone hub served inside the app, for trying the app without a hub
 * or an account (the sign-in screen's "Try demo"). It answers the app's tRPC procedures
 * and subscriptions (`inProcessLink`) and its REST routes (`http`) from the sample data
 * in `seed.ts`, through the SAME client paths a real hub is reached by
 * (`in-process-hub.ts`) — every screen is the app's own, unchanged.
 *
 * Writes work, in memory, like a hub's: creating, editing, moving and archiving tasks,
 * tags, blockers, uploading artifacts, sending chat messages (the demo answers itself,
 * `demoReply`), typing into the terminal (echoed, with a note), starting / stopping /
 * interrupting agents. Each answers the way a hub would and pushes the same events
 * (`notify.onTasksChanged`, `pty.onStateChange`, `chat.onEvent` …), so every open
 * screen follows. Nothing is kept: closing the demo drops the hub, and the next one
 * starts from the sample data again. What needs a real computer — browsing its folders,
 * choosing another computer — answers `DEMO_UNAVAILABLE`.
 *
 * Never on the network: its address is under `.invalid` (RFC 2606, never resolves), and
 * its session is never kept (`HubSession.inProcess`).
 */
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import type { ArtifactSearchReport, ArtifactSearchResult } from '@slayzone/task-artifacts/shared'
import type { CreateTaskInput, Task, TaskArtifact, UpdateTaskInput } from '@slayzone/task-contracts'
import type { AgentEvent, TerminalState } from '@slayzone/terminal-contracts'
import { isChatSupported } from '@slayzone/terminal-contracts'
import { type InProcessBackend, inProcessLink } from '@slayzone/transport/client'
import { type HubSession, hubEntryOf } from '../hub-session'
import type { InProcessHttp, InProcessHttpRequest, InProcessHttpResponse } from '../in-process-hub'
import { demoImageBytes } from './demo-image'
import {
  DEMO_COMPUTER_ID,
  DEMO_IDS,
  type DemoSeed,
  demoArtifact,
  demoProject,
  demoTask,
  hubTime,
  seedDemo
} from './seed'
import {
  DEMO_TERMINAL_SIZE,
  searchTerminalChunks,
  TERMINAL_INTERRUPTED,
  TERMINAL_PROMPT,
  TERMINAL_STARTED,
  TERMINAL_STOPPED,
  terminalNote
} from './terminal-recording'
import { authConversation, darkModeConversation, demoReply } from './transcripts'
import { type ProcOut, procedures, type SubscriptionEvent, subscriptions } from './typed'

/** The demo hub's address: never resolves (RFC 2606 `.invalid`). */
export const DEMO_HUB_ADDRESS = 'demo.invalid'
export const DEMO_HUB_ENTRY = hubEntryOf(DEMO_HUB_ADDRESS)
/** Who the demo is signed in as (Hubs → the demo hub's card). */
export const DEMO_ACCOUNT_EMAIL = 'demo@slay.zone'

/** What a demo write that needs a real hub answers. */
export const DEMO_UNAVAILABLE = 'Not available in the demo — sign in to your own hub for this.'

export interface DemoHub {
  /** The session the app opens the demo with (never kept). */
  session: HubSession
  /** Its tRPC handlers by path: what `session.inProcess.link` resolves against. */
  backend: InProcessBackend
  /** Stop what is still scheduled (a reply on its way). */
  dispose: () => void
}

export interface DemoHubOptions {
  /** The moment the sample data's times are relative to (default: now). */
  now?: number
  /** How long the demo "thinks" before answering a chat message. */
  replyDelayMs?: number
}

/** A copy of an answer, as a hub's wire would hand it over: never the state itself. */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

let nextId = 0
const newId = (kind: string): string => `demo-${kind}-${Date.now().toString(36)}-${++nextId}`

type Listener = (event: unknown) => void

/** Where the demo's agents work (the projects' folders on the demo computer). */
const FOLDERS: Record<string, string> = {
  [DEMO_IDS.api]: '~/dev/projects/api-v2',
  [DEMO_IDS.web]: '~/dev/projects/web-dashboard',
  [DEMO_IDS.infra]: '~/dev/projects/home-cloud'
}

interface ChatLog {
  taskId: string
  cwd: string
  events: Array<{ seq: number; event: AgentEvent }>
}

interface PtyBuffer {
  chunks: Array<{ seq: number; data: string }>
  /** What the user typed at the prompt, not submitted yet. */
  typed: string
}

export function openDemoHub(options: DemoHubOptions = {}): DemoHub {
  const now = options.now ?? Date.now()
  const replyDelayMs = options.replyDelayMs ?? 1200
  const seed: DemoSeed = seedDemo(now)
  const I = DEMO_IDS

  // ---- state -------------------------------------------------------------------------
  const tasks = new Map(seed.tasks.map((t) => [t.id, t]))
  const projects = seed.projects
  const taskTags = new Map(Object.entries(seed.taskTags))
  /** blocker id → the tasks it blocks */
  const blocks = new Map(Object.entries(seed.blocks).map(([k, v]) => [k, new Set(v)]))
  const tabs = [...seed.tabs]
  const states = new Map<string, TerminalState>(
    seed.sessions.map((s) => [`${s.taskId}:${s.tabId}`, s.state])
  )
  const hibernated = new Set(seed.hibernated)
  const artifacts = [...seed.artifacts]
  const folders = seed.folders
  const content = new Map(Object.entries(seed.content))
  const files = new Map<string, Uint8Array>([[I.screenshotArtifact, demoImageBytes()]])

  const folderOf = (taskId: string): string => {
    const task = tasks.get(taskId)
    return (task && FOLDERS[task.project_id]) ?? '~'
  }
  const chats = new Map<string, ChatLog>()
  const seedChat = (taskId: string, events: AgentEvent[]): void => {
    chats.set(taskId, {
      taskId,
      cwd: folderOf(taskId),
      events: events.map((event, seq) => ({ seq, event }))
    })
  }
  seedChat(I.auth, authConversation(folderOf(I.auth)))
  seedChat(I.darkMode, darkModeConversation(folderOf(I.darkMode)))

  const ptys = new Map<string, PtyBuffer>()
  ptys.set(`${I.search}:${I.search}`, {
    chunks: searchTerminalChunks(folderOf(I.search)).map((data, seq) => ({ seq, data })),
    typed: ''
  })

  // ---- pushes ------------------------------------------------------------------------
  const listeners = new Map<string, Set<Listener>>()
  const listen = (path: string, listener: Listener): (() => void) => {
    const set = listeners.get(path) ?? new Set()
    listeners.set(path, set)
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
  const emit = <P extends string>(path: P, event: SubscriptionEvent<P>): void => {
    for (const listener of [...(listeners.get(path) ?? [])]) listener(copy(event))
  }
  const tasksChanged = (taskIds: string[] | null): void =>
    emit('notify.onTasksChanged', { taskIds })

  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }

  // ---- helpers -----------------------------------------------------------------------
  const taskOrThrow = (id: string): Task => {
    const task = tasks.get(id)
    if (!task || task.deleted_at) throw new Error(`No task ${id}`)
    return task
  }
  const touch = (task: Task, fields: Partial<Task>): Task => {
    const next = { ...task, ...fields, updated_at: hubTime(Date.now()) }
    tasks.set(task.id, next)
    tasksChanged([task.id])
    return next
  }
  const blockedTaskIds = (): string[] => {
    const ids = new Set<string>()
    for (const [blocker, blocked] of blocks) {
      const b = tasks.get(blocker)
      if (!b || b.deleted_at || b.status === 'done') continue
      for (const id of blocked) ids.add(id)
    }
    for (const t of tasks.values()) if (t.is_blocked && !t.deleted_at) ids.add(t.id)
    return [...ids]
  }
  const setState = (sessionId: string, next: TerminalState): void => {
    const old = states.get(sessionId) ?? 'dead'
    if (old === next) return
    if (next === 'dead') states.delete(sessionId)
    else states.set(sessionId, next)
    emit('pty.onStateChange', { sessionId, newState: next, oldState: old })
  }
  const ptyWrite = (sessionId: string, data: string): void => {
    const buffer = ptys.get(sessionId) ?? { chunks: [], typed: '' }
    ptys.set(sessionId, buffer)
    const seq = buffer.chunks.length
    buffer.chunks.push({ seq, data })
    emit('pty.onData', { sessionId, data, seq })
  }
  const chatAppend = (tabId: string, event: AgentEvent): void => {
    const log = chats.get(tabId)
    if (!log) return
    const seq = log.events.length
    log.events.push({ seq, event })
    emit('chat.onEvent', { tabId, event, seq })
  }
  const modeOfTab = (taskId: string, tabId: string): string =>
    tabs.find((t) => t.taskId === taskId && t.id === tabId)?.mode ??
    tasks.get(taskId)?.terminal_mode ??
    'claude-chat'

  /** A chat tab's session as `chat.getInfo` answers it. */
  const chatInfo = (tabId: string): ProcOut<'chat.hydrate'> => {
    const log = chats.get(tabId)
    if (!log) throw new Error('No such chat')
    const sessionId = `${log.taskId}:${tabId}`
    return {
      sessionId,
      tabId,
      taskId: log.taskId,
      mode: modeOfTab(log.taskId, tabId),
      cwd: log.cwd,
      pid: null,
      startedAt: hubTime(now, 60),
      ended: !states.has(sessionId),
      chatMode: 'auto-accept',
      chatModel: 'opus',
      chatEffort: null,
      chatCollaboration: null
    }
  }

  /** Start a task's main agent: alive again, its tab running. */
  const startMain = (taskId: string): ProcOut<'task.startMainAgent'> => {
    const task = taskOrThrow(taskId)
    const sessionId = `${taskId}:${taskId}`
    const mode = modeOfTab(taskId, taskId)
    const kind = isChatSupported(mode) ? 'chat' : 'pty'
    const alive = states.has(sessionId)
    if (!tabs.some((t) => t.id === taskId)) ensureMainTab(taskId, task.terminal_mode)
    hibernated.delete(sessionId)
    if (kind === 'chat' && !chats.has(taskId)) seedChat(taskId, [])
    if (!alive) {
      setState(sessionId, kind === 'chat' ? 'idle' : 'running')
      if (kind === 'pty') ptyWrite(sessionId, TERMINAL_STARTED)
    }
    return {
      sessionId,
      tabId: taskId,
      mode,
      kind,
      cwd: alive ? null : folderOf(taskId),
      state: states.get(sessionId) ?? null,
      started: !alive
    }
  }
  const ensureMainTab = (taskId: string, mode: string): void => {
    if (tabs.some((t) => t.taskId === taskId && t.isMain)) return
    tabs.push({
      id: taskId,
      taskId,
      groupId: taskId,
      label: null,
      mode,
      isMain: true,
      position: 0,
      createdAt: hubTime(Date.now()),
      agentState: 'new'
    })
    emit('taskTerminals.onChanged', { taskId })
  }
  const stopSession = (sessionId: string, code: number | null): void => {
    if (!states.has(sessionId)) return
    setState(sessionId, 'dead')
    emit('pty.onExit', {
      sessionId,
      exitCode: code ?? 0,
      errorCode: null,
      exitReason: null,
      exitDetail: null
    })
  }

  /** The demo's answer to a chat message: the agent "works", then replies. */
  const replyTo = (tabId: string, text: string): void => {
    const log = chats.get(tabId)
    if (!log) return
    const sessionId = `${log.taskId}:${tabId}`
    setState(sessionId, 'running')
    chatAppend(tabId, {
      kind: 'turn-init',
      sessionId: `demo-${tabId}`,
      model: 'opus',
      cwd: log.cwd,
      tools: [],
      permissionMode: 'acceptEdits'
    })
    later(replyDelayMs, () => {
      const answer = demoReply(text)
      chatAppend(tabId, { kind: 'assistant-text', messageId: newId('text'), text: answer })
      chatAppend(tabId, {
        kind: 'result',
        subtype: 'success',
        isError: false,
        durationMs: replyDelayMs,
        durationApiMs: replyDelayMs,
        numTurns: 1,
        totalCostUsd: 0,
        stopReason: 'end_turn',
        terminalReason: null,
        text: answer,
        modelUsage: {},
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        permissionDenials: []
      })
      setState(sessionId, 'idle')
    })
  }

  const boardData = (): ProcOut<'task.loadBoardData'> => {
    const live = [...tasks.values()].filter((t) => !t.deleted_at)
    return {
      tasks: live,
      projects,
      tags: seed.tags,
      taskTags: Object.fromEntries(
        [...taskTags].filter(([id]) => tasks.get(id) && !tasks.get(id)?.deleted_at)
      ),
      blockedTaskIds: blockedTaskIds()
    } as ProcOut<'task.loadBoardData'>
  }

  // ---- tRPC: queries + mutations ------------------------------------------------------
  const unavailable = (): never => {
    throw new Error(DEMO_UNAVAILABLE)
  }

  const procs = procedures({
    // Board + tasks
    'task.loadBoardData': () => boardData(),
    'task.get': ({ id }) => tasks.get(id) ?? null,
    'task.update': (raw) => {
      const input = raw as UpdateTaskInput
      const task = taskOrThrow(input.id)
      const fields: Partial<Task> = {}
      if (input.title !== undefined) fields.title = input.title
      if (input.description !== undefined) fields.description = input.description
      if (input.status !== undefined) fields.status = input.status
      if (input.priority !== undefined) fields.priority = input.priority
      if (input.progress !== undefined) fields.progress = input.progress
      if (input.dueDate !== undefined) fields.due_date = input.dueDate
      if (input.projectId !== undefined) fields.project_id = input.projectId
      if (input.parentId !== undefined) fields.parent_id = input.parentId
      if (input.terminalMode !== undefined) fields.terminal_mode = input.terminalMode
      if (input.providerConfig !== undefined) fields.provider_config = input.providerConfig
      if (input.needsAttention !== undefined) fields.needs_attention = input.needsAttention
      if (input.isBlocked !== undefined) fields.is_blocked = input.isBlocked
      if (input.blockedComment !== undefined) fields.blocked_comment = input.blockedComment
      if (input.snoozedUntil !== undefined) fields.snoozed_until = input.snoozedUntil
      if (input.assignee !== undefined) fields.assignee = input.assignee
      if (input.pinned !== undefined) fields.pinned = input.pinned
      if (input.terminalMode !== undefined) {
        const main = tabs.find((t) => t.taskId === task.id && t.isMain)
        if (main) {
          main.mode = input.terminalMode
          emit('taskTerminals.onChanged', { taskId: task.id })
        }
      }
      return touch(task, fields)
    },
    'task.create': (raw) => {
      const input = raw as CreateTaskInput
      if (!projects.some((p) => p.id === input.projectId)) throw new Error('No such project')
      const siblings = [...tasks.values()].filter(
        (t) =>
          t.project_id === input.projectId &&
          t.parent_id === (input.parentId ?? null) &&
          t.status === (input.status ?? 'inbox')
      )
      const task = demoTask(Date.now(), {
        id: newId('task'),
        project_id: input.projectId,
        parent_id: input.parentId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? 'inbox',
        priority: input.priority ?? 3,
        due_date: input.dueDate ?? null,
        terminal_mode: input.terminalMode ?? 'claude-chat',
        order: siblings.length,
        created_at: hubTime(Date.now()),
        updated_at: hubTime(Date.now())
      })
      tasks.set(task.id, task)
      tasksChanged([task.id])
      return task
    },
    'task.delete': ({ id }) => {
      const task = taskOrThrow(id)
      touch(task, { deleted_at: hubTime(Date.now()) })
      for (const child of tasks.values()) {
        if (child.parent_id === id) touch(child, { deleted_at: hubTime(Date.now()) })
      }
      return true
    },
    'task.archive': ({ id }) => touch(taskOrThrow(id), { archived_at: hubTime(Date.now()) }),
    'task.archiveMany': ({ ids }) => {
      const at = hubTime(Date.now())
      for (const id of ids) {
        const task = tasks.get(id)
        if (task && !task.deleted_at) tasks.set(id, { ...task, archived_at: at })
      }
      tasksChanged([...ids])
    },
    'task.unarchive': ({ id }) => touch(taskOrThrow(id), { archived_at: null }),
    'task.reorder': ({ taskIds }) => {
      taskIds.forEach((id, order) => {
        const task = tasks.get(id)
        if (task) tasks.set(id, { ...task, order })
      })
      tasksChanged(taskIds)
    },
    'task.getBlockers': ({ taskId }) =>
      [...blocks]
        .filter(([, blocked]) => blocked.has(taskId))
        .map(([blocker]) => tasks.get(blocker))
        .filter((t): t is Task => t !== undefined && !t.deleted_at),
    'task.addBlocker': ({ taskId, blockerTaskId }) => {
      const set = blocks.get(blockerTaskId) ?? new Set()
      blocks.set(blockerTaskId, set)
      set.add(taskId)
      tasksChanged([taskId, blockerTaskId])
    },
    'task.removeBlocker': ({ taskId, blockerTaskId }) => {
      blocks.get(blockerTaskId)?.delete(taskId)
      tasksChanged([taskId, blockerTaskId])
    },
    'task.setBlockers': ({ taskId, blockerTaskIds }) => {
      for (const set of blocks.values()) set.delete(taskId)
      for (const blocker of blockerTaskIds) {
        const set = blocks.get(blocker) ?? new Set()
        blocks.set(blocker, set)
        set.add(taskId)
      }
      tasksChanged([taskId, ...blockerTaskIds])
    },
    'task.startMainAgent': ({ taskId }) => startMain(taskId),
    'task.resetConversation': ({ id }) => touch(taskOrThrow(id), { currentConversationByMode: {} }),
    'tags.setForTask': ({ taskId, tagIds }) => {
      taskTags.set(taskId, [...tagIds])
      tasksChanged([taskId])
    },
    'template.getByProject': () => [],
    'projects.list': () => projects,
    'projects.create': ({ name, color }) => {
      const project = demoProject(
        Date.now(),
        { id: newId('project'), name, color, sort_order: projects.length },
        `~/dev/projects/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      )
      projects.push(project)
      tasksChanged(null)
      return project
    },

    // Computers + folders (a real computer's)
    'computers.list': () => [
      {
        id: DEMO_COMPUTER_ID,
        name: 'MacBook Pro',
        platform: 'darwin',
        version: '0.36.4',
        upgradeStatus: undefined,
        capabilities: [],
        lastSeenAt: Date.now(),
        createdAt: now - 40 * 86_400_000,
        connected: true,
        usable: true,
        connectedAt: now - 3 * 3_600_000,
        revokedAt: null,
        machine: { hostId: 'demo-host', name: 'MacBook Pro (M4)' }
      }
    ],
    'computers.setProjectDefaultComputer': unavailable,
    'computers.setTaskComputer': unavailable,
    'workspace.listRoots': unavailable,
    'workspace.listDir': unavailable,
    'workspace.mkdir': unavailable,
    'workspace.setProjectPath': unavailable,
    'workspace.forgetProjectPath': unavailable,
    'worktrees.detectChildRepos': () => [],

    // Settings: the defaults (the app's default theme, following the device)
    'settings.get': () => null,
    'settings.getThemeSource': () => 'system',

    // Terminals + agents
    'taskTerminals.list': ({ taskId }) => tabs.filter((t) => t.taskId === taskId),
    'taskTerminals.ensureMain': ({ taskId, mode }) => {
      ensureMainTab(taskId, mode ?? taskOrThrow(taskId).terminal_mode)
      const main = tabs.find((t) => t.taskId === taskId && t.isMain)
      if (!main) throw new Error(`No task ${taskId}`)
      return main
    },
    'taskTerminals.listHibernatedSessions': () => [...hibernated],
    'pty.sessionList': () =>
      [...states].map(([sessionId, state]) => {
        const [taskId, tabId] = sessionId.split(':')
        return {
          sessionId,
          state,
          kind: isChatSupported(modeOfTab(taskId, tabId)) ? ('chat' as const) : ('pty' as const)
        }
      }),
    'pty.modesList': () => DEMO_MODES,
    'pty.attach': ({ sessionId }) => {
      const buffer = ptys.get(sessionId)
      return {
        exists: states.has(sessionId),
        state: states.get(sessionId) ?? null,
        buffer: buffer
          ? { chunks: buffer.chunks, currentSeq: buffer.chunks.length - 1, prelude: '' }
          : null,
        size: { ...DEMO_TERMINAL_SIZE }
      }
    },
    'pty.getBufferSince': ({ sessionId, afterSeq }) => {
      const buffer = ptys.get(sessionId)
      if (!buffer) return null
      return {
        chunks: buffer.chunks.filter((c) => c.seq > afterSeq),
        currentSeq: buffer.chunks.length - 1,
        prelude: ''
      }
    },
    'pty.write': ({ sessionId, data }) => {
      if (!states.has(sessionId)) return false
      const buffer = ptys.get(sessionId) ?? { chunks: [], typed: '' }
      ptys.set(sessionId, buffer)
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          const line = buffer.typed
          buffer.typed = ''
          ptyWrite(sessionId, line ? terminalNote() + TERMINAL_PROMPT : TERMINAL_PROMPT)
        } else if (char === '\x7f') {
          if (buffer.typed) {
            buffer.typed = buffer.typed.slice(0, -1)
            ptyWrite(sessionId, '\b \b')
          }
        } else if (char >= ' ') {
          if (!buffer.typed) ptyWrite(sessionId, TERMINAL_PROMPT)
          buffer.typed += char
          ptyWrite(sessionId, char)
        }
      }
      return true
    },
    'pty.submit': ({ sessionId, text }) => {
      if (!states.has(sessionId)) return false
      ptyWrite(sessionId, `${TERMINAL_PROMPT}${text}${terminalNote()}`)
      return true
    },
    'pty.interrupt': ({ sessionId }) => {
      if (states.get(sessionId) === 'running') {
        ptyWrite(sessionId, TERMINAL_INTERRUPTED)
        setState(sessionId, 'idle')
      }
      return true
    },
    'pty.kill': ({ sessionId }) => {
      if (states.has(sessionId)) ptyWrite(sessionId, TERMINAL_STOPPED)
      stopSession(sessionId, 0)
      return true
    },
    'pty.touch': () => true,

    // Chat
    'chat.getInfo': ({ tabId }) => (chats.has(tabId) ? chatInfo(tabId) : null),
    'chat.hydrate': ({ tabId, taskId, cwd }) => {
      if (!chats.has(tabId)) chats.set(tabId, { taskId, cwd, events: [] })
      return chatInfo(tabId)
    },
    'chat.getReplay': ({ tabId, afterSeq }) => {
      const log = chats.get(tabId)
      const events = (log?.events ?? []).filter((e) => e.seq > afterSeq)
      const last = log?.events.at(-1)?.seq ?? -1
      return { events, live: { afterSeq: last, liveSeq: 0, events: [] } }
    },
    'chat.send': (input) => {
      if (!('message' in input)) return unavailable()
      const { tabId, message } = input
      const log = chats.get(tabId)
      if (!log) throw new Error('No such chat')
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      chatAppend(tabId, { kind: 'user-message', id: message.id, text, content: message.content })
      chatAppend(tabId, { kind: 'user-message-delivery', id: message.id, state: 'delivered' })
      const task = tasks.get(log.taskId)
      if (task) touch(task, { last_interaction_at: Date.now() })
      replyTo(tabId, text)
      return { id: message.id, state: 'delivered' }
    },
    'chat.respondPermission': () => false,
    'chat.interrupt': ({ tabId }) => chatInfo(tabId),
    'chat.abortAndPop': () => ({ popped: false, text: null, id: null, content: null }),
    'chat.takeOver': ({ tabId }) => chatInfo(tabId),
    'chat.reset': ({ tabId, taskId }) => {
      const log = chats.get(tabId)
      if (log) log.events = []
      emit('chat.onEvent', {
        tabId,
        event: { kind: 'conversation-branch', reason: 'reset' },
        seq: 0
      })
      setState(`${taskId}:${tabId}`, 'idle')
      return chatInfo(tabId)
    },
    'chat.start': ({ tabId, taskId, cwd }) => {
      if (!chats.has(tabId)) chats.set(tabId, { taskId, cwd, events: [] })
      setState(`${taskId}:${tabId}`, 'idle')
      return chatInfo(tabId)
    },
    'chat.restart': ({ tabId, taskId, cwd }) => {
      if (!chats.has(tabId)) chats.set(tabId, { taskId, cwd, events: [] })
      setState(`${taskId}:${tabId}`, 'idle')
      return chatInfo(tabId)
    },
    'chat.kill': ({ tabId }) => {
      const log = chats.get(tabId)
      const sessionId = log ? `${log.taskId}:${tabId}` : null
      if (!sessionId || !states.has(sessionId)) return
      setState(sessionId, 'dead')
      emit('chat.onExit', { tabId, sessionId, code: 0, signal: null })
    },
    'chat.remove': () => undefined,
    'chat.getMode': () => 'auto-accept',
    'chat.getModel': () => 'opus',
    'chat.getModels': () => [],
    'chat.getEffort': () => null,
    'chat.getCollaboration': () => null,
    'chat.getAutoEligibility': () => ({ eligible: false, optedIn: false }),
    'chat.setMode': ({ tabId }) => chatInfo(tabId),
    'chat.setModel': ({ tabId }) => chatInfo(tabId),
    'chat.setEffort': ({ tabId }) => chatInfo(tabId),
    'chat.setCollaboration': ({ tabId }) => chatInfo(tabId),
    'chat.decidePlan': unavailable,
    'chat.listSkills': () => [],
    'chat.listCommands': () => [],
    'chat.listAgents': () => [],
    'chat.getCliSnapshot': () => null,
    'chat.getCliCommandDetails': () => null,
    'chat.getAutocompleteUsage': () => ({}),
    'chat.bumpAutocompleteUsage': () => undefined,
    'chat.queue.list': () => [],
    'chat.queue.push': unavailable,
    'chat.queue.remove': () => false,
    'chat.queue.clear': () => 0,
    'chat.stopCommandTask': () => undefined,
    'chat.commandTaskOutput': () => ({ state: 'gone' }),

    // Artifacts
    'artifacts.getByTask': ({ taskId }) => artifacts.filter((a) => a.task_id === taskId),
    'artifacts.foldersGetByTask': ({ taskId }) => folders.filter((f) => f.task_id === taskId),
    'artifacts.get': ({ id }) => artifacts.find((a) => a.id === id) ?? null,
    'artifacts.readContent': ({ id }) =>
      content.get(id) ?? (artifacts.some((a) => a.id === id) ? '' : null),
    'artifacts.versionsList': () => [],
    'artifacts.versionsRead': unavailable
  })

  // ---- tRPC: subscriptions ------------------------------------------------------------
  const subs = subscriptions({
    'notify.onTasksChanged': (_input, push) => listen('notify.onTasksChanged', push as Listener),
    'notify.onSettingsChanged': (_input, push) =>
      listen('notify.onSettingsChanged', push as Listener),
    'settings.onThemeChanged': (_input, push) =>
      listen('settings.onThemeChanged', push as Listener),
    'computers.onStatusChange': (_input, push) =>
      listen('computers.onStatusChange', push as Listener),
    'taskTerminals.onChanged': (_input, push) =>
      listen('taskTerminals.onChanged', push as Listener),
    'pty.onStateChange': (_input, push) => listen('pty.onStateChange', push as Listener),
    'pty.onExit': (_input, push) => listen('pty.onExit', push as Listener),
    'pty.onBackgroundJobs': (_input, push) => listen('pty.onBackgroundJobs', push as Listener),
    'pty.onHibernated': (_input, push) => listen('pty.onHibernated', push as Listener),
    'pty.onResize': (_input, push) => listen('pty.onResize', push as Listener),
    // The demo's computer never goes offline: a subscription with nothing to say.
    'pty.onOutputAvailability': (_input, push) =>
      listen('pty.onOutputAvailability', push as Listener),
    'pty.onData': (input, push) =>
      listen('pty.onData', (event) => {
        const ids = input?.sessionIds
        if (!ids || ids.includes((event as { sessionId: string }).sessionId)) push(event as never)
      }),
    'chat.onEvent': (input, push) =>
      listen('chat.onEvent', (event) => {
        const ids = input?.tabIds
        if (!ids || ids.includes((event as { tabId: string }).tabId)) push(event as never)
      }),
    'chat.onExit': (_input, push) => listen('chat.onExit', push as Listener),
    'chat.onReplayRequired': (input, push) =>
      listen('chat.onReplayRequired', (event) => {
        if ((event as { tabId: string }).tabId === input.tabId) push(event as never)
      }),
    'chat.onQueueChanged': (_input, push) => listen('chat.onQueueChanged', push as Listener),
    'chat.onQueueDrained': (_input, push) => listen('chat.onQueueDrained', push as Listener),
    'artifacts.onContentChanged': (_input, push) =>
      listen('artifacts.onContentChanged', push as Listener)
  })

  const backend: InProcessBackend = {
    // Every answer is a copy, as a hub's wire hands it over: a screen holding an answer
    // never sees the state change under it.
    procedures: Object.fromEntries(
      Object.entries(procs).map(([path, handler]) => [
        path,
        async (input: unknown) => copy(await handler(copy(input)))
      ])
    ),
    subscriptions: subs
  }

  // ---- REST ---------------------------------------------------------------------------
  const http: InProcessHttp = async (request) => answerHttp(request)

  const answerHttp = (request: InProcessHttpRequest): InProcessHttpResponse => {
    const { path, query } = parseUrl(request.url)
    if (request.method === 'GET' && path === '/api/auth/get-session') {
      return json(200, { user: { email: DEMO_ACCOUNT_EMAIL, name: 'Demo' } })
    }
    if (request.method === 'GET' && path === '/api/artifacts/search') {
      return envelope(search(query))
    }
    const contentMatch = /^\/api\/artifacts\/([^/]+)\/content$/.exec(path)
    if (request.method === 'GET' && contentMatch) {
      const id = decodeURIComponent(contentMatch[1])
      const bytes = files.get(id)
      if (bytes) return { status: 200, body: bytes }
      const text = content.get(id)
      if (text !== undefined) return { status: 200, body: text }
      return json(404, { ok: false, error: 'No such artifact' })
    }
    if (request.method === 'POST' && path === '/api/artifacts') {
      const taskId = query.taskId
      const title = query.title
      if (!taskId || !title || !tasks.get(taskId)) {
        return json(400, { ok: false, error: 'taskId and title are required' })
      }
      const artifact: TaskArtifact = demoArtifact(Date.now(), {
        id: newId('artifact'),
        task_id: taskId,
        title,
        folder_id: query.folderId ?? null,
        order: artifacts.filter((a) => a.task_id === taskId).length,
        created_at: hubTime(Date.now()),
        updated_at: hubTime(Date.now())
      })
      artifacts.push(artifact)
      const body = request.body
      if (body instanceof Uint8Array) files.set(artifact.id, body)
      else content.set(artifact.id, body ?? '')
      tasksChanged([taskId])
      return envelope(artifact)
    }
    return json(404, { ok: false, error: DEMO_UNAVAILABLE })
  }

  const search = (query: Record<string, string>): ArtifactSearchReport => {
    const q = (query.q ?? '').trim()
    const caseSensitive = query.caseSensitive === '1'
    const norm = (s: string) => (caseSensitive ? s : s.toLowerCase())
    const needle = norm(q)
    const scope = artifacts.filter(
      (a) => (query.taskId ? a.task_id === query.taskId : true) && !tasks.get(a.task_id)?.deleted_at
    )
    const results: ArtifactSearchResult[] = []
    for (const artifact of scope) {
      const matches: ArtifactSearchResult['matches'] = []
      if (query.contentOnly !== '1' && norm(artifact.title).includes(needle)) {
        matches.push({ type: 'title', snippet: artifact.title })
      }
      if (query.titlesOnly !== '1') {
        const lines = (content.get(artifact.id) ?? '').split('\n')
        lines.forEach((text, at) => {
          if (needle && norm(text).includes(needle)) {
            matches.push({ type: 'content', line: at + 1, snippet: text })
          }
        })
      }
      if (matches.length > 0) {
        results.push({
          artifactId: artifact.id,
          taskId: artifact.task_id,
          title: artifact.title,
          matches
        })
      }
    }
    return { results, scannedCount: scope.length, truncated: false, skippedLarge: [] }
  }

  return {
    session: {
      entry: DEMO_HUB_ENTRY,
      token: 'demo',
      inProcess: { link: inProcessLink(backend), http }
    },
    backend,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      listeners.clear()
    }
  }
}

/** The agent modes the demo offers (the provider picker). */
const DEMO_MODES: ProcOut<'pty.modesList'> = [
  { id: 'claude-chat', label: 'Claude Code (chat)', type: 'claude-chat', order: 0 },
  { id: 'claude-code', label: 'Claude Code', type: 'claude-code', order: 1 },
  { id: 'codex-chat', label: 'Codex (chat)', type: 'codex-chat', order: 2 },
  { id: 'codex', label: 'Codex', type: 'codex', order: 3 }
].map((m) => ({ ...m, enabled: true, isBuiltin: true }))

function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const withoutOrigin = url.replace(/^[a-z]+:\/\/[^/]+/i, '')
  const [path, search = ''] = withoutOrigin.split('?')
  const query: Record<string, string> = {}
  for (const pair of search.split('&')) {
    if (!pair) continue
    const [key, value = ''] = pair.split('=')
    query[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '))
  }
  return { path, query }
}

const json = (status: number, body: unknown): InProcessHttpResponse => ({
  status,
  body: JSON.stringify(body)
})
const envelope = (data: unknown): InProcessHttpResponse => json(200, { ok: true, data })

/** The demo hub's REST base, as the app derives it (`hubUrlFromAddr`). */
export const DEMO_HUB_HTTP_URL = hubUrlFromAddr(DEMO_HUB_ADDRESS, 'http')
