#!/usr/bin/env node
/**
 * cap-02 RPC-level end-to-end validation. Drives the sidecar socket
 * directly (no browser UI) to exercise every write surface the TasklistHost /
 * ProjectsHost Mojo methods call into. Use alongside interactive UI
 * verification; this script proves the sidecar handlers + SQLite writes are
 * correct in isolation.
 *
 * Invoke (after `./node_modules/.bin/tsx packages/sidecar/src/bin/main.ts`
 * is running with SLAYZONE_SEED_DEMO=1):
 *   node scripts/chromium/cap-02-verify.mjs [socket_path]
 *
 * Uses NDJSON framing (packages/sidecar/src/server/framing.ts).
 */

import { connect } from 'node:net'

const socketPath = process.argv[2] ?? process.env.SIDECAR_SOCKET
if (!socketPath) {
  console.error('Usage: cap-02-verify.mjs <socket_path>')
  console.error('Set SIDECAR_SOCKET or pass the path as the first argument.')
  process.exit(2)
}

let nextId = 1
let buffer = ''
const pending = new Map()

const sock = connect(socketPath)
sock.setEncoding('utf8')
sock.on('data', (chunk) => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    idx = buffer.indexOf('\n')
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id)
        pending.delete(msg.id)
        resolve(msg)
      }
    } catch (err) {
      console.error('parse error:', err)
    }
  }
})
sock.on('error', (err) => {
  console.error('socket error:', err.message)
  process.exit(3)
})

function call(method, params = {}) {
  const id = nextId++
  const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  sock.write(frame)
  return new Promise((resolve) => {
    pending.set(id, { resolve })
  })
}

const ok = (msg) => '\x1b[32m✓\x1b[0m ' + msg
const bad = (msg) => '\x1b[31m✗\x1b[0m ' + msg
const log = (...args) => console.log(...args)

async function main() {
  // Wait a beat for the socket to settle.
  await new Promise((r) => setTimeout(r, 200))

  log('\n== EXIT CRITERION 1 — create project ==')
  const projCreate = await call('projects:create', { name: 'Cap02 Test', color: '#ff5722' })
  const createdProject = projCreate.result
  if (createdProject?.ok) {
    log(ok(`created project ${createdProject.project.id} (${createdProject.project.name})`))
  } else {
    log(bad('projects:create failed: ' + JSON.stringify(projCreate)))
    process.exit(1)
  }

  // Make the new project the active one so subsequent task creates land in it.
  await call('projects:set-active', { projectId: createdProject.project.id })

  log('\n== EXIT CRITERION 2 — create 3 tasks in 3 columns ==')
  const wanted = ['inbox', 'backlog', 'todo']
  const createdTasks = []
  for (const col of wanted) {
    const r = await call('tasks:create', { columnId: col, title: `${col} test task` })
    if (r.result?.ok) {
      log(ok(`created task ${r.result.task.id} in ${col}`))
      createdTasks.push(r.result.task)
    } else {
      log(bad(`tasks:create(${col}) failed: ` + JSON.stringify(r)))
      process.exit(1)
    }
  }

  log('\n== EXIT CRITERION 3 — edit task title ==')
  const target = createdTasks[0]
  const rename = await call('tasks:update', {
    taskId: target.id,
    title: 'renamed task',
    description: '',
  })
  if (rename.result?.ok && rename.result.task.title === 'renamed task') {
    log(ok(`renamed ${target.id} → "${rename.result.task.title}"`))
  } else {
    log(bad('tasks:update failed: ' + JSON.stringify(rename)))
    process.exit(1)
  }

  log('\n== EXIT CRITERION 4 — drag task to new column ==')
  const drag = await call('tasks:update-status', {
    taskId: createdTasks[1].id,
    columnId: 'in_progress',
  })
  if (drag.result?.ok && drag.result.task.status === 'in_progress') {
    log(ok(`moved ${createdTasks[1].id} → in_progress`))
  } else {
    log(bad('tasks:update-status failed: ' + JSON.stringify(drag)))
    process.exit(1)
  }

  log('\n== EXIT CRITERION 5 — delete task ==')
  const del = await call('tasks:delete', { taskId: createdTasks[2].id })
  if (del.result?.ok) {
    log(ok(`deleted ${createdTasks[2].id}`))
  } else {
    log(bad('tasks:delete failed: ' + JSON.stringify(del)))
    process.exit(1)
  }

  log('\n== EXIT CRITERION 6 — cross-region fan-out (snapshot comparison) ==')
  const before = await call('tasklist:get-snapshot')
  const edit = await call('tasks:update', {
    taskId: createdTasks[0].id,
    title: 'cross-region sentinel',
    description: '',
  })
  if (!edit.result?.ok) {
    log(bad('sentinel edit failed'))
    process.exit(1)
  }
  // Simulate a sibling region's poll — ask for a fresh snapshot.
  const after = await call('tasklist:get-snapshot')
  const beforeTitle = before.result.columns
    .flatMap((c) => c.tasks)
    .find((t) => t.id === createdTasks[0].id)?.title
  const afterTitle = after.result.columns
    .flatMap((c) => c.tasks)
    .find((t) => t.id === createdTasks[0].id)?.title
  if (afterTitle === 'cross-region sentinel' && beforeTitle !== afterTitle) {
    log(ok(`snapshot shifted "${beforeTitle}" → "${afterTitle}" within one RPC round-trip`))
  } else {
    log(bad(`propagation failed: before=${beforeTitle} after=${afterTitle}`))
    process.exit(1)
  }

  log('\n== tasklist:get-snapshot post-mutations ==')
  const final = await call('tasklist:get-snapshot')
  for (const col of final.result.columns) {
    if (col.tasks.length > 0) {
      log(`  ${col.id}: ${col.tasks.map((t) => t.id).join(', ')}`)
    }
  }

  log('\nall RPC exit-criterion assertions passed\n')
  sock.end()
}

main().catch((err) => {
  console.error('driver fatal:', err)
  process.exit(4)
})
