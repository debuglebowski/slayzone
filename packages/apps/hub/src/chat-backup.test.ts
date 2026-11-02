import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { sanitizeHubChatBackup } from './chat-backup'

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
