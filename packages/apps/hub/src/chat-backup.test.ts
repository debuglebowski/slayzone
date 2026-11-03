import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { sanitizeHubChatBackup } from './chat-backup'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from '../../../domains/chat-runtime/src/server/hub-ownership'
import { emulateWindowsFsync } from '../../../shared/test-utils/windows-fsync'

test('new hub snapshots contain metadata and general artifacts, no chat content or freed-page remnants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-backup-private-'))
  const path = join(dir, 'backup.sqlite'),
    secret = 'CHAT-PRIVATE-CONTENT-'.repeat(500)
  try {
    const db = new Database(path)
    db.exec(`CREATE TABLE tasks(id TEXT,title TEXT);
      CREATE TABLE task_artifacts(id TEXT,content TEXT);
      CREATE TABLE chat_events(tab_id TEXT,event TEXT);
      CREATE TABLE agent_prompts(id TEXT,text TEXT);
      CREATE TABLE agent_turns(id TEXT,prompt_preview TEXT);
      CREATE TABLE chat_threads(id TEXT,title TEXT);
      CREATE TABLE terminal_tabs(id TEXT,label TEXT);
      CREATE TRIGGER fence BEFORE DELETE ON chat_events BEGIN SELECT RAISE(ABORT,'fenced'); END;`)
    db.prepare('INSERT INTO tasks VALUES(?,?)').run('task', 'Task metadata')
    db.prepare('INSERT INTO task_artifacts VALUES(?,?)').run('file', 'General artifact stays')
    for (const table of [
      'chat_events',
      'agent_prompts',
      'agent_turns',
      'chat_threads',
      'terminal_tabs'
    ])
      db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run('thread', secret)
    db.close()
    await sanitizeHubChatBackup(path)
    const clean = new Database(path)
    expect(clean.prepare('SELECT * FROM tasks').all()).toEqual([
      { id: 'task', title: 'Task metadata' }
    ])
    expect(clean.prepare('SELECT * FROM task_artifacts').all()).toEqual([
      { id: 'file', content: 'General artifact stays' }
    ])
    expect(clean.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 0 })
    expect(clean.prepare('SELECT count(*) AS n FROM agent_prompts').get()).toEqual({ n: 0 })
    expect(clean.prepare('SELECT prompt_preview FROM agent_turns').get()).toEqual({
      prompt_preview: ''
    })
    expect(clean.prepare('SELECT title FROM chat_threads').get()).toEqual({ title: 'Thread' })
    expect(clean.prepare('SELECT label FROM terminal_tabs').get()).toEqual({ label: 'Thread' })
    expect(clean.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).toEqual([
      { name: 'fence' }
    ])
    clean.close()
    expect(readFileSync(path).includes(Buffer.from('CHAT-PRIVATE-CONTENT-'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mixed hub snapshots retain only pending recovery sources and erase committed content', async () => {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(tmpdir(), 'hub-backup-transition-'))
  const path = join(dir, 'backup.sqlite')
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('pending','p','Pending'),('owned','p','Owned'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('pending-tab','pending','claude-chat',0),('owned-tab','owned','claude-chat',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    for (const id of ['pending', 'owned']) {
      h.db
        .prepare('INSERT INTO chat_events(tab_id,seq,event,saved_at) VALUES(?,0,?,1)')
        .run(
          `${id}-tab`,
          JSON.stringify({ kind: 'assistant-text', messageId: 'm', text: `${id}-private-payload` })
        )
      await owners.register({
        id,
        taskId: id,
        tabId: `${id}-tab`,
        mode: 'claude-chat',
        computerId: id === 'owned' ? 'pc' : null,
        epoch: 1
      })
    }
    await h.db.backup(path)
    await sanitizeHubChatBackup(path)
    const snapshot = new Database(path, { readonly: true })
    try {
      expect(snapshot.prepare('SELECT tab_id FROM chat_events').all()).toEqual([
        { tab_id: 'pending-tab' }
      ])
      expect(h.db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 2 })
    } finally {
      snapshot.close()
    }
    expect(readFileSync(path).includes(Buffer.from('owned-private-payload'))).toBe(false)
    expect(readFileSync(path).includes(Buffer.from('pending-private-payload'))).toBe(true)
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows flush semantics: the sanitized snapshot is flushed through a writable handle', async () => {
  // FlushFileBuffers needs a writable handle; a read-only open made every hub backup EPERM on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'hub-backup-windows-fsync-'))
  const path = join(dir, 'backup.sqlite')
  try {
    const db = new Database(path)
    db.exec('CREATE TABLE tasks(id TEXT,title TEXT)')
    db.close()
    const restore = emulateWindowsFsync()
    try {
      await sanitizeHubChatBackup(path)
    } finally {
      restore()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
