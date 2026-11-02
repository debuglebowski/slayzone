import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceSnapshotManager } from '@slayzone/agent-turns/workspace-capture'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness'
import { createWorkspaceChangesStore } from '../workspace-changes-store'
import * as mgr from './chat-transport-manager'
import {
  transportHarness,
  startTab,
  sendAndStart,
  emitLine,
  sj,
  until
} from './chat-transport-testkit'

afterEach(() => mgr.__resetForTests())

it('does not take a late final snapshot after an exit without confirmation', async () => {
  const h = transportHarness()
  let finalSnapshots = 0
  mgr.configureTransport({
    workspaceCapture: {
      begin: async () => ({ status: 'ready' }),
      finish: async () => {
        finalSnapshots++
        return { status: 'complete', files: [] }
      },
      discard: async () => {}
    },
    workspaceStore: { begin: async () => {}, save: async () => {}, get: async () => null }
  })
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'message')
  emitLine(f, sj.text('Working'))
  f.exit(null)
  await until(() => h.saved().some((e) => e.kind === 'workspace-changes' && e.status !== 'pending'))
  expect(finalSnapshots).toBe(0)
  expect(
    h
      .saved()
      .filter((e) => e.kind === 'workspace-changes')
      .at(-1)
  ).toMatchObject({ status: 'unavailable' })
})

it('saves shell changes through the real chat transport, and a second turn gets a fresh baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-workspace-integration-'))
  const db = await createTestHarness()
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'file.ts'), 'initial\n')
    git('add', '.')
    git('commit', '-qm', 'initial')
    writeFileSync(join(root, 'file.ts'), 'dirty baseline\n')
    db.db.prepare("INSERT INTO projects (id,name,color) VALUES ('p','P','#000')").run()
    db.db.prepare("INSERT INTO tasks (id,project_id,title) VALUES ('task','p','T')").run()
    db.db
      .prepare(
        "INSERT INTO terminal_tabs (id,task_id,mode,position) VALUES ('tab','task','claude-chat',0)"
      )
      .run()
    const h = transportHarness()
    const store = createWorkspaceChangesStore(db.slayDb)
    mgr.configureTransport({
      workspaceCapture: new WorkspaceSnapshotManager(),
      workspaceStore: store
    })
    await startTab({ cwd: root })
    const f = h.fakes[0]
    await sendAndStart(f, 'first')
    execFileSync('python3', ['-c', "open('file.ts','w').write('from shell\\n')"], { cwd: root })
    emitLine(f, sj.text('Done'))
    emitLine(f, sj.success('Done'))
    await until(
      () =>
        h
          .saved()
          .some(
            (e) =>
              e.kind === 'workspace-changes' && e.messageId === 'first' && e.status === 'complete'
          ),
      15000
    )
    const event = h.saved().find((e) => e.kind === 'workspace-changes' && e.status === 'complete')
    if (event?.kind !== 'workspace-changes') throw new Error('Missing saved observation')
    expect(event.fileCount).toBe(1)
    expect(h.saved().some((e) => e.kind === 'tool-call')).toBe(false)
    const patch = await store.getFileDiff('tab', event.captureId, 'file.ts')
    expect(patch).toContain('-dirty baseline')
    expect(patch).toContain('+from shell')
    git('add', '.')
    git('commit', '-qm', 'land')
    await sendAndStart(f, 'second')
    emitLine(f, sj.success('No edits'))
    await until(
      () =>
        h
          .saved()
          .some(
            (e) =>
              e.kind === 'workspace-changes' && e.messageId === 'second' && e.status === 'complete'
          ),
      15000
    )
    expect(
      h
        .saved()
        .filter((e) => e.kind === 'workspace-changes' && e.messageId === 'second')
        .at(-1)
    ).toMatchObject({ fileCount: 0 })
    expect(await store.getFileDiff('tab', event.captureId, 'file.ts')).toBe(patch)
    expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe('from shell\n')
  } finally {
    mgr.__resetForTests()
    db.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})
