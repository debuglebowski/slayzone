/**
 * Standalone-server smoke: drives a booted @slayzone/hub instance over its
 * real surfaces (tRPC WS, REST, MCP, health) and exits non-zero on any failure.
 *
 * Boot the target first (fresh store; ELECTRON_RUN_AS_NODE because the dev
 * tree's better-sqlite3 is built for Electron's ABI):
 *
 *   TMPD=$(mktemp -d)
 *   ELECTRON_RUN_AS_NODE=1 SLAYZONE_STORE_DIR=$TMPD SLAYZONE_PORT=4399 \
 *     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     packages/apps/hub/dist/bin.cjs &
 *
 * Then: npx tsx packages/apps/hub/scripts/standalone-smoke.mts 4399
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '@slayzone/transport/server'

const port = Number(process.argv[2] ?? 4399)
const base = `http://127.0.0.1:${port}`

let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}`, detail ?? '')
  }
}

// --- health ------------------------------------------------------------------
const health = await fetch(`${base}/health`)
check('GET /health → 200', health.status === 200)

// --- tRPC over WS --------------------------------------------------------------
const wsClient = createWSClient({ url: `ws://127.0.0.1:${port}/trpc` })
const trpc = createTRPCClient<AppRouter>({
  links: [wsLink({ client: wsClient, transformer: superjson })]
})

const tasks0 = await trpc.task.getAll.query()
check('trpc task.getAll → []', Array.isArray(tasks0) && tasks0.length === 0, tasks0)

const project = await trpc.projects.create.mutate({
  name: 'Smoke',
  color: '#10b981',
  path: '/tmp'
} as never)
check('trpc projects.create', !!project && typeof (project as { id?: string }).id === 'string')
const projectId = (project as { id: string }).id

// Exercises namedTxn ('task:insert-row') through SyncSlayzoneDb's registry dispatch.
const created = await trpc.task.create.mutate({ projectId, title: 'smoke task' } as never)
check('trpc task.create (namedTxn)', !!created && (created as { title?: string }).title === 'smoke task')

const tasks1 = await trpc.task.getAll.query()
check('trpc task.getAll → [task]', Array.isArray(tasks1) && tasks1.length === 1)

// Electron-only procedure → must fail loud, not hang.
const clipboardResult = await trpc.app.clipboard.hasFiles
  .query()
  .then(() => 'resolved' as const)
  .catch((err: Error) => err.message)
check(
  'trpc app.clipboard.hasFiles → standalone stub error',
  typeof clipboardResult === 'string' &&
    clipboardResult !== 'resolved' &&
    clipboardResult.includes('not available in standalone server'),
  clipboardResult
)

// pty runtime wired (6d2): exists answers (false — nothing spawned here).
const ptyExists = await trpc.pty.exists.query({ sessionId: 'nope:nope' } as never)
check('trpc pty.exists → false (runtime wired)', ptyExists === false, ptyExists)

// --- REST -----------------------------------------------------------------------
const restTasks = await fetch(`${base}/api/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectId, title: 'rest smoke task' })
})
const restBody = (await restTasks.json()) as { ok?: boolean; data?: { id?: string } }
check('POST /api/tasks → ok', restTasks.status === 200 && restBody.ok === true, restBody)

const restPty = await fetch(`${base}/api/pty`)
check(
  'GET /api/pty → 200 [] (pty slot wired)',
  restPty.status === 200 && Array.isArray(await restPty.json())
)

// Electron-shell capability still absent → 501.
const restBrowser = await fetch(`${base}/api/browser/url?taskId=x`)
check('GET /api/browser/url → 501 (no WCV)', restBrowser.status === 501)

const restProcs = await fetch(`${base}/api/processes`)
check(
  'GET /api/processes → 200 []',
  restProcs.status === 200 && Array.isArray(await restProcs.json())
)

const restNotify = await fetch(`${base}/api/notify`, { method: 'POST' })
check('POST /api/notify → ok', restNotify.status === 200)

// --- MCP (streamable HTTP initialize) ---------------------------------------------
const mcpInit = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0.0.0' }
    }
  })
})
const mcpSession = mcpInit.headers.get('mcp-session-id')
check('POST /mcp initialize → 200 + session id', mcpInit.status === 200 && !!mcpSession, {
  status: mcpInit.status,
  session: mcpSession
})

wsClient.close()
console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
