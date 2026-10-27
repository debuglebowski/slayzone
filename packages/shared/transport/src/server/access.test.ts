/**
 * The ONE access function (T-17) against a real, fully migrated database: every
 * resource kind resolves to its project's owner, nobody else — an admin included —
 * gets in, ownerless and missing rows are refused, the hub-wide exceptions hold, and
 * a hub without login (the desktop app's) allows everything without a query.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/transport/src/server/access.test.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../test-utils/ipc-harness.js'
import {
  RESOURCE_KINDS,
  canAccess,
  createAccessScope,
  hubStateRoots,
  invalidateAccessCache,
  resource,
  type AccessRequest,
  type ResourceKind
} from './access'

const h = await createTestHarness()
const db = h.slayDb
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)

const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-access-')))
const hubRoot = join(base, 'hub-root')
const aRoot = join(base, 'a-proj')
const bNested = join(aRoot, 'vendor', 'b-proj')
const aWorktree = join(base, 'a-worktrees', 'feat')
const placement = join(base, 'b-placement')
for (const d of [hubRoot, aRoot, bNested, aWorktree, placement]) mkdirSync(d, { recursive: true })
writeFileSync(join(hubRoot, 'slayzone.data.sqlite'), '')

const A = 'user-a'
const B = 'user-b'
const ADMIN = 'user-admin'

// ── fixtures: A's things, B's things, and things nobody owns ──
sql(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES
  ('pA', 'A', '#111', ?, ?), ('pB', 'B', '#222', ?, ?), ('pU', 'Unowned', '#333', NULL, NULL)`,
  A,
  aRoot,
  B,
  bNested
)
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES
  ('tA', 'pA', 'a', ?), ('tB', 'pB', 'b', NULL), ('tU', 'pU', 'u', NULL)`,
  aWorktree
)
sql(
  `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
  VALUES ('c1', 'pB', ?, 'ok', 0)`,
  placement
)
sql(
  `INSERT INTO terminal_tabs (id, task_id, mode, is_main) VALUES ('tabA', 'tA', 'terminal', 0), ('tabB', 'tB', 'terminal', 0)`
)
sql(`INSERT INTO agent_sessions (id, mode, task_id, origin, status, created_at) VALUES
  ('sA', 'claude-code', 'tA', 'pending-spawn', 'bound', 0),
  ('sPool', 'claude-code', NULL, 'pending-spawn', 'pooled', 0)`)
sql(
  `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES ('prA', 'tA', 'claude-code', 'x', 0)`
)
sql(
  `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, created_at) VALUES
  ('trA', ?, 'tA', 'tabA', 'sha', 0), ('trOrphan', ?, NULL, 'tabA', 'sha', 0)`,
  aWorktree,
  aWorktree
)
sql(`INSERT INTO artifact_folders (id, task_id, name) VALUES ('fA', 'tA', 'f')`)
sql(`INSERT INTO task_artifacts (id, task_id, title) VALUES ('arA', 'tA', 't')`)
sql(`INSERT INTO processes (id, task_id, project_id, label, command) VALUES
  ('prcTask', 'tA', NULL, 'l', 'c'), ('prcProject', NULL, 'pA', 'l', 'c'), ('prcGlobal', NULL, NULL, 'l', 'c')`)
sql(`INSERT INTO tags (id, project_id, name) VALUES ('tagA', 'pA', 'x')`)
sql(`INSERT INTO task_templates (id, project_id, name) VALUES ('tmA', 'pA', 'x')`)
sql(`INSERT INTO test_categories (id, project_id, name, pattern) VALUES ('tcA', 'pA', 'x', '*')`)
sql(`INSERT INTO test_labels (id, project_id, name) VALUES ('tlA', 'pA', 'x')`)
sql(
  `INSERT INTO chat_queue (id, tab_id, send, original, position) VALUES ('cqA', 'tabA', 's', 'o', 0)`
)
sql(
  `INSERT INTO automations (id, project_id, name, trigger_config, actions) VALUES ('auA', 'pA', 'x', '{}', '[]')`
)
sql(`INSERT INTO automation_runs (id, automation_id) VALUES ('runA', 'auA')`)
sql(`INSERT INTO ai_config_items (id, type, scope, project_id, name, slug) VALUES
  ('aiA', 'skill', 'project', 'pA', 'x', 'x'), ('aiGlobal', 'skill', 'global', NULL, 'g', 'g')`)
sql(`INSERT INTO project_groups (id, name) VALUES ('gA', 'a'), ('gEmpty', 'e'), ('gMixed', 'm')`)
sql(`UPDATE projects SET group_id = 'gA' WHERE id = 'pA'`)
// Computers (T-19): A's, and one enrolled with nobody recorded as its minter.
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at,
  owner_user_id) VALUES ('cA', 'a', 'linux-x64', '0', '{}', 0, 0, ?), ('cU', 'u', 'linux-x64', '0', '{}', 0, 0, NULL)`,
  A
)
sql(
  `INSERT INTO projects (id, name, color, owner_user_id, group_id) VALUES
  ('pA2', 'A2', '#111', ?, 'gMixed'), ('pB2', 'B2', '#222', ?, 'gMixed')`,
  A,
  B
)

const req = (userId: string | null, authRequired = true): AccessRequest => ({
  authRequired,
  principal: userId ? { userId } : null,
  hubRoots: [hubRoot]
})
const can = (userId: string | null, kind: ResourceKind, id: string, authRequired = true) =>
  canAccess(db, req(userId, authRequired), resource(kind, id))

/** One resource of each kind that A owns. */
const OF_A: Record<ResourceKind, string> = {
  project: 'pA',
  task: 'tA',
  tab: 'tabA',
  session: 'sA',
  prompt: 'prA',
  turn: 'trA',
  artifact: 'arA',
  artifactFolder: 'fA',
  process: 'prcTask',
  tag: 'tagA',
  template: 'tmA',
  testCategory: 'tcA',
  testLabel: 'tlA',
  chatQueueItem: 'cqA',
  automationRun: 'runA',
  aiConfigItem: 'aiA',
  projectGroup: 'gA',
  path: join(aWorktree, 'src', 'index.ts'),
  automation: 'auA',
  computer: 'cA',
  pathTree: aWorktree
}

describe('every kind: the owner, and nobody else', () => {
  test('the fixture covers every resource kind', () => {
    expect(Object.keys(OF_A).sort()).toEqual([...RESOURCE_KINDS].sort())
  })
  for (const kind of RESOURCE_KINDS) {
    test(`${kind}: A yes; B, an admin and no principal no`, async () => {
      expect(await can(A, kind, OF_A[kind])).toBe(true)
      expect(await can(B, kind, OF_A[kind])).toBe(false)
      expect(await can(ADMIN, kind, OF_A[kind])).toBe(false)
      expect(await can(null, kind, OF_A[kind])).toBe(false)
    })
  }
})

describe('a hub without login (the desktop app): everything, as before', () => {
  for (const kind of RESOURCE_KINDS) {
    test(`${kind}: allowed with or without a principal, missing or not`, async () => {
      expect(await can(null, kind, OF_A[kind], false)).toBe(true)
      expect(await can(B, kind, OF_A[kind], false)).toBe(true)
      expect(await can(null, kind, 'does-not-exist', false)).toBe(true)
    })
  }
  test('a scope there never queries (no database needed)', async () => {
    const scope = createAccessScope(
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('queried')
          }
        }
      ) as typeof db,
      { authRequired: false, principal: null }
    )
    expect(scope.enforcing).toBe(false)
    expect(scope.allows(resource('task', 'x'))).toBe(true)
    expect(await scope.accessibleProjectIds()).toBeNull()
    expect(await scope.filter([1, 2], () => resource('task', 'x'))).toEqual([1, 2])
  })
})

describe('missing and ownerless: refused to everyone on a hub with login', () => {
  const refused: [ResourceKind, string, string][] = [
    ['project', 'nope', 'missing'],
    ['project', 'pU', 'unowned project (not backfilled)'],
    ['task', 'tU', 'task of an unowned project'],
    ['session', 'sPool', 'pooled agent session no task adopted yet'],
    ['session', 'random-uuid', 'unknown runtime key'],
    ['session', 'nope:tab', 'legacy key of a missing task'],
    ['turn', 'trOrphan', 'turn whose task was deleted'],
    ['process', 'prcGlobal', 'process with neither task nor project'],
    ['tab', 'some-uuid-tab', 'unknown tab'],
    ['path', join(hubRoot, 'slayzone.data.sqlite'), "the hub's own database file"],
    ['path', join(hubRoot, 'hub.owner.json'), "the hub's owner token"],
    ['path', hubRoot, "the hub's state directory itself"],
    ['path', '', 'an empty path'],
    ['computer', 'cU', 'unowned computer (nobody recorded minting its token)'],
    ['computer', 'nope', 'missing computer'],
    ['pathTree', aRoot, "a tree holding another user's nested project"],
    ['pathTree', base, "a tree holding the hub's state directory"]
  ]
  for (const [kind, id, what] of refused) {
    test(`${kind} — ${what}`, async () => {
      for (const who of [A, B, ADMIN]) expect(await can(who, kind, id)).toBe(false)
    })
  }
})

describe('how each kind finds its owner', () => {
  test('session: the agent-session row decides; else the legacy taskId:tabId key', async () => {
    expect(await can(A, 'session', 'tA:tabA')).toBe(true)
    expect(await can(B, 'session', 'tA:tabA')).toBe(false)
    expect(await can(B, 'session', 'tB:tB')).toBe(true)
  })
  test("tab: a task's main tab is named by the task id before its row exists", async () => {
    expect(await can(A, 'tab', 'tA')).toBe(true)
    expect(await can(B, 'tab', 'tA')).toBe(false)
  })
  test('process: by its task, else by its project', async () => {
    expect(await can(A, 'process', 'prcProject')).toBe(true)
    expect(await can(B, 'process', 'prcProject')).toBe(false)
  })
  test('aiConfigItem: a global library item is hub-wide', async () => {
    expect(await can(A, 'aiConfigItem', 'aiGlobal')).toBe(true)
    expect(await can(B, 'aiConfigItem', 'aiGlobal')).toBe(true)
  })
  test('projectGroup: an empty folder is hub-wide; a mixed one shows to each owner', async () => {
    expect(await can(B, 'projectGroup', 'gEmpty')).toBe(true)
    expect(await can(A, 'projectGroup', 'gMixed')).toBe(true)
    expect(await can(B, 'projectGroup', 'gMixed')).toBe(true)
    expect(await can(B, 'projectGroup', 'gA')).toBe(false)
  })
  test("path: inside a task's worktree, a project's path, or a computer placement", async () => {
    expect(await can(A, 'path', aWorktree)).toBe(true)
    expect(await can(A, 'path', join(aRoot, 'README.md'))).toBe(true)
    expect(await can(B, 'path', join(aRoot, 'README.md'))).toBe(false)
    expect(await can(B, 'path', join(placement, 'x'))).toBe(true)
    expect(await can(A, 'path', join(placement, 'x'))).toBe(false)
  })
  test('path: the most specific root decides (a project nested in another one is its own)', async () => {
    expect(await can(B, 'path', join(bNested, 'lib.ts'))).toBe(true)
    expect(await can(A, 'path', join(bNested, 'lib.ts'))).toBe(false)
  })
  test('path: `..` and symlinks are resolved before matching', async () => {
    expect(await can(B, 'path', join(bNested, '..', '..', 'README.md'))).toBe(false)
    const link = join(base, 'link-to-hub')
    symlinkSync(hubRoot, link)
    expect(await can(A, 'path', join(link, 'slayzone.data.sqlite'))).toBe(false)
    // …including a file that does not exist yet (about to be written through the link).
    expect(await can(A, 'path', join(link, 'planted', 'hub.config.json'))).toBe(false)
  })
  test('path: `..` after a symlink is where the OS goes, not where it is spelled (T-107)', async () => {
    mkdirSync(join(hubRoot, 'sub'), { recursive: true })
    const link = join(aRoot, 'sub-link')
    symlinkSync(join(hubRoot, 'sub'), link)
    // Spelled inside A's project; the OS walks the link, then `..`: the hub root.
    expect(await can(A, 'path', `${link}/../slayzone.data.sqlite`)).toBe(false)
    expect(await can(A, 'path', `${link}/../planted.json`)).toBe(false)
    // …and back out of the hub root to A's own file is A's again.
    expect(await can(A, 'path', `${link}/../../a-proj/README.md`)).toBe(true)
  })
  test('path: the SSO certificate and key are hub state wherever they live (T-107)', async () => {
    const secrets = join(base, 'secrets')
    mkdirSync(secrets, { recursive: true })
    const key = join(secrets, 'sso-key.pem')
    const cert = join(aRoot, 'sso-cert.pem') // even inside a user's project
    writeFileSync(key, '')
    writeFileSync(cert, '')
    const hubRoots = hubStateRoots([hubRoot], {
      SLAYZONE_HUB_SSO_KEY_PATH: key,
      SLAYZONE_HUB_SSO_CERT_PATH: cert
    })
    const may = (id: string, kind: ResourceKind = 'path') =>
      canAccess(db, { authRequired: true, principal: { userId: A }, hubRoots }, resource(kind, id))
    expect(await may(key)).toBe(false)
    expect(await may(cert)).toBe(false)
    const link = join(aRoot, 'key-link.pem')
    symlinkSync(key, link)
    expect(await may(link)).toBe(false)
    // The file, not its directory: a sibling stays what it was.
    expect(await may(join(secrets, 'other.txt'))).toBe(true)
    expect(await may(join(aRoot, 'README.md'))).toBe(true)
    // …but a walk of the directory would reach the key.
    expect(await may(secrets, 'pathTree')).toBe(false)
    expect(hubStateRoots([hubRoot, null, undefined], {})).toEqual([hubRoot])
  })
  test('pathTree: refused when any root under it is one the caller may not touch', async () => {
    expect(await can(A, 'pathTree', aWorktree)).toBe(true)
    expect(await can(A, 'pathTree', join(aRoot, 'vendor'))).toBe(false) // holds B's project
    expect(await can(B, 'pathTree', join(aRoot, 'vendor'))).toBe(false) // A's directory
    expect(await can(B, 'pathTree', bNested)).toBe(true)
    expect(await can(A, 'pathTree', join(base, 'elsewhere'))).toBe(true) // hub-wide, empty
    expect(await can(A, 'pathTree', base)).toBe(false) // holds the hub root
    expect(await can(A, 'pathTree', '/')).toBe(false)
  })
  test("path: inside nobody's project is hub-wide; an artifact file is its task's", async () => {
    expect(await can(A, 'path', join(base, 'elsewhere'))).toBe(true)
    expect(await can(B, 'path', '/usr/bin/git')).toBe(true)
    expect(await can(A, 'path', join(hubRoot, 'artifacts', 'tA', 'arA.md'))).toBe(true)
    expect(await can(B, 'path', join(hubRoot, 'artifacts', 'tA', 'arA.md'))).toBe(false)
  })
  test("path: a relative path is the hub process's own (cwd inside the hub root → refused)", async () => {
    const cwd = process.cwd()
    process.chdir(hubRoot)
    try {
      expect(await can(A, 'path', 'slayzone.data.sqlite')).toBe(false)
    } finally {
      process.chdir(cwd)
    }
  })
  test("path: a project registered inside the hub's directory keeps its own files; the rest stays refused", async () => {
    const inside = join(hubRoot, 'checkouts', 'a-inside')
    mkdirSync(inside, { recursive: true })
    sql(
      `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES ('pInside', 'I', '#111', ?, ?)`,
      A,
      inside
    )
    expect(await can(A, 'path', join(inside, 'x.ts'))).toBe(true)
    expect(await can(B, 'path', join(inside, 'x.ts'))).toBe(false)
    expect(await can(A, 'path', join(hubRoot, 'slayzone.data.sqlite'))).toBe(false)
    // A project AT the hub's directory does not open it: the hub wins a tie.
    sql(
      `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES ('pAtRoot', 'R', '#111', ?, ?)`,
      A,
      hubRoot
    )
    expect(await can(A, 'path', join(hubRoot, 'slayzone.data.sqlite'))).toBe(false)
    sql(`DELETE FROM projects WHERE id IN ('pInside', 'pAtRoot')`)
  })
  test("path: a Windows computer's path is compared as one, never as a hub path", async () => {
    expect(await can(A, 'path', 'C:\\Users\\a\\proj')).toBe(true)
  })
})

describe('scopes: many decisions for one request or one stream', () => {
  test('filter keeps the allowed rows and drops ownerless ones', async () => {
    const scope = createAccessScope(db, req(A))
    const rows = [{ p: 'pA' }, { p: 'pB' }, { p: null }, { p: 'pA2' }]
    const kept = await scope.filter(rows, (r) => (r.p ? resource('project', r.p) : null))
    expect(kept.map((r) => r.p)).toEqual(['pA', 'pA2'])
  })
  test('accessibleProjectIds: exactly the caller’s', async () => {
    const ids = await createAccessScope(db, req(A)).accessibleProjectIds()
    expect([...(ids ?? [])].sort()).toEqual(['pA', 'pA2'])
    expect(await createAccessScope(db, req(ADMIN)).accessibleProjectIds()).toEqual([])
  })
  test('a decided resource answers synchronously after the first query', async () => {
    const scope = createAccessScope(db, req(A), { ttlMs: 60_000 })
    expect(await scope.allows(resource('task', 'tA'))).toBe(true)
    expect(scope.allows(resource('task', 'tA'))).toBe(true)
  })
  test('invalidateAccessCache: a stream re-decides after an ownership change', async () => {
    const scope = createAccessScope(db, req(B), { ttlMs: 60_000 })
    expect(await scope.allows(resource('task', 'tA'))).toBe(false)
    sql(`UPDATE projects SET owner_user_id = ? WHERE id = 'pA'`, B)
    expect(scope.allows(resource('task', 'tA'))).toBe(false) // still the memo
    invalidateAccessCache()
    expect(await scope.allows(resource('task', 'tA'))).toBe(true)
    sql(`UPDATE projects SET owner_user_id = ? WHERE id = 'pA'`, A)
    invalidateAccessCache()
  })
  test('a stream picks up a session adopted by a task (pooled → bound) at once', async () => {
    const scope = createAccessScope(db, req(A), { ttlMs: 60_000 })
    expect(await scope.allows(resource('session', 'sPool'))).toBe(false)
    const { bindSessionToTask } = await import('@slayzone/task/server')
    await bindSessionToTask(db, { sessionId: 'sPool', taskId: 'tA', tabId: 'tabA' })
    expect(await scope.allows(resource('session', 'sPool'))).toBe(true)
  })
})

afterAll(() => {
  h.cleanup()
  rmSync(base, { recursive: true, force: true })
})
