import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

test('attachment references are backfilled, survive tab removal, and cascade with the task', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  try {
    for (const migration of migrations.filter((m) => m.version < 182)) migration.up(db)
    db.exec(`INSERT INTO projects (id, name, color) VALUES ('p', 'P', '#000');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T');
      INSERT INTO terminal_tabs (id, task_id, label, mode, position) VALUES ('tab', 't', 'Chat', 'codex-chat', 0);`)
    const attachment = {
      artifactId: 'a',
      contentHash: 'sealed',
      name: 'shot.png',
      kind: 'image',
      mediaType: 'image/png',
      size: 9
    }
    db.prepare('INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)').run(
      'tab',
      0,
      JSON.stringify({
        kind: 'user-message',
        id: 'm',
        text: 'private prompt',
        content: [
          { type: 'attachment', attachment },
          { type: 'text', text: 'private prompt' }
        ]
      })
    )
    migrations.find((m) => m.version === 182)!.up(db)
    const stored = db.prepare('SELECT attachments FROM chat_attachment_messages').get() as {
      attachments: string
    }
    expect(JSON.parse(stored.attachments)).toEqual([attachment])
    expect(stored.attachments).not.toContain('private prompt')
    db.exec("DELETE FROM terminal_tabs WHERE id = 'tab'")
    expect(db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get()).toEqual({ n: 1 })
    db.exec("DELETE FROM tasks WHERE id = 't'")
    expect(db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get()).toEqual({ n: 0 })
  } finally {
    db.close()
  }
})
