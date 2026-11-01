import type { SlayzoneDb } from '@slayzone/platform'
import type { WorkspaceChangesEvent, WorkspaceChangesRecord } from '@slayzone/terminal-contracts'
import type { WorkspaceChangesStore } from './runtime/chat-workspace-tracker'

type Row = {
  id: string
  tab_id: string
  message_id: string
  computer_id: string | null
  root_path: string
  status: 'pending' | WorkspaceChangesRecord['status']
  reason: string | null
  files: string
}

export function createWorkspaceChangesStore(db: SlayzoneDb) {
  const store = {
    async remove(tabId: string, id: string) {
      await db.prepare('DELETE FROM chat_workspace_changes WHERE tab_id=? AND id=?').run(tabId, id)
    },
    async begin(record: Omit<WorkspaceChangesRecord, 'status'> & { status: 'pending' }) {
      await db
        .prepare(`INSERT INTO chat_workspace_changes (id,tab_id,message_id,computer_id,root_path,status,created_at)
        VALUES (?,?,?,?,?,'pending',?) ON CONFLICT(id) DO NOTHING`)
        .run(
          record.id,
          record.tabId,
          record.messageId,
          record.computerId,
          record.rootPath,
          Date.now()
        )
    },
    async save(record: WorkspaceChangesRecord) {
      const ops: Parameters<SlayzoneDb['batchTxn']>[0] = [
        {
          type: 'run',
          sql: `UPDATE chat_workspace_changes SET status=?, reason=?, files=? WHERE id=? AND tab_id=?`,
          params: [
            record.status,
            record.reason ?? null,
            JSON.stringify(
              record.files.map(({ diff, ...file }) => ({
                ...file,
                diff: null,
                hasDiff: diff !== null
              }))
            ),
            record.id,
            record.tabId
          ]
        },
        {
          type: 'run',
          sql: 'DELETE FROM chat_workspace_diffs WHERE capture_id=?',
          params: [record.id]
        }
      ]
      for (const file of record.files)
        if (file.diff !== null)
          ops.push({
            type: 'run',
            sql: 'INSERT INTO chat_workspace_diffs (capture_id,path,diff) VALUES (?,?,?)',
            params: [record.id, file.path, file.diff]
          })
      await db.batchTxn(ops)
    },
    async get(tabId: string, id: string) {
      const row = await db
        .prepare('SELECT * FROM chat_workspace_changes WHERE id=? AND tab_id=?')
        .get<Row>(id, tabId)
      if (!row) return null
      return {
        id: row.id,
        tabId: row.tab_id,
        messageId: row.message_id,
        computerId: row.computer_id,
        rootPath: row.root_path,
        status: row.status,
        ...(row.reason ? { reason: row.reason } : {}),
        files: JSON.parse(row.files) as WorkspaceChangesRecord['files']
      }
    },
    async getFileDiff(tabId: string, id: string, path: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT d.diff FROM chat_workspace_diffs d JOIN chat_workspace_changes c ON c.id=d.capture_id
        WHERE c.tab_id=? AND c.id=? AND d.path=?`)
        .get<{ diff: string }>(tabId, id, path)
      return row?.diff ?? null
    },
    async recover(tabId: string): Promise<WorkspaceChangesEvent[]> {
      const rows = await db
        .prepare("SELECT * FROM chat_workspace_changes WHERE tab_id=? AND status='pending'")
        .all<Row>(tabId)
      const reason = 'App restarted before workspace capture completed.'
      await db
        .prepare(
          "UPDATE chat_workspace_changes SET status='unavailable', reason=? WHERE tab_id=? AND status='pending'"
        )
        .run(reason, tabId)
      return rows.map((row) => ({
        kind: 'workspace-changes',
        tabId,
        captureId: row.id,
        messageId: row.message_id,
        status: 'unavailable',
        fileCount: 0,
        reason
      }))
    }
  } satisfies WorkspaceChangesStore
  return store
}
