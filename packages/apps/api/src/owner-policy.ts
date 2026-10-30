/**
 * Which user content each `user` and `admin` tRPC procedure touches, and how the owner
 * gate (`owner-gate.ts`) keeps it to its owner on a hub that requires login (T-17).
 *
 * SAME SHAPE AS `admin-policy.ts` and `scopes.ts`: one explicit flat map keyed by
 * procedure path, cross-checked against the LIVE router in `owner-policy.test.ts`. A
 * procedure with no entry fails that test by name, and is refused at runtime on a hub
 * with login (fail closed). `open` procedures are not owner questions and have no
 * entry. `admin` ones are (T-106): the admin role decides who may MANAGE something,
 * never whose content they may read (O-6), so they are marked like any other.
 *
 * Every entry carries one MARK:
 *
 *   id-checked      the input names user content (`ids`). Each id must pass the access
 *                   function (`access.ts`) before the handler runs; one that does not
 *                   — someone else's, or missing, or ownerless — answers NOT_FOUND
 *                   with one `authz.denied` line. Some also filter their result
 *                   (`output`).
 *   list-filtered   the result, or each event of a subscription, is cut to what the
 *                   caller may access (`output` / `events`). Filtering happens on the
 *                   SERVER, never trusting a client-supplied filter.
 *   no-owned-input  names nothing a user owns (`why` says what it touches instead).
 *
 * THE DECISION is never made here: an entry only says WHERE the ids are. Whether an
 * id is accessible is `canAccess` — so sharing (T-100) changes no entry.
 *
 * Inert without login: on the desktop app's hub (`SLAYZONE_HUB_REQUIRE_LOGIN=0`) the
 * gate returns before reading this map.
 *
 * @module api/owner-policy
 */
import { currentSecurityContext } from '@slayzone/platform/security-log'
import { settingProjectId } from '@slayzone/settings-core/server'
import type { AccessScope, OwnedResource, ResourceKind } from './access'
import type { AccessClass } from './admin-policy'

export type OwnerMark = 'id-checked' | 'list-filtered' | 'no-owned-input'

/**
 * Whether a procedure, route or tool of T-15 class `cls` is an owner question: every
 * one but an `open` one. An unclassified one (undefined) is, so it fails closed.
 */
export const isOwnerQuestion = (cls: AccessClass | undefined): boolean => cls !== 'open'

/**
 * Where ids sit in the raw input. Dotted segments; `x[]` is an array (of ids, or of
 * objects when more segments follow), `x{}` a record whose KEYS are ids, and an empty
 * path the input itself. An absent or null id is skipped — the handler decides
 * whether it is required.
 */
export interface IdRef {
  readonly at: string
  readonly kind: ResourceKind
}

/** For inputs whose id kind depends on a sibling field. `sample` builds an input for
 *  one resource, so the contract test can still generate its case. */
export interface CustomRef {
  readonly pick: (raw: unknown) => OwnedResource[]
  readonly sample: { readonly kind: ResourceKind; readonly input: (id: string) => unknown }
}

export type Ref = IdRef | CustomRef

/** Rewrites a procedure's result to what the scope allows. */
export type OutputFilter = (data: unknown, scope: AccessScope) => Promise<unknown>

/** An event the subscriber must not see. */
export const DROP: unique symbol = Symbol('owner-policy.drop')

export interface StreamState {
  readonly scope: AccessScope
  /** The subscriber's user id. */
  readonly userId: string
}

/**
 * Decides one event. Runs SYNCHRONOUSLY inside the emitter's call first (so the
 * acting user is still on the async context); may return a promise for the rest.
 */
export type EventFilter = (event: unknown, state: StreamState) => unknown | Promise<unknown>

export interface OwnerRule {
  readonly mark: OwnerMark
  readonly ids?: readonly Ref[]
  /** At least one of these `at`s must be present: without one the call would act on,
   *  or create, something with no owner. */
  readonly needsOne?: readonly string[]
  readonly output?: OutputFilter
  readonly events?: EventFilter
  readonly why?: string
}

// ── building blocks ───────────────────────────────────────────────────────────

const ref =
  (kind: ResourceKind) =>
  (at: string): IdRef => ({ at, kind })
const project = ref('project')
const task = ref('task')
const tab = ref('tab')
const session = ref('session')
const path = ref('path')
const tree = ref('pathTree')
const artifact = ref('artifact')
const folder = ref('artifactFolder')
const proc = ref('process')
const tag = ref('tag')
const template = ref('template')
const aiItem = ref('aiConfigItem')
const group = ref('projectGroup')
const automation = ref('automation')
const computer = ref('computer')

const checked = (...ids: Ref[]): OwnerRule => ({ mark: 'id-checked', ids })
const listed = (output: OutputFilter): OwnerRule => ({ mark: 'list-filtered', output })
const streamed = (events: EventFilter): OwnerRule => ({ mark: 'list-filtered', events })
const none = (why: string): OwnerRule => ({ mark: 'no-owned-input', why })
const then = (rule: OwnerRule, output: OutputFilter): OwnerRule => ({ ...rule, output })

/**
 * An aggregate (a sum over rows) cannot be cut after the fact: its handler asks the
 * access scope for the caller's projects and aggregates only those
 * (`ownedProjectIds` in owner-gate.ts). The gate leaves the result as it is.
 */
export const SCOPED_IN_HANDLER: OutputFilter = async (data) => data

const res = (kind: ResourceKind, id: unknown): OwnedResource | null =>
  typeof id === 'string' && id ? { kind, id } : null

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// ── output filters ────────────────────────────────────────────────────────────

/** An array of rows, each naming its resource in `field`. A row with no value there
 *  has no owner path and is dropped — unless `keepNull` (a hub-wide row, e.g. a global
 *  AI-config item). */
const rows =
  (field: string, kind: ResourceKind, keepNull = false): OutputFilter =>
  async (data, scope) => {
    if (!Array.isArray(data)) return data
    const out: unknown[] = []
    for (const row of data) {
      const id = isRecord(row) ? row[field] : undefined
      if (id === null || id === undefined) {
        if (keepNull) out.push(row)
        continue
      }
      const r = res(kind, id)
      if (r && (await scope.allows(r))) out.push(row)
    }
    return out
  }

/** Rows of a process list: the task when set, else the project. */
const processRows: OutputFilter = async (data, scope) => {
  if (!Array.isArray(data)) return data
  const out: unknown[] = []
  for (const row of data) {
    if (!isRecord(row)) continue
    const r = res('task', row.taskId) ?? res('project', row.projectId)
    if (r && (await scope.allows(r))) out.push(row)
  }
  return out
}

/** An array of ids. */
const ids =
  (kind: ResourceKind): OutputFilter =>
  (data, scope) =>
    Array.isArray(data) ? scope.filter(data, (id) => res(kind, id)) : Promise.resolve(data)

/** A record keyed by ids. */
const keyed =
  (kind: ResourceKind): OutputFilter =>
  async (data, scope) => {
    if (!isRecord(data)) return data
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      const r = res(kind, k)
      if (r && (await scope.allows(r))) out[k] = v
    }
    return out
  }

/** One id or null: null when not accessible. */
const oneOrNull =
  (kind: ResourceKind): OutputFilter =>
  async (data, scope) => {
    const r = res(kind, data)
    return r && (await scope.allows(r)) ? data : null
  }

/** `task.loadBoardData` / `task.loadBoardRows`: the board (or a few of its rows),
 *  cut to the caller's projects. */
const board: OutputFilter = async (data, scope) => {
  if (!isRecord(data)) return data
  return {
    ...data,
    tasks: await rows('project_id', 'project')(data.tasks, scope),
    projects: await rows('id', 'project')(data.projects, scope),
    tags: await rows('project_id', 'project')(data.tags, scope),
    taskTags: await keyed('task')(data.taskTags, scope),
    blockedTaskIds: await ids('task')(data.blockedTaskIds, scope),
    ...('nextTaskIds' in data ? { nextTaskIds: await successors(data.nextTaskIds, scope) } : {})
  }
}

/** `loadBoardRows`' `nextTaskIds`: a row's successor is the next row of the WHOLE
 *  board, which may be another owner's task. An entry stays only when both its
 *  row and its successor are the caller's; a dropped entry makes the client
 *  refuse the patch and reload its (filtered) board instead. */
const successors: OutputFilter = async (data, scope) => {
  if (!isRecord(data)) return data
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(data)) {
    const row = res('task', k)
    if (!row || !(await scope.allows(row))) continue
    if (v === null) {
      out[k] = null
      continue
    }
    const next = res('task', v)
    if (next && (await scope.allows(next))) out[k] = v as string
  }
  return out
}

/** Project folders: a group shows when it is empty or holds one of the caller's
 *  projects (`projectGroup` in access.ts). Every group mutation answers a
 *  `{ projects, groups }` snapshot of the whole sidebar; both halves are cut. */
const groups: OutputFilter = async (data, scope) => {
  const cutGroups = (g: unknown) => rows('id', 'projectGroup')(g, scope)
  if (Array.isArray(data)) return cutGroups(data)
  if (!isRecord(data)) return data
  return {
    ...data,
    ...('projects' in data ? { projects: await rows('id', 'project')(data.projects, scope) } : {}),
    ...('groups' in data ? { groups: await cutGroups(data.groups) } : {})
  }
}

/** `integrations.getConnectionUsage`: which projects use a (hub-wide) connection —
 *  cut to the caller's, counts recomputed from what is left. */
const connectionUsage: OutputFilter = async (data, scope) => {
  if (!isRecord(data) || !Array.isArray(data.projects)) return data
  const projects = (await rows('project_id', 'project')(data.projects, scope)) as {
    has_mapping?: boolean
    linked_task_count?: number
  }[]
  return {
    ...data,
    projects,
    mapped_project_count: projects.filter((p) => p.has_mapping).length,
    linked_task_count: projects.reduce((n, p) => n + (p.linked_task_count ?? 0), 0)
  }
}

/**
 * A project-keyed hub setting (`ai_providers:<projectId>`, `ai_instruction_variant:…`)
 * is its project's (T-108): named by `key`, it must be accessible; in a settings map,
 * one whose project is not is cut. Every other key is the caller's own view or
 * hub-wide (T-16 `settingScope`) and passes.
 */
const settingKey = (at: string): CustomRef => ({
  pick: (raw) => {
    const key = isRecord(raw) ? raw[at] : undefined
    const r = res('project', typeof key === 'string' ? settingProjectId(key) : null)
    return r ? [r] : []
  },
  sample: { kind: 'project', input: (id) => ({ key: `ai_providers:${id}`, value: '[]' }) }
})

const settingsMap: OutputFilter = async (data, scope) => {
  if (!isRecord(data)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const r = res('project', settingProjectId(key))
    if (!r || (await scope.allows(r))) out[key] = value
  }
  return out
}

// ── event filters ─────────────────────────────────────────────────────────────

const decide = (
  r: OwnedResource | null,
  event: unknown,
  scope: AccessScope
): unknown | Promise<unknown> => {
  if (!r) return DROP
  const ok = scope.allows(r)
  return typeof ok === 'boolean' ? (ok ? event : DROP) : ok.then((y) => (y ? event : DROP))
}

/** The event names its resource in `field`; an event without one is dropped. */
const on =
  (field: string, kind: ResourceKind): EventFilter =>
  (event, { scope }) =>
    decide(isRecord(event) ? res(kind, event[field]) : null, event, scope)

/** The event IS the id. */
const onValue =
  (kind: ResourceKind): EventFilter =>
  (event, { scope }) =>
    decide(res(kind, event), event, scope)

/** The event is a snapshot keyed by ids (per-session stats): cut to the caller's. A
 *  snapshot of nothing but other users' ids is not sent at all (the samplers never send
 *  an empty one either, and every client replaces its map with the next). */
const onKeys =
  (kind: ResourceKind): EventFilter =>
  async (event, { scope }) => {
    if (!isRecord(event)) return DROP
    const out = (await keyed(kind)(event, scope)) as Record<string, unknown>
    return Object.keys(out).length > 0 ? out : DROP
  }

/** The first of these fields the event carries decides; none → dropped. */
const onFirst =
  (...fields: [string, ResourceKind][]): EventFilter =>
  (event, { scope }) => {
    if (!isRecord(event)) return DROP
    for (const [field, kind] of fields) {
      const r = res(kind, event[field])
      if (r) return decide(r, event, scope)
    }
    return DROP
  }

/**
 * A signal that names nothing (refetch pings, menu commands). Attributed to who
 * CAUSED it — the user on the async context when the emitter fired (tRPC sets it
 * for every call; `runWithSecurityContext`). Another user's → dropped. No user
 * (the hub itself: a timer, an automation, a REST call until T-18 attributes REST)
 * → delivered: the signal carries no content, and every subscriber refetches only
 * what it may see.
 */
const byActor: EventFilter = (event, { userId }) => {
  const actor = currentSecurityContext()?.actor
  return actor && actor !== userId ? DROP : event
}

/**
 * `notify.onTasksChanged`: a refetch ping attributed like {@link byActor}, which may
 * also name the changed task ids (`TasksChangedEvent`). Named ids are cut to the
 * caller's tasks — a ping naming only other users' tasks is not sent (nothing the
 * caller can see changed). `taskIds: null` (unknown scope) names nothing and passes.
 */
const tasksChangedEvents: EventFilter = async (event, state) => {
  // byActor reads the async context: call it before any await.
  if (byActor(event, state) === DROP) return DROP
  if (!isRecord(event) || !Array.isArray(event.taskIds)) return event
  const taskIds = (await ids('task')(event.taskIds, state.scope)) as unknown[]
  return taskIds.length > 0 ? { ...event, taskIds } : DROP
}

// ── reasons for `no-owned-input` ──────────────────────────────────────────────

const HOST =
  'a desktop window capability (Electron host). A hub with login runs standalone, where it is a no-op or a stub that refuses'
const HUB_CONFIG = 'hub-wide configuration with no owner column'
const LIBRARY = 'the global AI-config library and its registries: hub-wide by design'
const CONNECTION =
  'integration connections are hub-wide (no owner column); the credential is never served'
const COMPUTER =
  "computer management (metadata, lifecycle): decided in the handler — the computer's owner, or an admin (computer-access.ts, T-19)"
const SELF = "the caller's own settings or client diagnostics (T-16 scopes settings per user)"
const FEEDBACK = 'feedback threads to the SlayZone team: no owner column (hub-wide)'
const TEST = 'test-only (PLAYWRIGHT=1); refused in production'
const META = 'app or hub metadata'
const HUB_HOST = "the hub host's own CLI config (~/.claude, ~/.codex …), not a project"
const BACKUP =
  "the hub's database backups (T-101, O-22): files on the hub's disk under its state directory, which no route serves (access.ts refuses that directory as a `path`); this answers their names and sizes only, and restore is refused off the desktop's own hub"
const IMPORT = 'creates projects owned by the caller from a bundle the hub opens; reads nothing'

// ── the policy ────────────────────────────────────────────────────────────────

const taskRows = rows('project_id', 'project')
const chatOpts = checked(tab('tabId'), task('taskId'), path('cwd'))

export const TRPC_OWNER_POLICY: Record<string, OwnerRule> = {
  // ── agent lifecycle / prompts / sessions / turns ──
  'agentLifecycle.onEvent': streamed(onFirst(['taskId', 'task'], ['sessionId', 'session'])),
  'agentPrompts.list': checked(task('taskId')),
  'agentPrompts.onChanged': streamed(onValue('task')),
  'agentSessions.list': checked(task('taskId')),
  'agentSessions.onChanged': streamed(onValue('task')),
  'agentTurns.list': then(checked(path('worktreePath')), rows('task_id', 'task')),
  'agentTurns.onChanged': streamed(onValue('path')),

  // ── AI config ──
  'aiConfig.listItems': then(checked(project('projectId')), rows('project_id', 'project', true)),
  'aiConfig.getItem': checked(aiItem('id')),
  'aiConfig.createItem': checked(project('projectId')),
  'aiConfig.updateItem': checked(aiItem('id'), project('projectId')),
  'aiConfig.deleteItem': checked(aiItem('id')),
  'aiConfig.listProjectSelections': checked(project('projectId')),
  'aiConfig.setProjectSelection': checked(project('projectId'), aiItem('itemId')),
  'aiConfig.removeProjectSelection': checked(project('projectId'), aiItem('itemId')),
  'aiConfig.discoverContextFiles': checked(path('projectPath')),
  'aiConfig.getComputerFiles': none(HUB_HOST),
  'aiConfig.readContextFile': checked(path('projectPath'), path('filePath')),
  'aiConfig.writeContextFile': checked(path('projectPath'), path('filePath')),
  'aiConfig.deleteComputerFile': checked(path('filePath')),
  'aiConfig.createComputerFile': none(HUB_HOST),
  'aiConfig.writeComputerSkill': none(HUB_HOST),
  'aiConfig.getContextTree': checked(project('projectId'), path('projectPath')),
  'aiConfig.loadLibraryItem': checked(
    project('projectId'),
    path('projectPath'),
    aiItem('itemId'),
    path('manualPath')
  ),
  'aiConfig.syncLinkedFile': checked(project('projectId'), path('projectPath'), aiItem('itemId')),
  'aiConfig.unlinkFile': checked(project('projectId'), aiItem('itemId')),
  'aiConfig.renameContextFile': checked(path('projectPath'), path('oldPath'), path('newPath')),
  'aiConfig.deleteContextFile': checked(
    project('projectId'),
    path('projectPath'),
    path('filePath')
  ),
  'aiConfig.getRootInstructions': checked(project('projectId'), path('projectPath')),
  'aiConfig.getLibraryInstructions': checked(aiItem('variantId')),
  'aiConfig.saveLibraryInstructions': checked(aiItem('variantId')),
  'aiConfig.listInstructionVariants': none(LIBRARY),
  'aiConfig.getProjectInstructionVariant': checked(project('projectId')),
  'aiConfig.setProjectInstructionVariant': checked(
    project('projectId'),
    aiItem('variantItemId'),
    path('projectPath')
  ),
  'aiConfig.saveInstructionsContent': checked(project('projectId'), path('projectPath')),
  'aiConfig.saveRootInstructions': checked(project('projectId'), path('projectPath')),
  'aiConfig.readProviderInstructions': checked(path('projectPath')),
  'aiConfig.pushProviderInstructions': checked(project('projectId'), path('projectPath')),
  'aiConfig.pullProviderInstructions': checked(project('projectId'), path('projectPath')),
  'aiConfig.getProjectSkillsStatus': checked(project('projectId'), path('projectPath')),
  'aiConfig.readProviderSkill': checked(path('projectPath'), aiItem('itemId')),
  'aiConfig.getExpectedSkillContent': checked(path('projectPath'), aiItem('itemId')),
  'aiConfig.pullProviderSkill': checked(
    project('projectId'),
    path('projectPath'),
    aiItem('itemId')
  ),
  'aiConfig.listProviders': none(HUB_CONFIG),
  'aiConfig.toggleProvider': none(HUB_CONFIG),
  'aiConfig.reconcileProjectSkills': checked(project('projectId'), path('projectPath')),
  'aiConfig.getProjectProviders': checked(project('projectId')),
  'aiConfig.setProjectProviders': checked(project('projectId')),
  'aiConfig.needsSync': checked(project('projectId'), path('projectPath')),
  'aiConfig.getProjectStaleSkillCount': checked(project('projectId'), path('projectPath')),
  'aiConfig.getProjectsStaleSkillCounts': checked(project('[].projectId'), path('[].projectPath')),
  'aiConfig.syncAll': checked(project('projectId'), path('projectPath'), aiItem('itemId')),
  'aiConfig.checkSyncStatus': checked(project('projectId'), path('projectPath')),
  'aiConfig.discoverMcpConfigs': checked(path('projectPath')),
  'aiConfig.writeMcpServer': checked(path('projectPath')),
  'aiConfig.removeMcpServer': checked(path('projectPath')),
  'aiConfig.discoverComputerMcpConfigs': none(HUB_HOST),
  'aiConfig.writeComputerMcpServer': none(HUB_HOST),
  'aiConfig.removeComputerMcpServer': none(HUB_HOST),
  'aiConfig.checkSlayConfigured': checked(path('projectPath')),
  'aiConfig.setupSlay': checked(path('projectPath'), project('projectId')),
  'aiConfig.marketplace.listRegistries': none(LIBRARY),
  'aiConfig.marketplace.ensureFresh': none(LIBRARY),
  'aiConfig.marketplace.refreshRegistry': none(LIBRARY),
  'aiConfig.marketplace.refreshAll': none(LIBRARY),
  'aiConfig.marketplace.listEntries': checked(project('projectId')),
  'aiConfig.marketplace.installSkill': checked(project('projectId')),
  'aiConfig.marketplace.checkUpdates': listed(rows('itemId', 'aiConfigItem')),
  'aiConfig.marketplace.unlinkSkill': checked(aiItem('itemId')),
  'aiConfig.marketplace.updateSkill': checked(aiItem('itemId')),

  // ── app: host capabilities, export, feedback, metadata ──
  'app.clipboard.writeFilePaths': none(HOST),
  'app.clipboard.readFilePaths': none(HOST),
  'app.clipboard.hasFiles': none(HOST),
  'app.screenshot.captureView': none(HOST),
  'app.leaderboard.getLocalStats': listed(SCOPED_IN_HANDLER),
  'app.exportImport.exportProject': checked(project('projectId')),
  // O-22: the caller's own projects only (export-import.ts scopes the query); the
  // whole hub is backed up at server level, never through the app.
  'app.exportImport.exportAll': listed(SCOPED_IN_HANDLER),
  'app.exportImport.testExportAllToPath': then(checked(path('filePath')), SCOPED_IN_HANDLER),
  'app.exportImport.testExportProjectToPath': checked(project('projectId'), path('filePath')),
  'app.exportImport.testSetTaskParent': checked(task('taskId'), task('parentId')),
  'app.usage.fetch': none(HOST),
  'app.usage.test': none(HOST),
  'app.files.pathExists': checked(path('filePath')),
  'app.files.saveTempImage': none(HOST),
  'app.shell.openExternal': none('a URL to open'),
  'app.shell.openPath': checked(path('absPath')),
  'app.feedback.listThreads': none(FEEDBACK),
  'app.feedback.createThread': none(FEEDBACK),
  'app.feedback.getMessages': none(FEEDBACK),
  'app.feedback.addMessage': none(FEEDBACK),
  'app.feedback.updateThreadDiscordId': none(FEEDBACK),
  'app.feedback.deleteThread': none(FEEDBACK),
  'app.meta.getVersion': none(META),
  'app.meta.getTrpcPort': none(META),
  'app.meta.isTestsPanelEnabled': none(META),
  'app.meta.setLabFlag': none(HOST),
  'app.meta.isLoopModeEnabled': none(META),
  'app.meta.getZoomFactor': none(HOST),
  'app.meta.getProtocolClientStatus': none(HOST),
  'app.meta.getRendererZoomFactor': none(HOST),
  'app.meta.checkCliInstalled': none(META),
  'app.meta.installCli': none(HOST),
  'app.meta.adjustZoom': none(HOST),
  'app.meta.restartForUpdate': none(HOST),
  'app.meta.checkForUpdates': none(HOST),
  'app.meta.getSidecarStatus': none(META),
  'app.meta.revealSidecarLog': none(HOST),
  'app.window.getContentBounds': none(HOST),
  'app.window.getDisplayScaleFactor': none(HOST),
  'app.window.close': none(HOST),
  'app.window.setTrafficLightPosition': none(HOST),
  'app.window.setWindowButtonVisibility': none(HOST),
  'app.window.focusRenderer': none(HOST),
  'app.shortcuts.changed': none(HOST),
  'app.auth.githubSystemSignIn': none('starts a GitHub sign-in for the caller'),
  'app.auth.onCallback': none(`${HOST} (fed only by the supervised hub's sidecar socket)`),
  'app.dialog.showOpenDialog': none(HOST),
  'app.browser.createView': checked(task('taskId')),
  'app.browser.destroyView': none(HOST),
  'app.browser.destroyAllForTask': checked(task('taskId')),
  'app.browser.setBounds': none(HOST),
  'app.browser.setVisible': none(HOST),
  'app.browser.setLocked': none(HOST),
  'app.browser.hideAll': none(HOST),
  'app.browser.showAll': none(HOST),
  'app.browser.setHandoffPolicy': none(HOST),
  'app.browser.navigate': none(HOST),
  'app.browser.goBack': none(HOST),
  'app.browser.goForward': none(HOST),
  'app.browser.reload': none(HOST),
  'app.browser.stop': none(HOST),
  'app.browser.executeJs': none(HOST),
  'app.browser.insertCss': none(HOST),
  'app.browser.removeCss': none(HOST),
  'app.browser.setForcedTheme': none(HOST),
  'app.browser.setZoom': none(HOST),
  'app.browser.focus': none(HOST),
  'app.browser.findInPage': none(HOST),
  'app.browser.stopFindInPage': none(HOST),
  'app.browser.setKeyboardPassthrough': none(HOST),
  'app.browser.sendInputEvent': none(HOST),
  'app.browser.openDevTools': none(HOST),
  'app.browser.closeDevTools': none(HOST),
  'app.browser.isDevToolsOpen': none(HOST),
  'app.browser.getUrl': none(HOST),
  'app.browser.getBounds': none(HOST),
  'app.browser.getZoomFactor': none(HOST),
  'app.browser.getActualNativeBounds': none(HOST),
  'app.browser.getViewVisible': none(HOST),
  'app.browser.getViewsForTask': checked(task('taskId')),
  'app.browser.getAllViewIds': none(HOST),
  'app.browser.listViews': none(HOST),
  'app.browser.getNativeChildViewCount': none(HOST),
  'app.browser.isAllHidden': none(HOST),
  'app.browser.isFocused': none(HOST),
  'app.browser.isViewNativelyVisible': none(HOST),
  'app.browser.getPartition': none(HOST),
  'app.browser.getWebContentsId': none(HOST),
  'app.browser.activateExtension': none(HOST),
  'app.browser.getExtensions': none(HOST),
  'app.browser.loadExtension': none(HOST),
  'app.browser.removeExtension': none(HOST),
  'app.browser.discoverBrowserExtensions': none(HOST),
  'app.browser.importExtension': none(HOST),
  'app.browser.reparentToCurrentWindow': none(HOST),
  'app.browser.onEvent': none(HOST),
  'app.browser.onShortcut': none(HOST),
  'app.browser.onFocused': none(HOST),
  'app.browser.onCreateTaskFromLink': streamed(on('taskId', 'task')),
  'app.floatingAgent.setEnabled': none(HOST),
  'app.floatingAgent.setSessionId': checked(session('sessionId')),
  'app.floatingAgent.setPanelOpen': none(HOST),
  'app.floatingAgent.toggleCollapse': none(HOST),
  'app.floatingAgent.resetSize': none(HOST),
  'app.floatingAgent.detach': none(HOST),
  'app.floatingAgent.reattach': none(HOST),
  'app.floatingAgent.getState': none(HOST),
  'app.floatingAgent.getSession': none(HOST),
  'app.floatingAgent.getConfig': none(HOST),
  'app.floatingAgent.onState': none(HOST),
  'app.floatingAgent.onSessionChanged': none(HOST),
  'app.floatingAgent.onCollapseChanged': none(HOST),
  'app.webview.registerBrowserTab': checked(task('taskId')),
  'app.webview.unregisterBrowserTab': checked(task('taskId')),
  'app.webview.setActiveBrowserTab': checked(task('taskId')),
  'app.webview.closeDevTools': none(HOST),
  'app.webview.isDevToolsOpened': none(HOST),
  'app.webview.disableDeviceEmulation': none(HOST),
  'app.webview.registerShortcuts': none(HOST),
  'app.webview.setKeyboardPassthrough': none(HOST),
  'app.webview.setDesktopHandoffPolicy': none(HOST),
  'app.webview.openDevToolsBottom': none(HOST),
  'app.webview.openDevToolsDetached': none(HOST),
  'app.webview.enableDeviceEmulation': none(HOST),
  'app.webview.onShortcut': none(HOST),
  'app.taskWindows.open': checked(task('taskId')),
  'app.taskWindows.close': checked(task('taskId')),
  'app.taskWindows.list': listed(ids('task')),
  'app.taskWindows.setPrimaryActive': checked(task('taskId')),
  'app.taskWindows.getPrimaryActive': listed(oneOrNull('task')),
  'app.taskWindows.claimPanel': checked(task('taskId')),
  'app.taskWindows.releasePanel': checked(task('taskId')),
  'app.taskWindows.releaseAllForTask': checked(task('taskId')),
  'app.taskWindows.getOwnership': checked(task('taskId')),
  'app.taskWindows.getWindowId': none(HOST),
  'app.taskWindows.claimAndCloseOther': checked(task('taskId')),
  'app.taskWindows.claimSession': checked(session('sessionId')),
  // The whole list of open task windows: an update that held only other users'
  // tasks is not sent (desktop host only; a hub with login never emits it).
  'app.taskWindows.onListChanged': streamed(async (event, { scope }) => {
    if (!Array.isArray(event)) return DROP
    const own = (await ids('task')(event, scope)) as unknown[]
    return own.length > 0 || event.length === 0 ? own : DROP
  }),
  'app.taskWindows.onPrimaryActiveChanged': streamed((event, state) =>
    event === null ? byActor(event, state) : onValue('task')(event, state)
  ),
  'app.taskWindows.onOwnershipChanged': streamed(on('taskId', 'task')),
  'app.taskWindows.onPanelsReleasedOnClose': streamed(async (event, { scope }) => {
    if (!isRecord(event) || !Array.isArray(event.released)) return DROP
    const released = await rows('taskId', 'task')(event.released, scope)
    return (released as unknown[]).length > 0 ? { ...event, released } : DROP
  }),
  'app.taskWindows.onPanelCloseRequest': streamed(on('taskId', 'task')),

  // ── artifacts ──
  'artifacts.getByTask': checked(task('taskId')),
  'artifacts.get': checked(artifact('id')),
  'artifacts.create': checked(task('taskId'), folder('folderId')),
  'artifacts.update': checked(artifact('id'), folder('folderId')),
  'artifacts.delete': checked(artifact('id')),
  'artifacts.reorder': checked(artifact('[]'), artifact('artifactIds[]'), folder('folderId')),
  'artifacts.readContent': checked(artifact('id')),
  'artifacts.getFilePath': checked(artifact('id')),
  'artifacts.getMtime': checked(artifact('id')),
  'artifacts.upload': checked(task('taskId'), path('sourcePath')),
  'artifacts.uploadBlob': checked(task('taskId'), folder('folderId')),
  'artifacts.pasteFiles': checked(
    task('destTaskId'),
    folder('destFolderId'),
    path('sourcePaths[]')
  ),
  // A directory upload walks the whole tree: every root under it must be the caller's.
  'artifacts.uploadDir': checked(task('taskId'), tree('dirPath'), folder('parentFolderId')),
  'artifacts.cleanupTask': checked(task('taskId')),
  'artifacts.versionsList': checked(artifact('artifactId')),
  'artifacts.versionsRead': checked(artifact('artifactId')),
  'artifacts.versionsCreate': checked(artifact('artifactId')),
  'artifacts.versionsRename': checked(artifact('artifactId')),
  'artifacts.versionsDiff': checked(artifact('artifactId')),
  'artifacts.versionsPrune': checked(artifact('artifactId')),
  'artifacts.versionsSetCurrent': checked(artifact('artifactId')),
  'artifacts.foldersGetByTask': checked(task('taskId')),
  'artifacts.foldersGetOrCreateByName': checked(task('taskId')),
  'artifacts.foldersCreate': checked(task('taskId'), folder('parentId')),
  'artifacts.foldersUpdate': checked(folder('id'), folder('parentId')),
  'artifacts.foldersDelete': checked(folder('id')),
  'artifacts.foldersReorder': checked(folder('parentId'), folder('folderIds[]')),
  'artifacts.downloadFile': checked(artifact('id')),
  'artifacts.downloadFolder': checked(folder('folderId')),
  'artifacts.downloadAsPdf': checked(artifact('id')),
  'artifacts.downloadAsPng': checked(artifact('id')),
  'artifacts.downloadAsHtml': checked(artifact('id')),
  'artifacts.downloadAllAsZip': checked(task('taskId')),
  'artifacts.onContentChanged': streamed(onValue('artifact')),

  // ── chat ──
  'chat.supports': none('a terminal mode id'),
  'chat.testSetWatchdogTimings': none(TEST),
  'chat.hydrate': chatOpts,
  'chat.start': chatOpts,
  'chat.send': checked(tab('tabId')),
  'chat.sendToolResult': checked(tab('tabId')),
  'chat.respondPermission': checked(tab('tabId')),
  'chat.interrupt': chatOpts,
  'chat.abortAndPop': chatOpts,
  'chat.kill': checked(tab('tabId')),
  'chat.remove': checked(tab('tabId')),
  'chat.reset': chatOpts,
  'chat.getBufferSince': checked(tab('tabId')),
  'chat.getReplay': checked(tab('tabId')),
  'chat.commandTaskOutput': checked(tab('tabId')),
  'chat.stopCommandTask': checked(tab('tabId')),
  'chat.backgroundCommandTask': checked(tab('tabId')),
  'chat.getInfo': checked(tab('tabId')),
  'chat.inspectPermissions': checked(task('taskId')),
  'chat.getMode': checked(task('taskId')),
  'chat.getAutoEligibility': none(META),
  'chat.setMode': chatOpts,
  'chat.getModel': checked(task('taskId')),
  'chat.setModel': chatOpts,
  'chat.getEffort': checked(task('taskId')),
  'chat.setEffort': chatOpts,
  'chat.getCollaboration': checked(task('taskId')),
  'chat.setCollaboration': chatOpts,
  'chat.getFastMode': checked(task('taskId')),
  'chat.setFastMode': chatOpts,
  'chat.listSkills': checked(path('cwd')),
  'chat.listCommands': checked(path('cwd')),
  'chat.listAgents': checked(path('cwd')),
  'chat.listFiles': checked(path('cwd')),
  'chat.bumpAutocompleteUsage': none(`${HUB_CONFIG}: slash-command usage counts`),
  'chat.getAutocompleteUsage': none(`${HUB_CONFIG}: slash-command usage counts`),
  'chat.getCliSnapshot': checked(task('taskId')),
  'chat.queue.list': checked(tab('tabId')),
  'chat.queue.push': checked(tab('tabId')),
  'chat.queue.remove': checked(ref('chatQueueItem')('id')),
  'chat.queue.clear': checked(tab('tabId')),
  'chat.onEvent': streamed(on('tabId', 'tab')),
  'chat.onExit': streamed(on('tabId', 'tab')),
  'chat.onQueueChanged': streamed(on('tabId', 'tab')),
  'chat.onQueueDrained': streamed(on('tabId', 'tab')),

  // ── computers (T-19): binding work needs the task/project AND the computer to be
  // the caller's (so the computer is the work owner's); managing one is the owner's
  // or an admin's, decided in the handler ──
  'computers.list': none(COMPUTER),
  'computers.setTaskComputer': checked(task('taskId'), computer('computerId')),
  'computers.setProjectDefaultComputer': checked(project('projectId'), computer('computerId')),
  'computers.resolveTaskComputer': checked(task('taskId')),
  'computers.renameMachine': none(COMPUTER),
  'computers.setVisibility': none(COMPUTER),
  'computers.delete': none(COMPUTER),
  'computers.onStatusChange': none(COMPUTER),
  'computers.revokeComputer': none(COMPUTER),

  // ── diagnostics, feedback ──
  'diagnostics.recordClientError': none(SELF),
  'diagnostics.recordClientEvent': none(SELF),
  'feedback.listThreads': none(FEEDBACK),
  'feedback.getMessages': none(FEEDBACK),
  'feedback.createThread': none(FEEDBACK),
  'feedback.addMessage': none(FEEDBACK),
  'feedback.updateThreadDiscordId': none(FEEDBACK),
  'feedback.deleteThread': none(FEEDBACK),

  // ── file editor + workspace (filesystem of a computer) ──
  'fileEditor.readDir': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.readFile': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.listAllFiles': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.writeFile': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.createFile': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.createDir': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.rename': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.delete': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.copyIn': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath'),
    path('absoluteSrc')
  ),
  'fileEditor.copy': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.gitStatus': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.searchFiles': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'fileEditor.showInFinder': checked(path('rootPath')),
  'fileEditor.watch': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('rootPath')
  ),
  'workspace.listRoots': checked(task('taskId'), project('projectId'), computer('computerId')),
  'workspace.listDir': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('path')
  ),
  'workspace.mkdir': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('path')
  ),
  'workspace.setAllowedRoots': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId')
  ),
  'workspace.resolveProjectPath': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId')
  ),
  'workspace.setProjectPath': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('path')
  ),
  'workspace.forgetProjectPath': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId')
  ),
  'workspace.pathExists': checked(
    task('taskId'),
    project('projectId'),
    computer('computerId'),
    path('path')
  ),

  // ── history, usage ──
  'history.listForTask': checked(task('taskId')),
  'history.getAutomationActionRuns': checked(ref('automationRun')('runId')),
  // Records with no task have no owner and are left out of the caller's sums.
  'usageAnalytics.query': listed(SCOPED_IN_HANDLER),
  'usageAnalytics.refresh': listed(SCOPED_IN_HANDLER),
  'usageAnalytics.taskCost': checked(task('taskId')),

  // ── integrations ──
  'integrations.connectGithub': checked(project('projectId')),
  'integrations.connectLinear': checked(project('projectId')),
  'integrations.connectJira': checked(project('projectId')),
  'integrations.getJiraTransitions': checked(task('taskId')),
  'integrations.updateConnection': none(CONNECTION),
  'integrations.listConnections': none(CONNECTION),
  'integrations.getConnectionUsage': listed(connectionUsage),
  'integrations.disconnect': none(CONNECTION),
  'integrations.clearProjectProvider': checked(project('projectId')),
  'integrations.getProjectConnection': checked(project('projectId')),
  'integrations.setProjectConnection': checked(project('projectId')),
  'integrations.clearProjectConnection': checked(project('projectId')),
  'integrations.listGithubRepositories': none(CONNECTION),
  'integrations.listGithubProjects': none(CONNECTION),
  'integrations.listGithubIssues': checked(project('projectId')),
  'integrations.importGithubIssues': checked(project('projectId')),
  'integrations.listGithubRepositoryIssues': checked(project('projectId')),
  'integrations.importGithubRepositoryIssues': checked(project('projectId')),
  'integrations.listLinearTeams': none(CONNECTION),
  'integrations.listLinearProjects': none(CONNECTION),
  'integrations.listLinearIssues': checked(project('projectId')),
  'integrations.importLinearIssues': checked(project('projectId')),
  'integrations.setProjectMapping': checked(project('projectId')),
  'integrations.getProjectMapping': checked(project('projectId')),
  // Without a project or task it syncs every linked task on the hub.
  'integrations.syncNow': {
    ...checked(project('projectId'), task('taskId')),
    needsOne: ['projectId', 'taskId']
  },
  'integrations.getTaskSyncStatus': checked(task('taskId')),
  'integrations.getBatchTaskSyncStatus': checked(task('taskIds[]')),
  'integrations.pushTask': checked(task('taskId')),
  'integrations.pullTask': checked(task('taskId')),
  'integrations.getLink': checked(task('taskId')),
  'integrations.unlinkTask': checked(task('taskId')),
  'integrations.pushUnlinkedTasks': checked(project('projectId')),
  'integrations.fetchProviderStatuses': none(CONNECTION),
  'integrations.applyStatusSync': checked(project('projectId')),
  'integrations.resyncProviderStatuses': checked(project('projectId')),
  'integrations.listProviderGroups': none(CONNECTION),
  'integrations.listProviderScopes': none(CONNECTION),
  'integrations.listProviderIssues': checked(project('projectId')),
  'integrations.importProviderIssues': checked(project('projectId')),
  'integrations.testSeedGithubConnection': none(TEST),
  'integrations.testSetGithubRepositories': none(TEST),
  'integrations.testSetGithubRepositoryIssues': none(TEST),
  'integrations.testClearGithubMocks': none(TEST),

  // ── menu commands (desktop native menu; on a hub, a few REST routes emit) ──
  'menu.testEmit': none(TEST),
  'menu.onGoHome': streamed(byActor),
  'menu.onToggleGlobalAgentPanel': streamed(byActor),
  'menu.onToggleAgentStatusPanel': streamed(byActor),
  'menu.onOpenSettings': streamed(byActor),
  'menu.onOpenProjectSettings': streamed(byActor),
  'menu.onNewTemporaryTask': streamed(byActor),
  'menu.onOpenTask': streamed(on('taskId', 'task')),
  'menu.onCloseTask': streamed(onValue('task')),
  'menu.onOpenArtifact': streamed(on('taskId', 'task')),
  'menu.onScreenshotTrigger': streamed(byActor),
  'menu.onCloseCurrentFocus': streamed(byActor),
  'menu.onCloseActiveTask': streamed(byActor),
  'menu.onSyncSessionId': streamed(byActor),
  'menu.onReloadBrowser': streamed(byActor),
  'menu.onReloadApp': streamed(byActor),
  'menu.onZoomFactorChanged': streamed(byActor),
  'menu.onUpdateStatus': streamed(byActor),
  'menu.onBrowserEnsurePanelOpen': streamed(on('taskId', 'task')),
  'menu.onBrowserCreateTab': streamed(on('taskId', 'task')),
  'menu.onBrowserAgentTouched': streamed(on('taskId', 'task')),

  // ── refresh signals ──
  'notify.onTasksChanged': streamed(tasksChangedEvents),
  'notify.onSettingsChanged': streamed(byActor),
  'notify.onEmbeddedServerFailed': none(`${HOST} (the desktop's sidecar supervisor)`),
  'settings.onThemeChanged': streamed(byActor),
  'telemetry.onIpcEvent': none(`${HOST} (the desktop main process's IPC telemetry)`),

  // ── processes ──
  // A process attached to neither project nor task would be nobody's.
  'processes.create': {
    ...checked(project('projectId'), task('taskId'), path('cwd')),
    needsOne: ['projectId', 'taskId']
  },
  'processes.spawn': {
    ...checked(project('projectId'), task('taskId'), path('cwd')),
    needsOne: ['projectId', 'taskId']
  },
  'processes.update': checked(
    proc('processId'),
    project('updates.projectId'),
    task('updates.taskId'),
    path('updates.cwd')
  ),
  'processes.stop': checked(proc('processId')),
  'processes.kill': checked(proc('processId')),
  'processes.restart': checked(proc('processId')),
  'processes.listForTask': then(checked(task('taskId'), project('projectId')), processRows),
  'processes.listAll': listed(processRows),
  'processes.killTask': checked(task('taskId')),
  'processes.onLog': streamed(on('id', 'process')),
  'processes.onStatus': streamed(on('id', 'process')),
  'processes.onTitle': streamed(on('id', 'process')),
  'processes.onStats': streamed(onKeys('process')),

  // ── projects + folders ──
  'projects.list': listed(rows('id', 'project')),
  'projects.create': checked(path('path')),
  'projects.update': checked(project('id'), path('path')),
  'projects.delete': checked(project('id')),
  'projects.uploadIcon': checked(project('projectId'), path('sourcePath')),
  'projects.reorder': checked(project('projectIds[]')),
  'projectGroups.list': listed(groups),
  'projectGroups.create': listed(groups),
  'projectGroups.createFolderWithProjects': then(checked(project('projectIds[]')), groups),
  'projectGroups.update': then(checked(group('id')), groups),
  'projectGroups.delete': then(checked(group('id')), groups),
  'projectGroups.moveProject': then(checked(project('projectId'), group('groupId')), groups),
  'projectGroups.reorderTopLevel': then(
    checked({
      pick: (raw) =>
        isRecord(raw) && Array.isArray(raw.entries)
          ? raw.entries.flatMap((e) =>
              isRecord(e)
                ? [res(e.kind === 'group' ? 'projectGroup' : 'project', e.id)].filter(
                    (r): r is OwnedResource => r !== null
                  )
                : []
            )
          : [],
      sample: { kind: 'project', input: (id) => ({ entries: [{ kind: 'project', id }] }) }
    }),
    groups
  ),
  'projectGroups.reorderProjectsInGroup': then(
    checked(group('groupId'), project('projectIds[]')),
    groups
  ),

  // ── pty ──
  'pty.modesList': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesTest': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesGet': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesCreate': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesUpdate': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesDelete': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesRestoreDefaults': none(`${HUB_CONFIG}: terminal modes`),
  'pty.modesResetToDefaultState': none(`${HUB_CONFIG}: terminal modes`),
  // The key of a new session is `taskId:tabId`: its task decides.
  'pty.create': checked(session('sessionId'), path('cwd')),
  'pty.testSetPtyCreateCapture': none(TEST),
  'pty.testTakePtyCreateOpts': none(TEST),
  'pty.testTakePtyKillCalls': none(TEST),
  'pty.testExecutionContext': none(TEST),
  'pty.testWarmStatus': none(TEST),
  'pty.write': checked(session('sessionId')),
  'pty.submit': checked(session('sessionId')),
  'pty.resize': checked(session('sessionId')),
  'pty.kill': checked(session('sessionId')),
  'pty.touch': checked(session('sessionId')),
  'pty.interrupt': checked(session('sessionId')),
  'pty.prioritize': checked(session('sessionId')),
  'pty.ackEnsureAlive': none(
    'a correlation number for an ensure-alive request the caller was sent (onEnsureAlive is filtered)'
  ),
  'pty.attach': checked(session('sessionId')),
  'pty.exists': checked(session('sessionId')),
  'pty.getBuffer': checked(session('sessionId')),
  'pty.clearBuffer': checked(session('sessionId')),
  'pty.getBufferSince': checked(session('sessionId')),
  'pty.list': listed(rows('sessionId', 'session')),
  'pty.chatList': listed(rows('sessionId', 'session')),
  'pty.getState': checked(session('sessionId')),
  'pty.sessionList': listed(rows('sessionId', 'session')),
  'pty.sessionGetState': checked(session('sessionId')),
  'pty.setTheme': none(`${HUB_CONFIG}: the terminal colours answered to OSC queries`),
  // `taskId` (optional): Doctor also asks that task's computer about its node-pty install.
  'pty.validate': checked(task('taskId')),
  'pty.setShellOverride': none(`${HUB_CONFIG}: the shell override`),
  'pty.warmSetProjectTabCounts': checked(project('counts{}')),
  'pty.onData': streamed(on('sessionId', 'session')),
  'pty.onStateChange': streamed(on('sessionId', 'session')),
  'pty.onBackgroundJobs': streamed(on('sessionId', 'session')),
  'pty.onTitleChange': streamed(on('sessionId', 'session')),
  'pty.onExit': streamed(on('sessionId', 'session')),
  'pty.onPrompt': streamed(on('sessionId', 'session')),
  'pty.onSessionDetected': streamed(on('sessionId', 'session')),
  'pty.testEmitSessionDetected': checked(session('sessionId')),
  'pty.testEmitExit': checked(session('sessionId')),
  'pty.onDevServerDetected': streamed(on('sessionId', 'session')),
  'pty.onRespawnSuggested': streamed(on('taskId', 'task')),
  'pty.onEnsureAlive': streamed(on('taskId', 'task')),
  'pty.onHibernateWarn': streamed(on('sessionId', 'session')),
  'pty.onHibernateCancelled': streamed(on('sessionId', 'session')),
  'pty.onHibernated': streamed(on('sessionId', 'session')),
  'pty.onStats': streamed(onKeys('session')),
  'pty.onResizeNeeded': streamed(on('sessionId', 'session')),

  // ── settings (T-16 keyed them per user) ──
  'settings.get': checked(settingKey('key')),
  'settings.set': checked(settingKey('key')),
  'settings.getAll': listed(settingsMap),
  'settings.getEffectiveTheme': none(HOST),
  'settings.getThemeSource': none(HOST),
  'settings.setTheme': none(HOST),

  // ── tags ──
  'tags.list': listed(rows('project_id', 'project')),
  'tags.create': checked(project('projectId')),
  'tags.update': checked(tag('id')),
  'tags.delete': checked(tag('id')),
  'tags.reorder': checked(tag('tagIds[]')),
  'tags.getForTask': checked(task('taskId')),
  'tags.getAllTaskTagIds': listed(keyed('task')),
  'tags.setForTask': checked(task('taskId'), tag('tagIds[]')),

  // ── tasks ──
  'task.getAll': listed(taskRows),
  'task.getByProject': checked(project('projectId')),
  'task.get': checked(task('id')),
  'task.testRecordPendingSpawn': checked(task('taskId')),
  'task.create': checked(project('projectId'), task('parentId'), template('templateId')),
  'task.getSubTasks': then(checked(task('parentId')), taskRows),
  // A worktree or base dir is a registered root (access.ts `path`): pointing one at
  // someone else's directory would make it yours.
  'task.update': checked(
    task('id'),
    project('projectId'),
    task('parentId'),
    path('worktreePath'),
    path('baseDir')
  ),
  'task.resetConversation': checked(task('id')),
  'task.switchConversation': checked(task('id')),
  'task.deleteConversation': checked(task('id')),
  'task.updateMany': checked(
    task('ids[]'),
    project('updates.projectId'),
    task('updates.parentId'),
    path('updates.worktreePath'),
    path('updates.baseDir')
  ),
  'task.delete': checked(task('id')),
  'task.deleteMany': checked(task('ids[]')),
  'task.restore': checked(task('id')),
  'task.archive': checked(task('id')),
  'task.archiveMany': checked(task('ids[]')),
  'task.unarchive': checked(task('id')),
  'task.reorder': checked(task('taskIds[]')),
  'task.reorderPinned': checked(task('taskIds[]')),
  'task.setBrowserTabLocked': checked(task('taskId')),
  // Starts the task's agent where the task's computer is (placement gates that too).
  'task.startMainAgent': checked(task('taskId')),
  // Blockers can cross projects: the other side is filtered too.
  'task.getBlockers': then(checked(task('taskId')), taskRows),
  'task.getAllBlockedTaskIds': listed(ids('task')),
  'task.getBlocking': then(checked(task('taskId')), taskRows),
  'task.addBlocker': checked(task('taskId'), task('blockerTaskId')),
  'task.removeBlocker': checked(task('taskId'), task('blockerTaskId')),
  'task.setBlockers': checked(task('taskId'), task('blockerTaskIds[]')),
  'task.loadBoardData': listed(board),
  'task.loadBoardRows': listed(board),
  'task.onChanged': streamed(on('projectId', 'project')),

  // ── templates, terminal tabs ──
  'template.getByProject': checked(project('projectId')),
  'template.get': checked(template('id')),
  'template.create': checked(project('projectId')),
  'template.update': checked(template('id')),
  'template.delete': checked(template('id')),
  'template.setDefault': checked(project('projectId'), template('templateId')),
  'taskTerminals.list': checked(task('taskId')),
  'taskTerminals.listHibernatedSessions': listed(ids('session')),
  'taskTerminals.listAutoRestoreTasks': listed(ids('task')),
  'taskTerminals.create': checked(task('taskId')),
  'taskTerminals.split': checked(tab('tabId')),
  'taskTerminals.moveToGroup': checked(tab('tabId')),
  'taskTerminals.update': checked(tab('id')),
  'taskTerminals.delete': checked(tab('tabId')),
  'taskTerminals.ensureMain': checked(task('taskId')),
  'taskTerminals.onChanged': streamed(on('taskId', 'task')),

  // ── tests panel ──
  'testPanel.getCategories': checked(project('projectId')),
  'testPanel.createCategory': checked(project('project_id')),
  'testPanel.updateCategory': checked(ref('testCategory')('id')),
  'testPanel.deleteCategory': checked(ref('testCategory')('id')),
  'testPanel.reorderCategories': checked(ref('testCategory')('ids[]')),
  'testPanel.getProfiles': none(`${HUB_CONFIG}: test profiles (a hub-wide setting)`),
  'testPanel.applyProfile': checked(project('projectId')),
  'testPanel.scanFiles': checked(project('projectId'), path('projectPath')),
  'testPanel.getLabels': checked(project('projectId')),
  'testPanel.createLabel': checked(project('project_id')),
  'testPanel.updateLabel': checked(ref('testLabel')('id')),
  'testPanel.deleteLabel': checked(ref('testLabel')('id')),
  'testPanel.getFileLabels': checked(project('projectId')),
  'testPanel.toggleFileLabel': checked(project('projectId'), ref('testLabel')('labelId')),
  'testPanel.getFileNotes': checked(project('projectId')),
  'testPanel.setFileNote': checked(project('projectId')),

  // ── worktrees / git (a path names the repo) ──
  'worktrees.watchStart': checked(path('worktreePath')),
  'worktrees.watchStop': checked(path('worktreePath')),
  'worktrees.isGitRepo': checked(path('path')),
  'worktrees.listProjectRepos': checked(path('projectPath'), project('projectId'), task('taskId')),
  'worktrees.detectChildRepos': checked(path('projectPath'), project('projectId'), task('taskId')),
  'worktrees.detectWorktrees': checked(path('repoPath')),
  'worktrees.createWorktree': checked(path('repoPath'), path('targetPath'), project('projectId')),
  'worktrees.onCreateWorktreePhase': none(
    "phase names for the caller's own request id; no content"
  ),
  'worktrees.removeWorktree': checked(path('repoPath'), path('worktreePath')),
  'worktrees.init': checked(path('path')),
  'worktrees.getCurrentBranch': checked(path('path')),
  'worktrees.listBranches': checked(path('path')),
  'worktrees.checkoutBranch': checked(path('path')),
  'worktrees.createBranch': checked(path('path')),
  'worktrees.hasUncommittedChanges': checked(path('path')),
  'worktrees.mergeIntoParent': checked(path('projectPath')),
  'worktrees.abortMerge': checked(path('path')),
  'worktrees.mergeWithAI': checked(path('projectPath'), path('worktreePath')),
  'worktrees.isMergeInProgress': checked(path('path')),
  'worktrees.getConflictedFiles': checked(path('path')),
  'worktrees.getWorkingDiff': checked(path('path')),
  'worktrees.stageFile': checked(path('path')),
  'worktrees.unstageFile': checked(path('path')),
  'worktrees.discardFile': checked(path('path')),
  'worktrees.stageAll': checked(path('path')),
  'worktrees.unstageAll': checked(path('path')),
  'worktrees.getFileDiff': checked(path('repoPath')),
  'worktrees.getUntrackedFileDiff': checked(path('repoPath')),
  'worktrees.getUntrackedFileDiffs': checked(path('repoPath')),
  'worktrees.getConflictContent': checked(path('repoPath')),
  'worktrees.writeResolvedFile': checked(path('repoPath')),
  'worktrees.commitFiles': checked(path('repoPath')),
  'worktrees.analyzeConflict': none('the conflict text the caller sends; names no stored repo'),
  'worktrees.isRebaseInProgress': checked(path('path')),
  'worktrees.getRebaseProgress': checked(path('repoPath')),
  'worktrees.abortRebase': checked(path('path')),
  'worktrees.continueRebase': checked(path('path')),
  'worktrees.skipRebaseCommit': checked(path('path')),
  'worktrees.getMergeContext': checked(path('repoPath')),
  'worktrees.getRecentCommits': checked(path('repoPath')),
  'worktrees.getAheadBehind': checked(path('repoPath')),
  'worktrees.getStatusSummary': checked(path('repoPath')),
  'worktrees.revealInFinder': checked(path('path')),
  'worktrees.isDirty': checked(path('path')),
  'worktrees.getRemoteUrl': checked(path('path')),
  'worktrees.getAheadBehindUpstream': checked(path('path')),
  'worktrees.fetch': checked(path('path')),
  'worktrees.push': checked(path('path')),
  'worktrees.pull': checked(path('path')),
  'worktrees.getDefaultBranch': checked(path('path')),
  'worktrees.listBranchesDetailed': checked(path('path')),
  'worktrees.listRemoteBranches': checked(path('path')),
  'worktrees.getMergeBase': checked(path('path')),
  'worktrees.getCommitsSince': checked(path('path')),
  'worktrees.getCommitsBeforeRef': checked(path('path')),
  'worktrees.deleteBranch': checked(path('path')),
  'worktrees.pruneRemote': checked(path('path')),
  'worktrees.rebaseOnto': checked(path('path')),
  'worktrees.mergeFrom': checked(path('path')),
  'worktrees.getDiffStats': checked(path('path')),
  'worktrees.getWorktreeMetadata': checked(path('path')),
  'worktrees.getCommitDag': checked(path('path')),
  'worktrees.resolveChildBranches': checked(path('path')),
  'worktrees.resolveCopyBehavior': checked(project('projectId')),
  'worktrees.getIgnoredFileTree': checked(path('repoPath')),
  'worktrees.copyIgnoredFiles': checked(path('repoPath'), path('worktreePath')),
  'worktrees.getResolvedCommitDag': checked(path('path')),
  'worktrees.getResolvedForkGraph': checked(path('targetPath'), path('repoPath')),
  'worktrees.getResolvedUpstreamGraph': checked(path('repoPath')),
  'worktrees.getResolvedRecentCommits': checked(path('path')),
  'worktrees.listStashes': checked(path('repoPath')),
  'worktrees.createStash': checked(path('repoPath')),
  'worktrees.applyStash': checked(path('repoPath')),
  'worktrees.popStash': checked(path('repoPath')),
  'worktrees.dropStash': checked(path('repoPath')),
  'worktrees.branchFromStash': checked(path('repoPath')),
  'worktrees.getStashDiff': checked(path('repoPath')),
  'worktrees.checkGhInstalled': checked(path('repoPath')),
  'worktrees.hasGithubRemote': checked(path('repoPath')),
  'worktrees.listOpenPrs': checked(path('repoPath')),
  'worktrees.getPrByUrl': checked(path('repoPath')),
  'worktrees.getPrForCheckout': checked(path('repoPath')),
  'worktrees.createPr': checked(path('repoPath')),
  'worktrees.getPrComments': checked(path('repoPath')),
  'worktrees.addPrComment': checked(path('repoPath')),
  'worktrees.mergePr': checked(path('repoPath')),
  'worktrees.getPrDiff': checked(path('repoPath')),
  'worktrees.getGhUser': checked(path('repoPath')),
  'worktrees.editPrComment': checked(path('repoPath')),
  'worktrees.onDiffChanged': streamed(on('worktreePath', 'path')),
  'worktrees.onDiffWatchFailed': streamed(on('worktreePath', 'path')),

  // ── `admin` procedures (T-106): management, never another user's content (O-6) ──
  'aiConfig.marketplace.addRegistry': none(LIBRARY),
  'aiConfig.marketplace.removeRegistry': none(LIBRARY),
  'aiConfig.marketplace.toggleRegistry': none(LIBRARY),
  'app.backup.create': none(BACKUP),
  'app.backup.delete': none(BACKUP),
  'app.backup.getSettings': none(BACKUP),
  'app.backup.list': none(BACKUP),
  'app.backup.rename': none(BACKUP),
  'app.backup.restore': none(BACKUP),
  'app.backup.revealInFinder': none(BACKUP),
  'app.backup.setSettings': none(BACKUP),
  'app.exportImport.import': none(IMPORT),
  // Reads a file on the hub host: not one inside someone else's project or the hub's state.
  'app.exportImport.testImportFromPath': checked(path('filePath')),
  // Automations are their project's: an admin manages only those in its own projects.
  'automations.getByProject': checked(project('projectId')),
  'automations.get': checked(automation('id')),
  'automations.create': { ...checked(project('project_id')), needsOne: ['project_id'] },
  'automations.update': checked(automation('id')),
  'automations.delete': checked(automation('id')),
  'automations.toggle': checked(automation('id')),
  'automations.reorder': checked(automation('ids[]')),
  'automations.getRuns': checked(automation('automationId')),
  'automations.runManual': checked(automation('id')),
  'automations.clearRuns': checked(automation('automationId')),
  'automations.onChanged': streamed(byActor),
  'computers.claim': none(COMPUTER),
  'computers.mintJoinToken': none(COMPUTER),
  'computers.unrevoke': none(COMPUTER),
  // Events naming another user's task, session or project are dropped in the handler.
  'diagnostics.exportBundle': listed(SCOPED_IN_HANDLER),
  'diagnostics.getConfig': none(HUB_CONFIG),
  'diagnostics.setConfig': none(HUB_CONFIG),
  'hub.setLabel': none(HUB_CONFIG),
  'testPanel.saveProfile': none(`${HUB_CONFIG}: test profiles (a hub-wide setting)`),
  'testPanel.deleteProfile': none(`${HUB_CONFIG}: test profiles (a hub-wide setting)`)
}

// ── reading ids out of a raw input ────────────────────────────────────────────

const isCustom = (r: Ref): r is CustomRef => 'pick' in r

/** Every string found at `at` (see {@link IdRef}). */
export function valuesAt(raw: unknown, at: string): string[] {
  if (at === '') return typeof raw === 'string' && raw ? [raw] : []
  const out: string[] = []
  const walk = (node: unknown, segs: string[]): void => {
    if (node === null || node === undefined) return
    if (segs.length === 0) {
      if (typeof node === 'string' && node) out.push(node)
      return
    }
    const [seg, ...rest] = segs
    if (seg === '[]') {
      if (Array.isArray(node)) for (const item of node) walk(item, rest)
      return
    }
    if (seg === '{}') {
      if (isRecord(node) && rest.length === 0) for (const k of Object.keys(node)) if (k) out.push(k)
      return
    }
    if (isRecord(node)) walk(node[seg], rest)
  }
  // `ids[]` → ['ids', '[]']; `[].projectId` → ['[]', 'projectId']; `counts{}` → ['counts', '{}']
  const segs = at
    .split('.')
    .flatMap((s) =>
      s.endsWith('[]') ? [s.slice(0, -2), '[]'] : s.endsWith('{}') ? [s.slice(0, -2), '{}'] : [s]
    )
    .filter((s) => s !== '')
  walk(raw, segs)
  return out
}

/** The resources a raw input names, per the rule. */
export function resourcesIn(raw: unknown, rule: OwnerRule): OwnedResource[] {
  const out: OwnedResource[] = []
  for (const r of rule.ids ?? []) {
    if (isCustom(r)) out.push(...r.pick(raw))
    else for (const id of valuesAt(raw, r.at)) out.push({ kind: r.kind, id })
  }
  return out
}

/** Whether one of `needsOne` is present. */
export function hasOneOf(raw: unknown, ats: readonly string[]): boolean {
  return ats.some((at) => valuesAt(raw, at).length > 0)
}

export { isCustom as isCustomRef }
