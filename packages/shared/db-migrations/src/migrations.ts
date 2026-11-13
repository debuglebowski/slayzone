import Database from 'better-sqlite3'
import { CONTENT_ERASURE_SCHEMA, CONTENT_ERASURE_ARTIFACT_FENCES } from './content-erasure-schema'
import { installContentErasureFences } from './content-erasure-fences'
// eslint-disable-next-line no-restricted-imports -- boot-time DB migration, finishes before the hub serves anything.
import { spawnSync } from 'node:child_process'
import { gitCommand } from '@slayzone/platform/resolve-command'
import { hubProcessesEnabled } from '@slayzone/platform/hub-switch-refusal'
import { randomUUID } from 'node:crypto'
// v78 uses a frozen copy of ai-config's frontmatter helpers (see the file header).
import {
  parseSkillFrontmatter,
  renderSkillFrontmatter,
  validateSkillFrontmatter
} from './frozen/v78-skill-frontmatter'

interface Migration {
  version: number
  up: (db: Database.Database) => void
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed JSON
  }
  return {}
}

function toTitleCaseFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'Skill'
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function deriveSkillDescription(slug: string, body: string): string {
  const firstContentLine = body.split('\n').find((line) => line.trim().length > 0)
  const headingText = firstContentLine?.replace(/^#+\s*/, '').trim() ?? ''
  return headingText || toTitleCaseFromSlug(slug)
}

function readCanonicalSkillMetadata(metadataJson: string): {
  frontmatter: Record<string, string>
  explicitFrontmatter: boolean
} | null {
  const parsed = parseJsonObject(metadataJson)
  const rawCanonical = parsed.skillCanonical
  if (!rawCanonical || typeof rawCanonical !== 'object' || Array.isArray(rawCanonical)) return null

  const canonical = rawCanonical as Record<string, unknown>
  const rawFrontmatter = canonical.frontmatter
  const frontmatter: Record<string, string> = {}
  if (rawFrontmatter && typeof rawFrontmatter === 'object' && !Array.isArray(rawFrontmatter)) {
    for (const [key, value] of Object.entries(rawFrontmatter as Record<string, unknown>)) {
      if (typeof value === 'string') frontmatter[key] = value
      else if (value !== undefined && value !== null) frontmatter[key] = String(value)
    }
  }

  return {
    frontmatter,
    explicitFrontmatter: canonical.explicitFrontmatter === true
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'inbox',
          priority INTEGER NOT NULL DEFAULT 3,
          due_date TEXT,
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE workspace_items (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          content TEXT,
          url TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_tasks_project ON tasks(project_id);
        CREATE INDEX idx_tasks_parent ON tasks(parent_id);
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_workspace_task ON workspace_items(task_id);
      `)
    }
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL DEFAULT '#6b7280',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE task_tags (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, tag_id)
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_task_tags_task ON task_tags(task_id);
        CREATE INDEX idx_task_tags_tag ON task_tags(tag_id);
      `)
    }
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY,
          workspace_item_id TEXT NOT NULL REFERENCES workspace_items(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_chat_messages_workspace ON chat_messages(workspace_item_id);
      `)
    }
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN archived_at TEXT DEFAULT NULL;
        CREATE INDEX idx_tasks_archived ON tasks(archived_at);
      `)
    }
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN recurrence_type TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN last_reset_at TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN next_reset_at TEXT DEFAULT NULL;
        CREATE INDEX idx_tasks_recurring ON tasks(next_reset_at) WHERE recurrence_type IS NOT NULL;
      `)
    }
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        ALTER TABLE workspace_items ADD COLUMN favicon TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN last_active_workspace_item_id TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 8,
    up: (db) => {
      // Cleanup: remove unused tables and columns
      db.exec(`
        DROP TABLE IF EXISTS chat_messages;
        DROP TABLE IF EXISTS workspace_items;
        DROP INDEX IF EXISTS idx_tasks_parent;
        DROP INDEX IF EXISTS idx_tasks_recurring;
        ALTER TABLE tasks DROP COLUMN parent_id;
        ALTER TABLE tasks DROP COLUMN blocked_reason;
        ALTER TABLE tasks DROP COLUMN recurrence_type;
        ALTER TABLE tasks DROP COLUMN recurrence_interval;
        ALTER TABLE tasks DROP COLUMN last_reset_at;
        ALTER TABLE tasks DROP COLUMN next_reset_at;
        ALTER TABLE tasks DROP COLUMN last_active_workspace_item_id;
      `)
    }
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN path TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN claude_session_id TEXT DEFAULT NULL;

        CREATE TABLE task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          blocks_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, blocks_task_id)
        );

        CREATE INDEX idx_task_deps_task ON task_dependencies(task_id);
        CREATE INDEX idx_task_deps_blocks ON task_dependencies(blocks_task_id);
      `)
    }
  },
  {
    version: 10,
    up: (db) => {
      db.exec(`
        CREATE TABLE terminal_sessions (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          buffer TEXT NOT NULL,
          serialized_state TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    }
  },
  {
    version: 11,
    up: (db) => {
      // Add terminal mode columns
      // Rename claude_session_id to claude_conversation_id (SQLite doesn't support direct rename, so add new + migrate)
      db.exec(`
        ALTER TABLE tasks ADD COLUMN terminal_mode TEXT DEFAULT 'claude-code';
        ALTER TABLE tasks ADD COLUMN claude_conversation_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN codex_conversation_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN terminal_shell TEXT DEFAULT NULL;
      `)
      // Migrate data from old column to new
      db.exec(`
        UPDATE tasks SET claude_conversation_id = claude_session_id WHERE claude_session_id IS NOT NULL;
      `)
      // Note: SQLite doesn't support DROP COLUMN in older versions, keep claude_session_id for backwards compat
    }
  },
  {
    version: 12,
    up: (db) => {
      // Remove unused terminal_sessions table - sessions are now handled entirely in-memory
      db.exec(`DROP TABLE IF EXISTS terminal_sessions;`)
    }
  },
  {
    version: 13,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;`)
      db.exec(`UPDATE tasks SET "order" = rowid;`)
    }
  },
  {
    version: 14,
    up: (db) => {
      db.exec(
        `ALTER TABLE tasks ADD COLUMN dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0;`
      )
    }
  },
  {
    version: 15,
    up: (db) => {
      db.exec(`
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          branch TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX idx_worktrees_task ON worktrees(task_id);
      `)
    }
  },
  {
    version: 16,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN panel_visibility TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 17,
    up: (db) => {
      // Add worktree_path and browser_url to tasks
      db.exec(`
        ALTER TABLE tasks ADD COLUMN worktree_path TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN browser_url TEXT DEFAULT NULL;
      `)
      // Migrate existing worktree paths to tasks
      db.exec(`
        UPDATE tasks
        SET worktree_path = (
          SELECT path FROM worktrees WHERE worktrees.task_id = tasks.id
        )
        WHERE id IN (SELECT task_id FROM worktrees)
      `)
      // Drop worktrees table
      db.exec(`
        DROP INDEX IF EXISTS idx_worktrees_task;
        DROP TABLE IF EXISTS worktrees;
      `)
    }
  },
  {
    version: 18,
    up: (db) => {
      // Add browser_tabs JSON column for multi-tab browser support
      db.exec(`ALTER TABLE tasks ADD COLUMN browser_tabs TEXT DEFAULT NULL;`)

      // Migrate existing browser_url values to browser_tabs JSON
      // Using task_id as tab id since we need deterministic IDs in migration
      const tasks = db
        .prepare(
          `SELECT id, browser_url FROM tasks WHERE browser_url IS NOT NULL AND browser_url != ''`
        )
        .all() as Array<{ id: string; browser_url: string }>
      const updateStmt = db.prepare(`UPDATE tasks SET browser_tabs = ? WHERE id = ?`)
      for (const task of tasks) {
        const tabId = `tab-${task.id.slice(0, 8)}`
        const browserTabs = JSON.stringify({
          tabs: [{ id: tabId, url: task.browser_url, title: task.browser_url }],
          activeTabId: tabId
        })
        updateStmt.run(browserTabs, task.id)
      }
    }
  },
  {
    version: 19,
    up: (db) => {
      // Create terminal_tabs table for multi-tab terminal support
      // Use IF NOT EXISTS to handle partial migration state
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_tabs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          label TEXT,
          mode TEXT NOT NULL DEFAULT 'terminal',
          is_main INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_terminal_tabs_task ON terminal_tabs(task_id);
      `)

      // Create main tab for each existing task using its terminal_mode
      // Use taskId as tab id (unique since each task has one main tab)
      // Use INSERT OR IGNORE to skip tasks that already have a main tab
      const tasks = db.prepare(`SELECT id, terminal_mode FROM tasks`).all() as Array<{
        id: string
        terminal_mode: string | null
      }>
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO terminal_tabs (id, task_id, label, mode, is_main, position, created_at)
        VALUES (?, ?, NULL, ?, 1, 0, datetime('now'))
      `)
      for (const task of tasks) {
        insertStmt.run(task.id, task.id, task.terminal_mode || 'claude-code')
      }
    }
  },
  {
    version: 20,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN worktree_parent_branch TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 21,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN claude_flags TEXT NOT NULL DEFAULT '';
        ALTER TABLE tasks ADD COLUMN codex_flags TEXT NOT NULL DEFAULT '';
      `)
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'default_claude_flags',
        '--allow-dangerously-skip-permissions'
      )
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'default_codex_flags',
        '--sandbox workspace-write'
      )
    }
  },
  {
    version: 22,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS diagnostics_events (
          id TEXT PRIMARY KEY,
          ts_ms INTEGER NOT NULL,
          level TEXT NOT NULL,
          source TEXT NOT NULL,
          event TEXT NOT NULL,
          trace_id TEXT,
          task_id TEXT,
          project_id TEXT,
          session_id TEXT,
          channel TEXT,
          message TEXT,
          payload_json TEXT,
          redaction_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_diag_ts ON diagnostics_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_diag_level_ts ON diagnostics_events(level, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_diag_trace ON diagnostics_events(trace_id);
        CREATE INDEX IF NOT EXISTS idx_diag_source_event_ts ON diagnostics_events(source, event, ts_ms);
      `)

      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'diagnostics_enabled',
        '1'
      )
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'diagnostics_verbose',
        '0'
      )
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'diagnostics_include_pty_output',
        '0'
      )
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'diagnostics_retention_days',
        '14'
      )
    }
  },
  {
    version: 23,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN merge_state TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 24,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_config_items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          scope TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_config_items_scope_type ON ai_config_items(scope, type);
        CREATE INDEX IF NOT EXISTS idx_ai_config_items_project ON ai_config_items(project_id);

        CREATE TABLE IF NOT EXISTS ai_config_project_selections (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL REFERENCES ai_config_items(id) ON DELETE CASCADE,
          target_path TEXT NOT NULL,
          selected_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_config_sel_project ON ai_config_project_selections(project_id);
        CREATE INDEX IF NOT EXISTS idx_ai_config_sel_item ON ai_config_project_selections(item_id);

        CREATE TABLE IF NOT EXISTS ai_config_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'placeholder',
          last_checked_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    }
  },
  {
    version: 25,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN assignee TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 26,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS integration_connections (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          workspace_name TEXT NOT NULL,
          account_label TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_synced_at TEXT DEFAULT NULL,
          UNIQUE(provider, workspace_id)
        );
        CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
          ON integration_connections(provider, updated_at);

        CREATE TABLE IF NOT EXISTS integration_project_mappings (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
          external_team_id TEXT NOT NULL,
          external_team_key TEXT NOT NULL,
          external_project_id TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_integration_project_mappings_connection
          ON integration_project_mappings(connection_id);

        CREATE TABLE IF NOT EXISTS external_links (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
          external_type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          external_key TEXT NOT NULL,
          external_url TEXT NOT NULL DEFAULT '',
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          sync_state TEXT NOT NULL DEFAULT 'active',
          last_sync_at TEXT DEFAULT NULL,
          last_error TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider, connection_id, external_id),
          UNIQUE(provider, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_external_links_connection_state
          ON external_links(connection_id, sync_state, updated_at);
        CREATE INDEX IF NOT EXISTS idx_external_links_task
          ON external_links(task_id);

        CREATE TABLE IF NOT EXISTS external_field_state (
          id TEXT PRIMARY KEY,
          external_link_id TEXT NOT NULL REFERENCES external_links(id) ON DELETE CASCADE,
          field_name TEXT NOT NULL,
          last_local_value_json TEXT NOT NULL DEFAULT 'null',
          last_external_value_json TEXT NOT NULL DEFAULT 'null',
          last_local_updated_at TEXT NOT NULL,
          last_external_updated_at TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(external_link_id, field_name)
        );
        CREATE INDEX IF NOT EXISTS idx_external_field_state_link
          ON external_field_state(external_link_id);

        CREATE TABLE IF NOT EXISTS integration_state_mappings (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          project_mapping_id TEXT NOT NULL REFERENCES integration_project_mappings(id) ON DELETE CASCADE,
          local_status TEXT NOT NULL,
          state_id TEXT NOT NULL,
          state_type TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider, project_mapping_id, local_status)
        );
      `)
    }
  },
  {
    version: 27,
    up: (db) => {
      db.exec(`
        ALTER TABLE integration_project_mappings
          ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'one_way';
      `)
    }
  },
  {
    version: 28,
    up: (db) => {
      db.exec(`
        ALTER TABLE projects
          ADD COLUMN auto_create_worktree_on_task_create INTEGER DEFAULT NULL;
      `)
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'auto_create_worktree_on_task_create',
        '0'
      )
    }
  },
  {
    version: 29,
    up: (db) => {
      db.prepare(
        `UPDATE settings SET value = '--allow-dangerously-skip-permissions' WHERE key = 'default_claude_flags' AND value = '--dangerously-skip-permissions'`
      ).run()
      db.prepare(
        `UPDATE tasks SET claude_flags = '--allow-dangerously-skip-permissions' WHERE claude_flags = '--dangerously-skip-permissions'`
      ).run()
    }
  },
  {
    version: 30,
    up: (db) => {
      // Recreate ai_config_project_selections with provider + content_hash columns
      db.exec(`
        CREATE TABLE ai_config_project_selections_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL REFERENCES ai_config_items(id) ON DELETE CASCADE,
          provider TEXT NOT NULL DEFAULT 'claude',
          target_path TEXT NOT NULL,
          content_hash TEXT DEFAULT NULL,
          selected_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, item_id, provider)
        );
        INSERT INTO ai_config_project_selections_new (id, project_id, item_id, provider, target_path, selected_at)
          SELECT id, project_id, item_id, 'claude', target_path, selected_at
          FROM ai_config_project_selections;
        DROP TABLE ai_config_project_selections;
        ALTER TABLE ai_config_project_selections_new RENAME TO ai_config_project_selections;
        CREATE INDEX idx_ai_config_sel_project ON ai_config_project_selections(project_id);
        CREATE INDEX idx_ai_config_sel_item ON ai_config_project_selections(item_id);
      `)

      // Seed CLI providers into existing ai_config_sources table
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`
      )
      stmt.run('provider-claude', 'Claude Code', 'claude', 1, 'active')
      stmt.run('provider-codex', 'Codex', 'codex', 0, 'active')
      stmt.run('provider-gemini', 'Gemini', 'gemini', 0, 'placeholder')
    }
  },
  {
    version: 31,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN parent_id TEXT DEFAULT NULL REFERENCES tasks(id) ON DELETE CASCADE;
        CREATE INDEX idx_tasks_parent ON tasks(parent_id);
      `)
    }
  },
  {
    version: 32,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN web_panel_urls TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 33,
    up: (db) => {
      // Add conversation ID + flags columns for new providers
      db.exec(`
        ALTER TABLE tasks ADD COLUMN cursor_conversation_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN gemini_conversation_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN opencode_conversation_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN cursor_flags TEXT NOT NULL DEFAULT '--force';
        ALTER TABLE tasks ADD COLUMN gemini_flags TEXT NOT NULL DEFAULT '--yolo';
        ALTER TABLE tasks ADD COLUMN opencode_flags TEXT NOT NULL DEFAULT '';
      `)

      // Default flag settings
      const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
      stmt.run('default_cursor_flags', '--force')
      stmt.run('default_gemini_flags', '--yolo')
      stmt.run('default_opencode_flags', '')

      // Seed new CLI providers into ai_config_sources
      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`
      )
      insertStmt.run('provider-cursor', 'Cursor Agent', 'cursor', 0, 'active')
      insertStmt.run('provider-opencode', 'OpenCode', 'opencode', 0, 'active')

      // Activate gemini (was seeded as 'placeholder' in v30)
      db.prepare(`UPDATE ai_config_sources SET status = 'active' WHERE kind = 'gemini'`).run()
    }
  },
  {
    version: 34,
    up: (db) => {
      // Add provider_config JSON column — consolidates all per-provider conversation_id + flags
      db.exec(`ALTER TABLE tasks ADD COLUMN provider_config TEXT NOT NULL DEFAULT '{}'`)

      // Migrate existing per-provider data into provider_config
      const tasks = db
        .prepare(`
        SELECT id,
          claude_conversation_id, codex_conversation_id, cursor_conversation_id,
          gemini_conversation_id, opencode_conversation_id,
          claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags
        FROM tasks
      `)
        .all() as Array<{
        id: string
        claude_conversation_id: string | null
        codex_conversation_id: string | null
        cursor_conversation_id: string | null
        gemini_conversation_id: string | null
        opencode_conversation_id: string | null
        claude_flags: string
        codex_flags: string
        cursor_flags: string
        gemini_flags: string
        opencode_flags: string
      }>

      const updateStmt = db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
      for (const task of tasks) {
        const config: Record<string, { conversationId?: string | null; flags?: string }> = {}
        const providers = [
          { mode: 'claude-code', convId: task.claude_conversation_id, flags: task.claude_flags },
          { mode: 'codex', convId: task.codex_conversation_id, flags: task.codex_flags },
          { mode: 'cursor-agent', convId: task.cursor_conversation_id, flags: task.cursor_flags },
          { mode: 'gemini', convId: task.gemini_conversation_id, flags: task.gemini_flags },
          { mode: 'opencode', convId: task.opencode_conversation_id, flags: task.opencode_flags }
        ]
        for (const p of providers) {
          if (p.convId || p.flags) {
            config[p.mode] = {}
            if (p.convId) config[p.mode].conversationId = p.convId
            if (p.flags) config[p.mode].flags = p.flags
          }
        }
        updateStmt.run(JSON.stringify(config), task.id)
      }

      // Old columns kept for backwards compat — drop in future v35
    }
  },
  {
    version: 35,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 36,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN merge_context TEXT DEFAULT NULL`)
    }
  },
  {
    version: 37,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN editor_open_files TEXT DEFAULT NULL`)
    }
  },
  {
    version: 38,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN web_panel_resolutions TEXT DEFAULT NULL`)
    }
  },
  {
    version: 39,
    up: (db) => {
      db.exec(`ALTER TABLE terminal_tabs ADD COLUMN group_id TEXT`)
      // Backfill: each existing tab becomes its own group
      db.exec(`UPDATE terminal_tabs SET group_id = id WHERE group_id IS NULL`)
    }
  },
  {
    version: 40,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processes (
          id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL DEFAULT '',
          auto_restart INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_processes_task ON processes(task_id);
      `)
    }
  },
  {
    // diagnostics_events moved to slayzone.dev.diagnostics.sqlite (separate DB)
    // to prevent CLI REST notify → tasks:changed → IPC diagnostic write → REST notify → loop
    version: 41,
    up: (db) => {
      db.exec(`DROP TABLE IF EXISTS diagnostics_events`)
    }
  },
  {
    version: 42,
    up: (db) => {
      // Idempotent for drifted local DBs where column exists but user_version < 42.
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{
        name: string
      }>
      const hasColumnsConfig = projectColumns.some((column) => column.name === 'columns_config')
      if (!hasColumnsConfig) {
        db.exec(`ALTER TABLE projects ADD COLUMN columns_config TEXT DEFAULT NULL`)
      }
    }
  },
  {
    version: 43,
    up: (db) => {
      // Codex is temporarily not configurable in ai-config.
      // Clean legacy persisted state so storage matches current behavior.

      // 1) Remove codex-linked project selections.
      db.prepare(`DELETE FROM ai_config_project_selections WHERE provider = 'codex'`).run()

      // 2) Ensure codex is globally disabled in provider source state.
      db.prepare(
        `UPDATE ai_config_sources SET enabled = 0, updated_at = datetime('now') WHERE kind = 'codex'`
      ).run()

      // 3) Strip codex from per-project provider settings payloads.
      const rows = db
        .prepare(`
        SELECT key, value
        FROM settings
        WHERE key LIKE 'ai_providers:%'
      `)
        .all() as Array<{ key: string; value: string }>
      const updateStmt = db.prepare(`UPDATE settings SET value = ? WHERE key = ?`)

      for (const row of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row.value)
        } catch {
          continue
        }
        if (!Array.isArray(parsed)) continue

        const filtered = parsed.filter(
          (provider): provider is string => typeof provider === 'string' && provider !== 'codex'
        )
        if (filtered.length !== parsed.length) {
          updateStmt.run(JSON.stringify(filtered), row.key)
        }
      }
    }
  },
  {
    version: 44,
    up: (db) => {
      // Remove legacy providers that are no longer supported in ai-config.
      const removedProviders = ['aider', 'grok']

      // 1) Remove provider rows.
      db.prepare(`
        DELETE FROM ai_config_sources
        WHERE kind IN (${removedProviders.map(() => '?').join(', ')})
      `).run(...removedProviders)

      // 2) Remove project selections linked to removed providers.
      db.prepare(`
        DELETE FROM ai_config_project_selections
        WHERE provider IN (${removedProviders.map(() => '?').join(', ')})
      `).run(...removedProviders)

      // 3) Strip removed providers from per-project provider settings payloads.
      const rows = db
        .prepare(`
        SELECT key, value
        FROM settings
        WHERE key LIKE 'ai_providers:%'
      `)
        .all() as Array<{ key: string; value: string }>
      const updateStmt = db.prepare(`UPDATE settings SET value = ? WHERE key = ?`)
      const removedSet = new Set(removedProviders)

      for (const row of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row.value)
        } catch {
          continue
        }
        if (!Array.isArray(parsed)) continue

        const filtered = parsed.filter(
          (provider): provider is string =>
            typeof provider === 'string' && !removedSet.has(provider)
        )
        if (filtered.length !== parsed.length) {
          updateStmt.run(JSON.stringify(filtered), row.key)
        }
      }
    }
  },
  {
    version: 45,
    up: (db) => {
      // Repair drifted schemas where user_version was already 42+ but projects.columns_config was never created.
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{
        name: string
      }>
      const hasColumnsConfig = projectColumns.some((column) => column.name === 'columns_config')
      if (!hasColumnsConfig) {
        db.exec(`ALTER TABLE projects ADD COLUMN columns_config TEXT DEFAULT NULL`)
      }
    }
  },
  {
    version: 46,
    up: (db) => {
      // Enforce unique item slugs per logical scope after repairing any legacy duplicates.
      const rows = db
        .prepare(`
        SELECT id, scope, project_id, type, slug
        FROM ai_config_items
        ORDER BY created_at ASC, id ASC
      `)
        .all() as Array<{
        id: string
        scope: 'global' | 'project'
        project_id: string | null
        type: string
        slug: string
      }>

      const updateSlug = db.prepare(
        "UPDATE ai_config_items SET slug = ?, name = ?, updated_at = datetime('now') WHERE id = ?"
      )
      const seenByBucket = new Map<string, Set<string>>()

      for (const row of rows) {
        const bucket =
          row.scope === 'global'
            ? `global:${row.type}`
            : `project:${row.project_id ?? ''}:${row.type}`
        const seen = seenByBucket.get(bucket) ?? new Set<string>()
        seenByBucket.set(bucket, seen)

        const baseSlug = row.slug || 'untitled'
        if (!seen.has(baseSlug)) {
          seen.add(baseSlug)
          continue
        }

        let suffix = 2
        let nextSlug = `${baseSlug}-${suffix}`
        while (seen.has(nextSlug)) {
          suffix += 1
          nextSlug = `${baseSlug}-${suffix}`
        }

        updateSlug.run(nextSlug, nextSlug, row.id)
        seen.add(nextSlug)
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_config_items_global_type_slug
          ON ai_config_items(type, slug)
          WHERE scope = 'global';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_config_items_project_project_type_slug
          ON ai_config_items(project_id, type, slug)
          WHERE scope = 'project';
      `)
    }
  },
  {
    version: 47,
    up: (db) => {
      // Canonicalize legacy slugs (normalize format + preserve uniqueness) per logical scope/type bucket.
      // v46 already introduced unique slug indexes, so drop/recreate them around normalization
      // to avoid transient collisions while renaming rows into canonical form.
      db.exec(`
        DROP INDEX IF EXISTS ux_ai_config_items_global_type_slug;
        DROP INDEX IF EXISTS ux_ai_config_items_project_project_type_slug;
      `)

      const normalizeSlug = (value: string): string => {
        return (
          value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'untitled'
        )
      }

      const rows = db
        .prepare(`
        SELECT id, scope, project_id, type, slug
        FROM ai_config_items
        ORDER BY created_at ASC, id ASC
      `)
        .all() as Array<{
        id: string
        scope: 'global' | 'project'
        project_id: string | null
        type: string
        slug: string
      }>

      const updateSlug = db.prepare(
        "UPDATE ai_config_items SET slug = ?, name = ?, updated_at = datetime('now') WHERE id = ?"
      )
      const seenByBucket = new Map<string, Set<string>>()

      for (const row of rows) {
        const bucket =
          row.scope === 'global'
            ? `global:${row.type}`
            : `project:${row.project_id ?? ''}:${row.type}`
        const seen = seenByBucket.get(bucket) ?? new Set<string>()
        seenByBucket.set(bucket, seen)

        const baseSlug = normalizeSlug(row.slug || 'untitled')
        let nextSlug = baseSlug
        if (seen.has(nextSlug)) {
          let suffix = 2
          nextSlug = `${baseSlug}-${suffix}`
          while (seen.has(nextSlug)) {
            suffix += 1
            nextSlug = `${baseSlug}-${suffix}`
          }
        }

        if (nextSlug !== row.slug) {
          updateSlug.run(nextSlug, nextSlug, row.id)
        }
        seen.add(nextSlug)
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_config_items_global_type_slug
          ON ai_config_items(type, slug)
          WHERE scope = 'global';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_config_items_project_project_type_slug
          ON ai_config_items(project_id, type, slug)
          WHERE scope = 'project';
      `)
    }
  },
  {
    version: 48,
    up: (db) => {
      // Remove legacy 'command' items and orphaned selections
      db.exec(`
        DELETE FROM ai_config_project_selections
          WHERE item_id IN (SELECT id FROM ai_config_items WHERE type = 'command');
        DELETE FROM ai_config_items WHERE type = 'command';
      `)
    }
  },
  {
    version: 49,
    up: (db) => {
      db.exec(`
        DELETE FROM processes WHERE task_id IS NULL;
        ALTER TABLE processes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_processes_project ON processes(project_id);
      `)
    }
  },
  {
    version: 50,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN deleted_at TEXT DEFAULT NULL`)
    }
  },
  {
    version: 51,
    up: (db) => {
      // Idempotent for drifted local DBs where column exists but user_version < 51.
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{
        name: string
      }>
      const hasWorktreeSourceBranch = projectColumns.some(
        (column) => column.name === 'worktree_source_branch'
      )
      if (!hasWorktreeSourceBranch) {
        db.exec(`ALTER TABLE projects ADD COLUMN worktree_source_branch TEXT DEFAULT NULL`)
      }
    }
  },
  {
    version: 52,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN execution_context TEXT DEFAULT NULL`)
    }
  },
  {
    version: 53,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN ccs_profile TEXT DEFAULT NULL`)
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        'ccs_enabled',
        '0'
      )
    }
  },
  {
    // CCS is now its own terminal mode — migrate ccs_profile to provider_config['ccs'].flags
    version: 54,
    up: (db) => {
      // Copy ccs_profile into provider_config for tasks that had a profile set
      db.exec(`
        UPDATE tasks
        SET provider_config = json_set(COALESCE(provider_config, '{}'), '$.ccs', json_object('flags', ccs_profile))
        WHERE ccs_profile IS NOT NULL AND ccs_profile != ''
      `)
    }
  },
  {
    version: 55,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_modes (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          type TEXT NOT NULL,
          command TEXT,
          args TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          is_builtin INTEGER NOT NULL DEFAULT 0,
          "order" INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      // Data seeding handled by syncTerminalModes() on startup
    }
  },
  {
    version: 56,
    up: (db) => {
      // Simplify integration connections: keep only provider + credential reference metadata.
      db.exec(`PRAGMA foreign_keys = OFF;`)
      db.exec(`
        CREATE TABLE IF NOT EXISTS integration_connections_next (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_synced_at TEXT DEFAULT NULL
        );

        INSERT INTO integration_connections_next (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        )
        SELECT
          id,
          provider,
          credential_ref,
          enabled,
          COALESCE(created_at, datetime('now')),
          COALESCE(updated_at, datetime('now')),
          last_synced_at
        FROM integration_connections;

        DROP TABLE integration_connections;
        ALTER TABLE integration_connections_next RENAME TO integration_connections;

        CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
          ON integration_connections(provider, updated_at);
      `)
      db.exec(`PRAGMA foreign_keys = ON;`)
    }
  },
  {
    version: 57,
    up: (db) => {
      db.exec(`
        ALTER TABLE terminal_modes ADD COLUMN pattern_attention TEXT;
        ALTER TABLE terminal_modes ADD COLUMN pattern_working TEXT;
        ALTER TABLE terminal_modes ADD COLUMN pattern_error TEXT;
      `)
    }
  },
  {
    version: 58,
    up: (db) => {
      db.exec(`
        ALTER TABLE terminal_modes ADD COLUMN resume_command TEXT;
      `)
    }
  },
  {
    version: 59,
    up: (db) => {
      db.exec(`
        CREATE TABLE terminal_modes_new (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          type TEXT NOT NULL,
          initial_command TEXT,
          resume_command TEXT,
          default_flags TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          is_builtin INTEGER NOT NULL DEFAULT 0,
          "order" INTEGER NOT NULL DEFAULT 0,
          pattern_attention TEXT,
          pattern_working TEXT,
          pattern_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO terminal_modes_new (id, label, type, initial_command, resume_command, default_flags, enabled, is_builtin, "order", pattern_attention, pattern_working, pattern_error, created_at, updated_at)
        SELECT id, label, type,
          CASE
            WHEN is_builtin = 0 AND command IS NOT NULL THEN command || ' {flags}'
            ELSE NULL
          END,
          resume_command,
          args,
          enabled, is_builtin, "order", pattern_attention, pattern_working, pattern_error, created_at, updated_at
        FROM terminal_modes;

        DROP TABLE terminal_modes;
        ALTER TABLE terminal_modes_new RENAME TO terminal_modes;
      `)
    }
  },
  {
    version: 60,
    up: (db) => {
      db.exec(`UPDATE tasks SET terminal_mode = 'claude-code' WHERE terminal_mode = 'terminal'`)
    }
  },
  {
    // Migrate legacy settings.default_*_flags → terminal_modes.default_flags
    // so terminal_modes becomes the single source of truth for default flags.
    version: 61,
    up: (db) => {
      const mapping: Array<[string, string]> = [
        ['default_claude_flags', 'claude-code'],
        ['default_codex_flags', 'codex'],
        ['default_cursor_flags', 'cursor-agent'],
        ['default_gemini_flags', 'gemini'],
        ['default_opencode_flags', 'opencode']
      ]
      const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
      const updateMode = db.prepare('UPDATE terminal_modes SET default_flags = ? WHERE id = ?')
      for (const [settingsKey, modeId] of mapping) {
        const row = readSetting.get(settingsKey) as { value: string } | undefined
        if (row) {
          updateMode.run(row.value, modeId)
        }
      }
    }
  },
  {
    version: 62,
    up: (db) => {
      db.exec(`
        CREATE TABLE test_categories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          pattern TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6b7280',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_test_categories_project ON test_categories(project_id);
      `)
    }
  },
  {
    version: 63,
    up: (db) => {
      db.exec(`
        CREATE TABLE test_labels (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6b7280',
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_test_labels_project ON test_labels(project_id);

        CREATE TABLE test_file_labels (
          project_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          label_id TEXT NOT NULL REFERENCES test_labels(id) ON DELETE CASCADE,
          PRIMARY KEY (project_id, file_path)
        );
        CREATE INDEX idx_test_file_labels_label ON test_file_labels(label_id);
      `)
    }
  },
  {
    version: 64,
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS test_file_labels;
        CREATE TABLE test_file_labels (
          project_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          label_id TEXT NOT NULL REFERENCES test_labels(id) ON DELETE CASCADE,
          PRIMARY KEY (project_id, file_path, label_id)
        );
        CREATE INDEX idx_test_file_labels_label ON test_file_labels(label_id);
      `)
    }
  },
  {
    version: 65,
    up: (db) => {
      db.exec(`
        CREATE TABLE test_file_notes (
          project_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (project_id, file_path)
        );
      `)
    }
  },
  {
    version: 66,
    up: (db) => {
      db.exec(`
        ALTER TABLE integration_project_mappings ADD COLUMN external_repo_owner TEXT DEFAULT NULL;
        ALTER TABLE integration_project_mappings ADD COLUMN external_repo_name TEXT DEFAULT NULL;
        ALTER TABLE integration_project_mappings ADD COLUMN last_discovery_at TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 67,
    up: (db) => {
      db.exec(`ALTER TABLE terminal_modes ADD COLUMN usage_config TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 68,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 69,
    up: (db) => {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as
        | { value: string }
        | undefined
      if (!row) return
      try {
        const config = JSON.parse(row.value) as {
          builtinEnabled?: Record<string, boolean>
          viewEnabled?: Record<string, Record<string, boolean>>
          [k: string]: unknown
        }
        if (config.viewEnabled) {
          if (config.builtinEnabled) {
            delete config.builtinEnabled
          } else return
        } else {
          const legacy = config.builtinEnabled ?? {}
          delete config.builtinEnabled
          const homeIds = new Set(['git', 'diff', 'editor', 'processes', 'tests'])
          config.viewEnabled = {
            home: Object.fromEntries(Object.entries(legacy).filter(([id]) => homeIds.has(id))),
            task: { ...legacy }
          }
        }
        db.prepare(`UPDATE settings SET value = ? WHERE key = 'panel_config'`).run(
          JSON.stringify(config)
        )
      } catch {
        /* malformed JSON, skip */
      }
    }
  },
  {
    version: 70,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN worktree_copy_behavior TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE projects ADD COLUMN worktree_copy_paths TEXT DEFAULT NULL`)
    }
  },
  {
    version: 71,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN graph_config TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE tasks ADD COLUMN graph_config TEXT DEFAULT NULL`)
    }
  },
  {
    version: 72,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          thread_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 73,
    up: (db) => {
      db.exec(`DROP TABLE IF EXISTS feedback`)
      db.exec(`
        CREATE TABLE feedback_threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          discord_thread_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE feedback_messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_feedback_messages_thread ON feedback_messages(thread_id);
      `)
    }
  },
  {
    version: 74,
    up: (db) => {
      db.exec(`DELETE FROM settings WHERE key = 'shell'`)
    }
  },
  {
    version: 75,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_records (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          session_id TEXT,
          timestamp TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL,
          cwd TEXT,
          task_id TEXT,
          source_file TEXT NOT NULL,
          source_offset INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
        CREATE INDEX IF NOT EXISTS idx_usage_records_task_id ON usage_records(task_id);
        CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);

        CREATE TABLE IF NOT EXISTS usage_parse_state (
          file_path TEXT PRIMARY KEY,
          last_offset INTEGER NOT NULL DEFAULT 0,
          last_modified_ms INTEGER NOT NULL DEFAULT 0
        );
      `)
    }
  },
  {
    version: 76,
    up: (db) => {
      // Fix: Codex parser was using cumulative totals instead of per-turn deltas.
      // Wipe cached data so it re-parses correctly.
      db.exec(`DELETE FROM usage_records; DELETE FROM usage_parse_state;`)
    }
  },
  {
    version: 77,
    up: (db) => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN selected_repo TEXT;
        ALTER TABLE tasks ADD COLUMN repo_name TEXT;
      `)
    }
  },
  {
    version: 78,
    up: (db) => {
      const rows = db
        .prepare(`
        SELECT id, slug, content, metadata_json
        FROM ai_config_items
        WHERE type = 'skill'
      `)
        .all() as Array<{
        id: string
        slug: string
        content: string
        metadata_json: string
      }>

      const update = db.prepare(`
        UPDATE ai_config_items
        SET content = ?, metadata_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `)

      for (const row of rows) {
        const normalizedContent = row.content.replace(/\r\n/g, '\n')
        const parsed = parseSkillFrontmatter(normalizedContent)
        const canonical = readCanonicalSkillMetadata(row.metadata_json)

        let nextContent = normalizedContent
        if (!parsed && canonical?.explicitFrontmatter) {
          const body = normalizedContent.replace(/^\n+/, '')
          const frontmatter = {
            ...canonical.frontmatter,
            name: canonical.frontmatter.name?.trim().length ? canonical.frontmatter.name : row.slug,
            description: canonical.frontmatter.description?.trim().length
              ? canonical.frontmatter.description
              : deriveSkillDescription(row.slug, body)
          }
          const renderedFrontmatter = renderSkillFrontmatter(frontmatter)
          nextContent = body ? `${renderedFrontmatter}\n${body}` : `${renderedFrontmatter}\n`
        }

        const nextMetadata = parseJsonObject(row.metadata_json)
        delete nextMetadata.skillCanonical
        nextMetadata.skillValidation = validateSkillFrontmatter(
          row.slug,
          parseSkillFrontmatter(nextContent)
        )
        const nextMetadataJson = JSON.stringify(nextMetadata)

        if (nextContent !== row.content || nextMetadataJson !== row.metadata_json) {
          update.run(nextContent, nextMetadataJson, row.id)
        }
      }
    }
  },
  {
    version: 79,
    up: (db) => {
      // Seed Qwen Code as a new CLI provider in the Context Manager
      db.prepare(
        `INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`
      ).run('provider-qwen', 'Qwen Code', 'qwen', 0, 'active')
    }
  },
  {
    version: 80,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
      const rows = db.prepare('SELECT id FROM projects ORDER BY name').all() as { id: string }[]
      const update = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
      for (let i = 0; i < rows.length; i++) {
        update.run(i, rows[i].id)
      }
    }
  },
  {
    version: 81,
    up: (db) => {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`
      )
      stmt.run('provider-copilot', 'Copilot', 'copilot', 0, 'active')
    }
  },
  {
    version: 82,
    up: (db) => {
      db.exec(
        `ALTER TABLE integration_project_mappings ADD COLUMN assigned_to_me INTEGER DEFAULT 0`
      )
    }
  },
  {
    version: 83,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN base_dir TEXT DEFAULT NULL`)
    }
  },
  {
    version: 84,
    up: (db) => {
      // Scope tags to projects + add sort_order
      const firstProject = db
        .prepare('SELECT id FROM projects ORDER BY sort_order LIMIT 1')
        .get() as { id: string } | undefined
      const fallbackProjectId = firstProject?.id ?? ''

      db.exec(`
        CREATE TABLE tags_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6b7280',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, name)
        )
      `)

      // Migrate existing tags with alphabetical sort_order
      const existingTags = db.prepare('SELECT * FROM tags ORDER BY name').all() as {
        id: string
        name: string
        color: string
        created_at: string
      }[]
      const insertTag = db.prepare(
        'INSERT INTO tags_new (id, project_id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (let i = 0; i < existingTags.length; i++) {
        const t = existingTags[i]
        insertTag.run(t.id, fallbackProjectId, t.name, t.color, i, t.created_at)
      }

      // Recreate task_tags with FK to new tags table
      db.exec(`
        CREATE TABLE task_tags_new (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags_new(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, tag_id)
        )
      `)
      db.exec(`INSERT INTO task_tags_new SELECT * FROM task_tags`)

      db.exec(`DROP TABLE task_tags`)
      db.exec(`DROP TABLE tags`)
      db.exec(`ALTER TABLE tags_new RENAME TO tags`)
      db.exec(`ALTER TABLE task_tags_new RENAME TO task_tags`)
      db.exec(`CREATE INDEX idx_task_tags_task ON task_tags(task_id)`)
      db.exec(`CREATE INDEX idx_task_tags_tag ON task_tags(tag_id)`)
    }
  },
  {
    version: 85,
    up: (db) => {
      db.exec(`ALTER TABLE tags ADD COLUMN text_color TEXT NOT NULL DEFAULT '#ffffff'`)
      // Compute text_color for existing tags based on luminance
      const tags = db.prepare('SELECT id, color FROM tags').all() as { id: string; color: string }[]
      const update = db.prepare('UPDATE tags SET text_color = ? WHERE id = ?')
      for (const tag of tags) {
        const r = parseInt(tag.color.slice(1, 3), 16)
        const g = parseInt(tag.color.slice(3, 5), 16)
        const b = parseInt(tag.color.slice(5, 7), 16)
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        update.run(luminance > 0.55 ? '#000000' : '#ffffff', tag.id)
      }
    }
  },
  {
    version: 86,
    up: (db) => {
      db.exec(`
        CREATE TABLE task_templates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          terminal_mode TEXT,
          provider_config TEXT,
          panel_visibility TEXT,
          browser_tabs TEXT,
          web_panel_urls TEXT,
          dangerously_skip_permissions INTEGER,
          ccs_profile TEXT,
          default_status TEXT,
          default_priority INTEGER,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX idx_task_templates_default
          ON task_templates(project_id) WHERE is_default = 1;
      `)
    }
  },
  {
    version: 87,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          trigger_config TEXT NOT NULL,
          conditions TEXT,
          actions TEXT NOT NULL,
          run_count INTEGER NOT NULL DEFAULT 0,
          last_run_at TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_automations_project ON automations(project_id);

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          trigger_event TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          error TEXT,
          duration_ms INTEGER,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id);
      `)
    }
  },
  {
    version: 88,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN loop_config TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 89,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN snoozed_until TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 90,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN description_format TEXT NOT NULL DEFAULT 'html';`)
    }
  },
  {
    version: 91,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN external_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN external_provider TEXT DEFAULT NULL;
        CREATE UNIQUE INDEX idx_tasks_external_dedup
          ON tasks(project_id, external_provider, external_id)
          WHERE external_id IS NOT NULL;
      `)
    }
  },
  {
    version: 92,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_events (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_activity_events_task_created
          ON activity_events(task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_events_entity
          ON activity_events(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_activity_events_project_created
          ON activity_events(project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS automation_action_runs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          action_index INTEGER NOT NULL,
          action_type TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          output_tail TEXT,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_automation_action_runs_run
          ON automation_action_runs(run_id, action_index);
      `)
    }
  },
  {
    version: 93,
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_events_task_created_id
          ON activity_events(task_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_events_project_created_id
          ON activity_events(project_id, created_at DESC, id DESC);
      `)
    }
  },
  {
    version: 94,
    up: (db) => {
      db.exec(`
        CREATE TABLE skill_registries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL,
          github_owner TEXT,
          github_repo TEXT,
          github_branch TEXT DEFAULT 'main',
          github_path TEXT DEFAULT 'skills',
          icon_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_synced_at TEXT,
          etag TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(github_owner, github_repo)
        );

        CREATE TABLE skill_registry_entries (
          id TEXT PRIMARY KEY,
          registry_id TEXT NOT NULL REFERENCES skill_registries(id) ON DELETE CASCADE,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          version TEXT,
          category TEXT,
          author TEXT,
          tags TEXT DEFAULT '[]',
          content_hash TEXT NOT NULL,
          fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(registry_id, slug)
        );
        CREATE INDEX idx_skill_registry_entries_registry
          ON skill_registry_entries(registry_id);

        INSERT INTO skill_registries (id, name, description, source_type)
          VALUES ('builtin-slayzone', 'SlayZone', 'Built-in skills curated by SlayZone', 'builtin');

        INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-anthropics-skills', 'Anthropic Skills', 'Official skills from Anthropic', 'github', 'anthropics', 'skills', 'main', 'skills');
        INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-composio-skills', 'Awesome Claude Skills', 'Curated skills and integrations by ComposioHQ', 'github', 'ComposioHQ', 'awesome-claude-skills', 'master', '');
        INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-mattpocock-skills', 'Matt Pocock Skills', 'Personal skills by Matt Pocock', 'github', 'mattpocock', 'skills', 'main', '');
        INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-huggingface-skills', 'Hugging Face Skills', 'AI/ML skills from Hugging Face', 'github', 'huggingface', 'skills', 'main', 'skills');
        INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-alirezarezvani-skills', 'Claude Skills Collection', '500+ skills for coding agents', 'github', 'alirezarezvani', 'claude-skills', 'main', '.gemini/skills');
      `)
    }
  },
  {
    version: 95,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_assets (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'markdown',
          language TEXT,
          "order" INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_task_assets_task ON task_assets(task_id);
      `)
    }
  },
  {
    version: 96,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN task_automation_config TEXT DEFAULT NULL`)
    }
  },
  {
    version: 97,
    up: (db) => {
      // Add render_mode column (NULL = infer from file extension in title)
      db.exec(`ALTER TABLE task_assets ADD COLUMN render_mode TEXT DEFAULT NULL`)

      // Backfill: append extension to title if missing, set render_mode override if needed
      const typeToExt: Record<string, string> = {
        markdown: '.md',
        code: '.txt',
        html: '.html',
        svg: '.svg',
        mermaid: '.mmd'
      }
      const typeToRenderMode: Record<string, string> = {
        markdown: 'markdown',
        code: 'code',
        html: 'html-preview',
        svg: 'svg-preview',
        mermaid: 'mermaid-preview'
      }
      // Extension → inferred render mode (mirrors EXTENSION_RENDER_MODES in types.ts)
      const extToRenderMode: Record<string, string> = {
        '.md': 'markdown',
        '.mdx': 'markdown',
        '.html': 'html-preview',
        '.htm': 'html-preview',
        '.svg': 'svg-preview',
        '.mmd': 'mermaid-preview',
        '.mermaid': 'mermaid-preview',
        '.txt': 'code'
      }

      const assets = db.prepare('SELECT id, title, type FROM task_assets').all() as {
        id: string
        title: string
        type: string
      }[]
      const updateStmt = db.prepare(
        'UPDATE task_assets SET title = ?, render_mode = ? WHERE id = ?'
      )

      for (const asset of assets) {
        const ext = typeToExt[asset.type] ?? '.txt'
        let newTitle = asset.title
        const dotIdx = asset.title.lastIndexOf('.')
        const currentExt = dotIdx > 0 ? asset.title.slice(dotIdx).toLowerCase() : ''
        if (!currentExt) newTitle = `${asset.title}${ext}`

        const finalExt = newTitle.slice(newTitle.lastIndexOf('.')).toLowerCase()
        const inferred = extToRenderMode[finalExt] ?? 'code'
        const oldMode = typeToRenderMode[asset.type] ?? 'code'
        const renderMode = inferred === oldMode ? null : oldMode

        updateStmt.run(newTitle, renderMode, asset.id)
      }
    }
  },
  {
    version: 98,
    up: (db) => {
      db.exec(`
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-anthropics-skills', 'Anthropic Skills', 'Official skills from Anthropic', 'github', 'anthropics', 'skills', 'main', 'skills');
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-composio-skills', 'Awesome Claude Skills', 'Curated skills and integrations by ComposioHQ', 'github', 'ComposioHQ', 'awesome-claude-skills', 'master', '');
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-mattpocock-skills', 'Matt Pocock Skills', 'Personal skills by Matt Pocock', 'github', 'mattpocock', 'skills', 'main', '');
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-huggingface-skills', 'Hugging Face Skills', 'AI/ML skills from Hugging Face', 'github', 'huggingface', 'skills', 'main', 'skills');
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-alirezarezvani-skills', 'Claude Skills Collection', '500+ skills for coding agents', 'github', 'alirezarezvani', 'claude-skills', 'main', '.gemini/skills');
      `)
    }
  },
  {
    version: 99,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_folders (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES asset_folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          "order" INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_asset_folders_task ON asset_folders(task_id);
        CREATE INDEX IF NOT EXISTS idx_asset_folders_parent ON asset_folders(parent_id);

        ALTER TABLE task_assets ADD COLUMN folder_id TEXT DEFAULT NULL REFERENCES asset_folders(id) ON DELETE SET NULL;
      `)
    }
  },
  {
    version: 100,
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN blocked_comment TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 101,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN active_asset_id TEXT DEFAULT NULL`)
    }
  },
  {
    version: 102,
    up: (db) => {
      db.exec(`
        INSERT OR IGNORE INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
          VALUES ('github-caveman-skills', 'Caveman', 'Token-optimized output skills by Julius Brussee', 'github', 'JuliusBrussee', 'caveman', 'main', 'skills');
      `)
    }
  },
  {
    version: 103,
    up: (db) => {
      db.exec(`
        DELETE FROM skill_registries WHERE id IN (
          'github-anthropics-skills',
          'github-huggingface-skills',
          'github-alirezarezvani-skills'
        );
      `)
    }
  },
  {
    version: 104,
    up: (db) => {
      db.exec(`ALTER TABLE task_assets ADD COLUMN view_mode TEXT DEFAULT NULL`)
    }
  },
  {
    version: 105,
    up: (db) => {
      // Rename legacy scope value 'global' → 'library'. "global" historically meant the
      // shared library store; disambiguate against "computer" (user-level ~/.provider/ files).
      db.exec(`
        DROP INDEX IF EXISTS ux_ai_config_items_global_type_slug;
        UPDATE ai_config_items SET scope = 'library' WHERE scope = 'global';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_config_items_library_type_slug
          ON ai_config_items(type, slug)
          WHERE scope = 'library';
      `)
    }
  },
  {
    version: 106,
    up: (db) => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN icon_letters TEXT;
        ALTER TABLE projects ADD COLUMN icon_image_path TEXT;
      `)
    }
  },
  {
    version: 107,
    up: (db) => {
      // Disable floating agent panel by default — alwaysOnTop + visibleOnAllWorkspaces
      // broke macOS tiling window managers (Magnet, Rectangle). Reset existing users
      // who had the old default (true) so they don't stay broken.
      const row = db.prepare("SELECT value FROM settings WHERE key = 'agentPanelState'").get() as
        | { value: string }
        | undefined
      if (!row) return
      try {
        const state = JSON.parse(row.value)
        if (state.floatingEnabled === true) {
          state.floatingEnabled = false
          db.prepare("UPDATE settings SET value = ? WHERE key = 'agentPanelState'").run(
            JSON.stringify(state)
          )
        }
      } catch {
        /* malformed JSON, skip */
      }
    }
  },
  {
    version: 108,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN lock_config TEXT;`)
    }
  },
  {
    version: 109,
    up: (db) => {
      db.exec(`
        ALTER TABLE task_assets ADD COLUMN readability_override TEXT DEFAULT NULL;
        ALTER TABLE task_assets ADD COLUMN width_override TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 110,
    up: (db) => {
      db.exec(`
        ALTER TABLE terminal_tabs ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'xterm';
      `)
    }
  },
  {
    version: 111,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_versions (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL REFERENCES task_assets(id) ON DELETE CASCADE,
          version_num INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          name TEXT,
          author_type TEXT,
          author_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_versions_num ON asset_versions(asset_id, version_num);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_versions_name ON asset_versions(asset_id, name) WHERE name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_asset_versions_hash ON asset_versions(content_hash);

        CREATE TABLE IF NOT EXISTS asset_blobs (
          hash TEXT PRIMARY KEY,
          size INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 112,
    up: (db) => {
      db.exec(`
        ALTER TABLE asset_versions ADD COLUMN parent_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL;
        ALTER TABLE task_assets ADD COLUMN current_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL;
      `)
      // Backfill parent_id: link each version to its predecessor by version_num
      db.exec(`
        UPDATE asset_versions AS v
        SET parent_id = (
          SELECT p.id FROM asset_versions AS p
          WHERE p.asset_id = v.asset_id AND p.version_num = v.version_num - 1
        )
        WHERE v.parent_id IS NULL;
      `)
      // Backfill current_version_id: latest version per asset
      db.exec(`
        UPDATE task_assets AS a
        SET current_version_id = (
          SELECT v.id FROM asset_versions AS v
          WHERE v.asset_id = a.id
          ORDER BY v.version_num DESC
          LIMIT 1
        )
        WHERE current_version_id IS NULL;
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_asset_versions_parent ON asset_versions(parent_id);
      `)
    }
  },
  {
    version: 113,
    up: (db) => {
      // Persist chat-agent event buffer per terminal_tabs row so chat history
      // survives Electron app reload (in-memory Map in chat-transport-manager
      // gets wiped on shutdownChatTransports() at app quit).
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_events (
          tab_id TEXT NOT NULL REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          event TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (tab_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_events_tab_seq ON chat_events(tab_id, seq);
      `)
    }
  },
  {
    version: 114,
    up: (db) => {
      db.exec(`ALTER TABLE projects ADD COLUMN worktree_submodule_init TEXT DEFAULT NULL`)
    }
  },
  {
    version: 115,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 116,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN manager_mode INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 117,
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_turns (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          terminal_tab_id TEXT NOT NULL,
          start_sha TEXT NOT NULL,
          end_sha TEXT,
          prompt_preview TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_agent_turns_task ON agent_turns(task_id, started_at DESC);
      `)
    }
  },
  {
    version: 118,
    up: (db) => {
      // Replace pair-snapshot model (start/end) with single snapshot per turn.
      // v117 just shipped — table is empty in practice — safe to drop+recreate.
      db.exec(`
        DROP TABLE IF EXISTS agent_turns;
        CREATE TABLE agent_turns (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          terminal_tab_id TEXT NOT NULL,
          snapshot_sha TEXT NOT NULL,
          prompt_preview TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_agent_turns_task ON agent_turns(task_id, created_at ASC);
      `)
    }
  },
  {
    version: 119,
    up: (db) => {
      // Switch grouping from task → worktree path. task_id retained (nullable)
      // for attribution: who/which task asked. ON DELETE SET NULL so deleting a
      // task doesn't lose the turn history that lives with the repo.
      db.exec(`
        DROP TABLE IF EXISTS agent_turns;
        CREATE TABLE agent_turns (
          id TEXT PRIMARY KEY,
          worktree_path TEXT NOT NULL,
          task_id TEXT,
          terminal_tab_id TEXT NOT NULL,
          snapshot_sha TEXT NOT NULL,
          prompt_preview TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );
        CREATE INDEX idx_agent_turns_worktree ON agent_turns(worktree_path, created_at ASC);
      `)
    }
  },
  {
    version: 120,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN diff_collapsed_files TEXT DEFAULT NULL`)
    }
  },
  {
    version: 121,
    up: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN git_active_tab TEXT DEFAULT NULL`)
    }
  },
  {
    version: 122,
    up: (db) => {
      // Add HEAD-at-snap-time column to agent_turns. Stored explicitly so
      // list-time filter can drop pre-commit ghosts via SQL — replaces the
      // prior `git rev-parse <sha>^` per-row probe (which had a null-cache
      // poisoning surface). Backfill via git for existing rows; rows whose
      // repo can't be reached stay NULL → filter treats as stale (drops).
      db.exec(`ALTER TABLE agent_turns ADD COLUMN head_sha_at_snap TEXT`)
      // A hub with processes switched off runs no git (T-06): rows stay NULL, which
      // the list-time filter already treats as stale.
      if (!hubProcessesEnabled()) return
      const rows = db
        .prepare(`SELECT id, worktree_path, snapshot_sha FROM agent_turns`)
        .all() as Array<{ id: string; worktree_path: string; snapshot_sha: string }>
      const update = db.prepare(`UPDATE agent_turns SET head_sha_at_snap = ? WHERE id = ?`)
      for (const row of rows) {
        const r = spawnSync(gitCommand(), ['rev-parse', `${row.snapshot_sha}^`], {
          cwd: row.worktree_path,
          encoding: 'utf-8'
        })
        if (r.status === 0) {
          const sha = r.stdout.trim()
          if (sha) update.run(sha, row.id)
        }
      }
    }
  },
  {
    version: 123,
    up: (db) => {
      // Enforce per-project uniqueness on (color, text_color) for tags.
      // Snapshot of TAG_PRESETS at v123 — kept inline so future preset
      // edits do not re-shape this migration's behavior on replay.
      const PRESETS: Array<{ bg: string; text: string }> = [
        { bg: '#fecaca', text: '#991b1b' },
        { bg: '#ef4444', text: '#ffffff' },
        { bg: '#991b1b', text: '#fecaca' },
        { bg: '#fed7aa', text: '#9a3412' },
        { bg: '#f97316', text: '#ffffff' },
        { bg: '#9a3412', text: '#fed7aa' },
        { bg: '#fef08a', text: '#854d0e' },
        { bg: '#eab308', text: '#422006' },
        { bg: '#854d0e', text: '#fef9c3' },
        { bg: '#bbf7d0', text: '#166534' },
        { bg: '#22c55e', text: '#ffffff' },
        { bg: '#166534', text: '#bbf7d0' },
        { bg: '#99f6e4', text: '#115e59' },
        { bg: '#14b8a6', text: '#ffffff' },
        { bg: '#115e59', text: '#ccfbf1' },
        { bg: '#bfdbfe', text: '#1e3a8a' },
        { bg: '#3b82f6', text: '#ffffff' },
        { bg: '#1e3a8a', text: '#bfdbfe' },
        { bg: '#c7d2fe', text: '#3730a3' },
        { bg: '#6366f1', text: '#ffffff' },
        { bg: '#3730a3', text: '#c7d2fe' },
        { bg: '#ddd6fe', text: '#5b21b6' },
        { bg: '#a855f7', text: '#ffffff' },
        { bg: '#5b21b6', text: '#ede9fe' },
        { bg: '#fbcfe8', text: '#9d174d' },
        { bg: '#ec4899', text: '#ffffff' },
        { bg: '#9d174d', text: '#fce7f3' },
        { bg: '#e5e7eb', text: '#1f2937' },
        { bg: '#6b7280', text: '#ffffff' },
        { bg: '#374151', text: '#e5e7eb' }
      ]
      const presetKey = (bg: string, text: string) => `${bg}:${text}`
      const presetSet = new Set(PRESETS.map((p) => presetKey(p.bg, p.text)))
      const parseHex = (hex: string): [number, number, number] | null => {
        const m = /^#([0-9a-f]{6})$/i.exec(hex)
        if (!m) return null
        const v = m[1]
        return [
          parseInt(v.slice(0, 2), 16),
          parseInt(v.slice(2, 4), 16),
          parseInt(v.slice(4, 6), 16)
        ]
      }
      const nearestPreset = (bg: string): { bg: string; text: string } => {
        const rgb = parseHex(bg)
        if (!rgb) return PRESETS[19] // indigo fallback (#6366f1/#ffffff)
        let best = PRESETS[0]
        let bestDist = Number.POSITIVE_INFINITY
        for (const p of PRESETS) {
          const prgb = parseHex(p.bg)
          if (!prgb) continue
          const dr = rgb[0] - prgb[0]
          const dg = rgb[1] - prgb[1]
          const db = rgb[2] - prgb[2]
          const dist = dr * dr + dg * dg + db * db
          if (dist < bestDist) {
            bestDist = dist
            best = p
          }
        }
        return best
      }

      const updateColor = db.prepare('UPDATE tags SET color = ?, text_color = ? WHERE id = ?')

      // Step 1 — force all custom (non-preset) colors to nearest preset.
      const allTags = db
        .prepare(
          'SELECT id, project_id, color, text_color FROM tags ORDER BY created_at ASC, id ASC'
        )
        .all() as Array<{ id: string; project_id: string; color: string; text_color: string }>
      for (const tag of allTags) {
        if (!presetSet.has(presetKey(tag.color, tag.text_color))) {
          const np = nearestPreset(tag.color)
          updateColor.run(np.bg, np.text, tag.id)
          tag.color = np.bg
          tag.text_color = np.text
        }
      }

      // Step 2 — per-project dedup. Keep oldest in each color group; reassign
      // others to next free preset in project. If no free preset (project has
      // ≥31 colliding tags), warn and leave duplicate — index creation in
      // step 3 will be skipped to keep boot safe.
      const tagsByProject = new Map<string, typeof allTags>()
      for (const tag of allTags) {
        const arr = tagsByProject.get(tag.project_id) ?? []
        arr.push(tag)
        tagsByProject.set(tag.project_id, arr)
      }
      for (const [projectId, tags] of tagsByProject) {
        const used = new Set<string>()
        const groups = new Map<string, typeof tags>()
        for (const t of tags) {
          const k = presetKey(t.color, t.text_color)
          const g = groups.get(k) ?? []
          g.push(t)
          groups.set(k, g)
        }
        for (const k of groups.keys()) {
          // group already sorted (allTags is) — first stays, rest reassign
          used.add(k)
        }
        for (const [, group] of groups) {
          if (group.length <= 1) continue
          for (let i = 1; i < group.length; i++) {
            const tag = group[i]
            const free = PRESETS.find((p) => !used.has(presetKey(p.bg, p.text)))
            if (!free) {
              console.warn(
                `[migration v123] tag color dedup overflow: project=${projectId} tag=${tag.id} color=${tag.color}/${tag.text_color} — leaving duplicate`
              )
              continue
            }
            updateColor.run(free.bg, free.text, tag.id)
            tag.color = free.bg
            tag.text_color = free.text
            used.add(presetKey(free.bg, free.text))
          }
        }
      }

      // Step 3 — boot-safe unique index. Skip if collisions remain (overflow).
      const remaining = db
        .prepare(
          `SELECT 1 FROM tags GROUP BY project_id, color, text_color HAVING COUNT(*) > 1 LIMIT 1`
        )
        .get() as unknown
      if (!remaining) {
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS tags_project_color_unique ON tags(project_id, color, text_color)`
        )
      } else {
        console.warn(
          `[migration v123] collisions remain after dedup — skipping unique index creation`
        )
      }
    }
  },
  {
    version: 124,
    up: (db) => {
      db.exec(`ALTER TABLE automations ADD COLUMN catchup_on_start INTEGER NOT NULL DEFAULT 1;`)
    }
  },
  {
    version: 125,
    up: (db) => {
      // Headless command template per terminal mode — recipe for non-interactive
      // CLI invocation w/ {prompt} + {flags} slots. Powers automations' AI action.
      // Null = mode does not support headless mode (e.g. plain 'terminal').
      // Builtins seeded by startup-sync; users can edit per-row for custom modes.
      const cols = db.prepare('PRAGMA table_info(terminal_modes)').all() as { name: string }[]
      if (!cols.some((c) => c.name === 'headless_command')) {
        db.exec(`ALTER TABLE terminal_modes ADD COLUMN headless_command TEXT;`)
      }
    }
  },
  {
    version: 126,
    up: (db) => {
      // Per-(source,name) usage counter for chat autocomplete ranking. Bumped
      // on successful chat send for each /token that resolves to a known item.
      // Used as fzf-tiebreak so most-used entries float above alphabetical.
      db.exec(`
        CREATE TABLE IF NOT EXISTS autocomplete_usage (
          source TEXT NOT NULL,
          name   TEXT NOT NULL,
          count  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source, name)
        )
      `)
    }
  },
  {
    version: 127,
    up: (db) => {
      // Rename "assets" feature to "artifacts" — terminology change only.
      // Tables, columns, and indexes renamed. SQLite >= 3.25 auto-rewrites
      // foreign-key references in dependent tables on RENAME TO.
      db.exec(`
        ALTER TABLE task_assets RENAME TO task_artifacts;
        ALTER TABLE asset_folders RENAME TO artifact_folders;
        ALTER TABLE asset_versions RENAME TO artifact_versions;
        ALTER TABLE asset_blobs RENAME TO artifact_blobs;

        ALTER TABLE artifact_versions RENAME COLUMN asset_id TO artifact_id;
        ALTER TABLE tasks RENAME COLUMN active_asset_id TO active_artifact_id;

        DROP INDEX IF EXISTS idx_task_assets_task;
        DROP INDEX IF EXISTS idx_asset_folders_task;
        DROP INDEX IF EXISTS idx_asset_folders_parent;
        DROP INDEX IF EXISTS idx_asset_versions_num;
        DROP INDEX IF EXISTS idx_asset_versions_name;
        DROP INDEX IF EXISTS idx_asset_versions_hash;
        DROP INDEX IF EXISTS idx_asset_versions_parent;

        CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id);
        CREATE INDEX IF NOT EXISTS idx_artifact_folders_task ON artifact_folders(task_id);
        CREATE INDEX IF NOT EXISTS idx_artifact_folders_parent ON artifact_folders(parent_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_num ON artifact_versions(artifact_id, version_num);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_name ON artifact_versions(artifact_id, name) WHERE name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_hash ON artifact_versions(content_hash);
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_parent ON artifact_versions(parent_id);
      `)

      // Settings keys (idempotent, no-op if no matches).
      db.exec(`
        UPDATE settings SET key = REPLACE(key, 'Asset', 'Artifact') WHERE key LIKE '%Asset%';
        UPDATE settings SET key = REPLACE(key, 'asset', 'artifact') WHERE key LIKE '%asset%';
      `)
    }
  },
  {
    version: 128,
    up: (db) => {
      // Backend-persisted chat "Up next" queue. Source-of-truth moved out of
      // React state so queued messages survive reload/crash and stay in sync
      // across windows. FK ON DELETE CASCADE clears queue when tab deleted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_queue (
          id          TEXT PRIMARY KEY,
          tab_id      TEXT NOT NULL REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          send        TEXT NOT NULL,
          original    TEXT NOT NULL,
          position    INTEGER NOT NULL,
          created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_queue_tab ON chat_queue(tab_id, position);
      `)
    }
  },
  {
    version: 129,
    up: (db) => {
      // v127 renamed assets → artifacts in tables/columns/setting keys, but missed
      // JSON blobs: settings.panel_config (order[] + viewEnabled.*.assets) and
      // tasks.panel_visibility ({assets: bool}). Without this, a saved order with
      // 'assets' is filtered out as unknown and 'artifacts' appended at the end
      // → Artifacts panel lands on the far right after upgrade.

      // 1. settings.panel_config
      const cfgRow = db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as
        | { value: string }
        | undefined
      if (cfgRow) {
        try {
          const cfg = JSON.parse(cfgRow.value) as {
            order?: string[]
            viewEnabled?: Record<string, Record<string, boolean>>
            [k: string]: unknown
          }
          let changed = false
          if (Array.isArray(cfg.order)) {
            const next = cfg.order.map((id) => (id === 'assets' ? 'artifacts' : id))
            if (next.some((id, i) => id !== cfg.order![i])) {
              cfg.order = next
              changed = true
            }
          }
          if (cfg.viewEnabled) {
            for (const view of Object.keys(cfg.viewEnabled)) {
              const v = cfg.viewEnabled[view]
              if (v && Object.prototype.hasOwnProperty.call(v, 'assets')) {
                if (!Object.prototype.hasOwnProperty.call(v, 'artifacts')) {
                  v.artifacts = v.assets
                }
                delete v.assets
                changed = true
              }
            }
          }
          if (changed) {
            db.prepare(`UPDATE settings SET value = ? WHERE key = 'panel_config'`).run(
              JSON.stringify(cfg)
            )
          }
        } catch {
          /* malformed JSON, skip */
        }
      }

      // 2. tasks.panel_visibility per-row
      const rows = db
        .prepare(`SELECT id, panel_visibility FROM tasks WHERE panel_visibility LIKE '%assets%'`)
        .all() as { id: string; panel_visibility: string | null }[]
      const upd = db.prepare(`UPDATE tasks SET panel_visibility = ? WHERE id = ?`)
      for (const row of rows) {
        if (!row.panel_visibility) continue
        try {
          const pv = JSON.parse(row.panel_visibility) as Record<string, boolean>
          if (Object.prototype.hasOwnProperty.call(pv, 'assets')) {
            if (!Object.prototype.hasOwnProperty.call(pv, 'artifacts')) {
              pv.artifacts = pv.assets
            }
            delete pv.assets
            upd.run(JSON.stringify(pv), row.id)
          }
        } catch {
          /* skip malformed */
        }
      }
    }
  },
  {
    version: 130,
    up: (db) => {
      // Per-task "needs attention" flag. Set when a PTY for the task transitions
      // running → idle | error and user has not yet focused the task. Cleared on
      // tab focus. Orthogonal to TerminalState (which is in-memory + per-PTY).
      db.exec(`ALTER TABLE tasks ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 131,
    up: (db) => {
      // Per-task dismissal of the dev-server URL detected toast. Once dismissed,
      // the toast never reappears for that task.
      db.exec(`ALTER TABLE tasks ADD COLUMN dev_url_toast_dismissed INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 132,
    up: (db) => {
      // Rename agent panel settings key: agentPanelState → globalAgentPanelState.
      db.prepare(`
        UPDATE settings SET key = 'globalAgentPanelState'
        WHERE key = 'agentPanelState'
          AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'globalAgentPanelState')
      `).run()
      db.prepare("DELETE FROM settings WHERE key = 'agentPanelState'").run()
    }
  },
  {
    version: 133,
    up: (db) => {
      // Rename floating global agent panel settings keys to match the panel rename:
      //   floatingAgentExpandedSize → floatingGlobalAgentPanelExpandedSize
      //   floatingAgentConfig       → floatingGlobalAgentPanelConfig
      const renames: Array<[string, string]> = [
        ['floatingAgentExpandedSize', 'floatingGlobalAgentPanelExpandedSize'],
        ['floatingAgentConfig', 'floatingGlobalAgentPanelConfig']
      ]
      for (const [from, to] of renames) {
        db.prepare(`
          UPDATE settings SET key = ?
          WHERE key = ?
            AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)
        `).run(to, from, to)
        db.prepare('DELETE FROM settings WHERE key = ?').run(from)
      }
    }
  },
  {
    version: 134,
    up: (db) => {
      const replacements = new Map<string, string>([
        ['--full-auto', '--sandbox workspace-write'],
        ['--full-auto --search', '--sandbox workspace-write'],
        ['--full-auto --disable apps', '--sandbox workspace-write --disable apps'],
        ['--full-auto --search --disable apps', '--sandbox workspace-write --disable apps']
      ])

      const migrateFlags = (flags: unknown): string | null => {
        if (typeof flags !== 'string') return null
        return replacements.get(flags.trim()) ?? null
      }

      const updateSetting = db.prepare(`
        UPDATE settings
        SET value = ?
        WHERE key = 'default_codex_flags' AND value = ?
      `)
      const updateMode = db.prepare(`
        UPDATE terminal_modes
        SET default_flags = ?, updated_at = datetime('now')
        WHERE id = 'codex' AND default_flags = ?
      `)
      const updateTaskFlags = db.prepare(`
        UPDATE tasks
        SET codex_flags = ?, updated_at = datetime('now')
        WHERE codex_flags = ?
      `)

      for (const [from, to] of replacements) {
        updateSetting.run(to, from)
        updateMode.run(to, from)
        updateTaskFlags.run(to, from)
      }

      const rows = db
        .prepare(`
        SELECT id, provider_config
        FROM tasks
        WHERE provider_config LIKE '%--full-auto%'
      `)
        .all() as Array<{ id: string; provider_config: string | null }>
      const updateProviderConfig = db.prepare(`
        UPDATE tasks
        SET provider_config = ?, updated_at = datetime('now')
        WHERE id = ?
      `)

      for (const row of rows) {
        if (!row.provider_config) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(row.provider_config)
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue

        const config = parsed as Record<string, { flags?: unknown } | undefined>
        const codex = config.codex
        if (!codex || typeof codex !== 'object') continue

        const migrated = migrateFlags(codex.flags)
        if (!migrated) continue

        codex.flags = migrated
        updateProviderConfig.run(JSON.stringify(config), row.id)
      }
    }
  },
  {
    version: 135,
    up: (db) => {
      db.exec(`ALTER TABLE tasks DROP COLUMN manager_mode`)
    }
  },
  {
    version: 136,
    up: (db) => {
      // Per-tab "subprocess was alive at last touch" flag. Set on spawn,
      // cleared on user-initiated kill / tab-close / natural subprocess exit.
      // NOT cleared on app shutdown — that's the whole point: next boot reads
      // this column to auto-restart agents that were warm when the app died.
      db.exec(`ALTER TABLE terminal_tabs ADD COLUMN was_spawned INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 137,
    up: (db) => {
      // Chat became its own provider (`claude-chat`) — `display_mode` is gone.
      // Flip tabs that were in chat view to the new mode before dropping the column.
      db.exec(`
        UPDATE terminal_tabs SET mode = 'claude-chat'
          WHERE mode = 'claude-code' AND display_mode = 'chat';
        ALTER TABLE terminal_tabs DROP COLUMN display_mode;
        DELETE FROM settings WHERE key = 'default_tab_display_mode';
      `)
    }
  },
  {
    version: 138,
    up: (db) => {
      // Seed claude-chat's defaultFlags only if the row landed with NULL from
      // the v137-era introduction. Interactive chat ignores this field; it
      // matters only for automation headless runs (buildAiHeadlessCommand).
      db.exec(`
        UPDATE terminal_modes
          SET default_flags = '--allow-dangerously-skip-permissions'
          WHERE id = 'claude-chat' AND default_flags IS NULL;
      `)
    }
  },
  {
    version: 139,
    up: (db) => {
      // Denormalized "last user-or-agent interaction" epoch-ms. Bumped from
      // chat user-message events + agent_turns inserts. Sorted by tree-view's
      // "last interaction" orderBy. Backfill takes MAX across both sources so
      // chat-only tasks (no git snapshots) and snapshot-only tasks both light
      // up at migration time. Filter chat_events to 'user-message' kind so
      // backfill matches the runtime bump path. Sentinel `0` collapses to NULL.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN last_interaction_at INTEGER;
        UPDATE tasks SET last_interaction_at = (
          SELECT MAX(IFNULL(at_max, 0), IFNULL(ce_max, 0))
          FROM (
            SELECT
              (SELECT MAX(at.created_at) FROM agent_turns at WHERE at.task_id = tasks.id) AS at_max,
              (SELECT CAST(strftime('%s', MAX(ce.created_at)) AS INTEGER) * 1000
                 FROM chat_events ce
                 JOIN terminal_tabs tt ON tt.id = ce.tab_id
                WHERE tt.task_id = tasks.id
                  AND json_extract(ce.event, '$.kind') = 'user-message') AS ce_max
          )
        );
        UPDATE tasks SET last_interaction_at = NULL WHERE last_interaction_at = 0;
        CREATE INDEX IF NOT EXISTS idx_tasks_last_interaction ON tasks(last_interaction_at DESC);
      `)
    }
  },
  {
    version: 140,
    up: (db) => {
      // Move genuinely task-intrinsic UI state out of global settings blobs and
      // into `tasks` columns, so it travels with the task row and survives the
      // app's wholesale `viewState` rewrites:
      //   - viewState.treePinnedTaskIds   → tasks.pinned + tasks.pin_order
      //   - viewState.treeCollapsedTaskIds → tasks.tree_collapsed
      //   - settings 'commit_graph:task:<id>' → tasks.commit_graph_config
      // Window state that merely references a task id (tabs, closedTabs,
      // projectLastActiveTab) and project-scoped keys stay in their blobs.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN tree_collapsed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN commit_graph_config TEXT DEFAULT NULL;
      `)

      // Backfill pin/collapse state from the `viewState` blob.
      const viewStateRow = db.prepare("SELECT value FROM settings WHERE key = 'viewState'").get() as
        | { value: string }
        | undefined
      let viewState: Record<string, unknown> | null = null
      if (viewStateRow?.value) {
        try {
          const parsed = JSON.parse(viewStateRow.value)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            viewState = parsed as Record<string, unknown>
          }
        } catch {
          viewState = null
        }
      }

      if (viewState) {
        const pinned = viewState.treePinnedTaskIds
        if (Array.isArray(pinned)) {
          const setPinned = db.prepare('UPDATE tasks SET pinned = 1, pin_order = ? WHERE id = ?')
          pinned.forEach((id, index) => {
            if (typeof id === 'string') setPinned.run(index, id)
          })
        }

        const collapsed = viewState.treeCollapsedTaskIds
        if (Array.isArray(collapsed)) {
          const setCollapsed = db.prepare('UPDATE tasks SET tree_collapsed = 1 WHERE id = ?')
          for (const id of collapsed) {
            if (typeof id === 'string') setCollapsed.run(id)
          }
        }

        // Strip the moved fields from the blob.
        delete viewState.treePinnedTaskIds
        delete viewState.treeCollapsedTaskIds
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
          JSON.stringify(viewState),
          'viewState'
        )
      }

      // Backfill per-task commit-graph config from settings 'commit_graph:task:<id>'.
      const prefix = 'commit_graph:task:'
      const graphRows = db
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'commit_graph:task:%'")
        .all() as Array<{ key: string; value: string | null }>
      const setGraphConfig = db.prepare('UPDATE tasks SET commit_graph_config = ? WHERE id = ?')
      for (const row of graphRows) {
        const taskId = row.key.slice(prefix.length)
        if (taskId && row.value) setGraphConfig.run(row.value, taskId)
      }
      db.prepare("DELETE FROM settings WHERE key LIKE 'commit_graph:task:%'").run()
    }
  },
  {
    version: 141,
    up: (db) => {
      // Idle-close (hibernation): per-tab flag marking that the agent was
      // auto-closed while idle. Distinct from `was_spawned` (which hibernation
      // clears to 0): persists the "sleeping 💤 / Reopen" status across reload
      // and restart so a stale agent stays visibly distinguishable from a
      // never-started one. Set on hibernate, cleared on (re)spawn.
      db.exec(`ALTER TABLE terminal_tabs ADD COLUMN hibernated INTEGER NOT NULL DEFAULT 0`)
    }
  },
  {
    version: 142,
    up: (db) => {
      // CCS provider removed. Convert orphaned ccs tasks to claude-code (CCS ran
      // Claude underneath, so claude-code is the faithful successor), drop the
      // now-unused ccs_profile columns, strip dead provider_config.ccs keys, and
      // clean the CCS settings rows.
      db.exec(`UPDATE tasks SET terminal_mode = 'claude-code' WHERE terminal_mode = 'ccs'`)
      db.exec(`ALTER TABLE tasks DROP COLUMN ccs_profile`)
      db.exec(`ALTER TABLE task_templates DROP COLUMN ccs_profile`)
      db.exec(
        `UPDATE tasks SET provider_config = json_remove(provider_config, '$.ccs')
         WHERE provider_config IS NOT NULL AND json_extract(provider_config, '$.ccs') IS NOT NULL`
      )
      db.prepare(`DELETE FROM settings WHERE key IN ('ccs_enabled', 'ccs_default_profile')`).run()
    }
  },
  {
    version: 143,
    up: (db) => {
      // Per-task panel sizes (JSON). Previously panel widths lived in a single
      // global setting (`taskDetailPanelSizes`) shared across every task, so
      // resizing one task's panels leaked into all others. Sizes now persist
      // per task, mirroring panel_visibility. NULL → runtime defaults.
      db.exec(`ALTER TABLE tasks ADD COLUMN panel_sizes TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 144,
    up: (db) => {
      // Project groups — Discord-style folders (rail view) + labeled collapsible
      // sections (tree view). One shared entity drives both renderings.
      //
      // Ordering model: `project_groups.sort_order` and the `sort_order` of
      // UNGROUPED projects (group_id IS NULL) share ONE integer space — the
      // top-level list is the merge of both, sorted by sort_order (Discord's
      // rail is a single ordered list mixing folders + loose servers). A
      // GROUPED project's `sort_order` is its position WITHIN its group instead.
      // `collapsed` persists expand/collapse, shared across both views.
      db.exec(`
        CREATE TABLE project_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ALTER TABLE projects ADD COLUMN group_id TEXT DEFAULT NULL;
      `)
    }
  },
  {
    version: 145,
    up: (db) => {
      // Append-only ledger of conversation IDs per task per provider. Replaces
      // the mutable `provider_config.{mode}.conversationId` singleton (which
      // gets clobbered when slay observes a sessionId without verifying its
      // provenance — see conversation-id-robustness.md).
      //
      // Rows are NEVER updated. "Current" is the latest honored row for a
      // (task_id, mode) pair, strictly after any `manual-reset` cutoff.
      //   - slay-spawned-{fresh,resume}: sessionId observed matched what slay
      //     spawned. Honored.
      //   - cas-repoint-heal: conversation-healer re-pointed at resume time.
      //     Honored.
      //   - legacy-migration: one-time backfill from existing provider_config.
      //     Honored.
      //   - foreign-observed: sessionId did NOT match the one slay spawned
      //     (a manual `--resume X` in the PTY). Recorded for audit, NEVER
      //     honored on read.
      //   - manual-reset: user-issued sentinel; conversation_id is NULL.
      //     Cutoff — every earlier row is irrelevant on read.
      //   - pending-spawn: hook-driven providers store the expected sessionId
      //     here at spawn so the REST hook can verify provenance without an
      //     in-memory map. Pruned by TTL.
      db.exec(`
        CREATE TABLE task_conversations (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'manual-reset',
            'pending-spawn'
          ))
        );
        CREATE INDEX task_conversations_lookup
          ON task_conversations (task_id, mode, created_at DESC);
        CREATE INDEX task_conversations_pending
          ON task_conversations (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';
      `)

      // Backfill from existing provider_config.{mode}.conversationId +
      // conversationHistory[]. created_at is derived from the task's own
      // created_at when available so backfill ordering matches historical
      // sequence; the history index offsets per-entry so order is preserved.
      const tasks = db
        .prepare(
          `SELECT id, provider_config, created_at FROM tasks WHERE provider_config IS NOT NULL`
        )
        .all() as Array<{ id: string; provider_config: string; created_at: string | null }>
      const insert = db.prepare(
        `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at) VALUES (?, ?, ?, ?, 'legacy-migration', NULL, ?)`
      )
      for (const task of tasks) {
        let cfg: Record<string, unknown>
        try {
          cfg = JSON.parse(task.provider_config) as Record<string, unknown>
        } catch {
          continue
        }
        const baseMs = task.created_at ? Date.parse(task.created_at) : Date.now()
        const baseValid = Number.isFinite(baseMs) ? baseMs : Date.now()
        for (const [mode, raw] of Object.entries(cfg)) {
          if (!raw || typeof raw !== 'object') continue
          const entry = raw as { conversationId?: unknown; conversationHistory?: unknown }
          const history = Array.isArray(entry.conversationHistory)
            ? entry.conversationHistory.filter((v): v is string => typeof v === 'string')
            : []
          // Insert history oldest-first; current id last so it wins on read.
          history.forEach((cid, i) => {
            insert.run(randomUUID(), task.id, mode, cid, baseValid + i)
          })
          if (typeof entry.conversationId === 'string' && entry.conversationId) {
            // Only insert current if it's not already the most-recent history entry,
            // to avoid an exact-duplicate row at the same conversation_id.
            if (history[history.length - 1] !== entry.conversationId) {
              insert.run(
                randomUUID(),
                task.id,
                mode,
                entry.conversationId,
                baseValid + history.length
              )
            }
          }
        }
      }
    }
  },
  {
    version: 146,
    up: (db) => {
      // User prompts sent to a task's agent, captured from the agent's
      // UserPromptSubmit hook (clean exact text — unlike raw PTY stdin, which
      // is deliberately dropped because edit keys / pastes / ↑-history can't be
      // reconstructed). Powers the agent-terminal "messages" sidebar. Grouped
      // by task + agent mode; the sidebar shows the main agent by filtering on
      // its current mode. CASCADE so deleting a task clears its prompt history.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_prompts (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id       TEXT NOT NULL,
          cli_session_id TEXT,
          text           TEXT NOT NULL,
          created_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_prompts_task
          ON agent_prompts(task_id, agent_id, created_at ASC);
      `)
    }
  },
  {
    version: 147,
    up: (db) => {
      // First-class agent-session entity. See plans/agent-sessions.md.
      //
      // An agent session is a spawned provider process with its OWN durable
      // identity (`id`, a UUID we mint), independent of any task. It supersedes
      // the `taskId:tabId`-encoded session identity and folds in the
      // `task_conversations` provenance ledger (v145) as the single source of
      // truth. `task_conversations` is retired in a later migration once reads
      // have cut over and prod has proven parity (slices 2-4 of the plan).
      //
      //   - id              : our minted uuid = the PTY session key.
      //   - mode            : provider mode (claude-code / codex / ...).
      //   - cwd             : spawn working dir = pool key. NULL for historical
      //                       / audit rows that were never live-managed.
      //   - task_id         : NULL while pooled; set ONCE on assignment; never
      //                       moves (no reattach).
      //   - conversation_id : provider thread id; fills in on `turn-init`.
      //   - origin          : provenance; the HONORED set decides resume. Same
      //                       semantics as the v145 ledger MINUS `manual-reset`
      //                       (a reset is now a `session_resets` timeline event,
      //                       not a session).
      //   - status          : pooled | bound | dead.
      //   - pending_meta    : {usedResume, spawnedAt} for the in-flight
      //                       provenance match (hook-driven providers).
      //
      // Reset modeled as an explicit (task, mode) timeline event in
      // `session_resets` — NOT a flag on old sessions. Normal process exit
      // (every closed tab) leaves a session resumable; only a user reset means
      // "forget everything before now". The resolver applies the cutoff
      // structurally in SQL, identical to the v145 ledger semantics.
      db.exec(`
        CREATE TABLE agent_sessions (
          id              TEXT PRIMARY KEY,
          mode            TEXT NOT NULL,
          cwd             TEXT,
          task_id         TEXT,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          status          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          bound_at        INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'pending-spawn'
          )),
          CHECK (status IN ('pooled','bound','dead'))
        );
        CREATE INDEX agent_sessions_task
          ON agent_sessions (task_id, mode, created_at DESC);
        CREATE INDEX agent_sessions_pool
          ON agent_sessions (cwd, mode)
          WHERE status = 'pooled';
        CREATE INDEX agent_sessions_pending
          ON agent_sessions (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';

        CREATE TABLE session_resets (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          mode       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX session_resets_lookup
          ON session_resets (task_id, mode, created_at DESC);
      `)

      // One-time backfill: shadow every existing `task_conversations` row into
      // the new tables, preserving id + created_at so the new resolver picks the
      // exact same "current" conversation the v145 resolver does (parity is
      // asserted by the slice-2 cutover). Historical rows are audit-only — their
      // OS processes are long gone — so `status='dead'` and `cwd=NULL`.
      //   - `manual-reset` rows  → `session_resets` (a reset is not a session).
      //   - every other origin   → `agent_sessions`.
      // Only rows whose task still exists. Both targets declare `task_id` a real foreign
      // key, so one orphan (a ledger row left behind by a database that was ever written
      // with enforcement off) made this INSERT throw — and a migration that throws rolls
      // back and throws again on every launch, so the app could never start. No task can
      // reach such a row; it stays in `task_conversations`, untouched.
      const rows = db
        .prepare(
          `SELECT id, task_id, mode, conversation_id, origin, pending_meta, created_at
             FROM task_conversations
            WHERE task_id IN (SELECT id FROM tasks)`
        )
        .all() as Array<{
        id: string
        task_id: string
        mode: string
        conversation_id: string | null
        origin: string
        pending_meta: string | null
        created_at: number
      }>
      const insSession = db.prepare(
        `INSERT INTO agent_sessions
           (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta, created_at, bound_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'dead', ?, ?, ?)`
      )
      const insReset = db.prepare(
        `INSERT INTO session_resets (id, task_id, mode, created_at) VALUES (?, ?, ?, ?)`
      )
      for (const r of rows) {
        if (r.origin === 'manual-reset') {
          insReset.run(r.id, r.task_id, r.mode, r.created_at)
        } else {
          insSession.run(
            r.id,
            r.mode,
            r.task_id,
            r.conversation_id,
            r.origin,
            r.pending_meta,
            r.created_at,
            r.created_at
          )
        }
      }
    }
  },
  {
    version: 148,
    up: (db) => {
      // Slice 3 + entity-model B (plans/agent-sessions.md): `agent_sessions`
      // becomes the SESSION entity — one row per spawn, whose `id` is the
      // runtime PTY key (a main-minted uuid) instead of the `taskId:tabId`
      // string. Two additive columns:
      //   - `tab_id`   : which pane this session belongs to. NULL while pooled
      //                  (no tab yet) and for v147 backfilled audit rows.
      //   - `ended_at` : when the session's process exited (status→dead). NULL
      //                  while live; backfilled audit rows are already dead so
      //                  this stays NULL for them (exit time unknown).
      // "Current session for tab T" = the latest live row with that `tab_id`.
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN tab_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN ended_at INTEGER;
        CREATE INDEX agent_sessions_tab ON agent_sessions (tab_id, created_at DESC);
      `)
    }
  },
  {
    version: 149,
    up: (db) => {
      // Runner schema for the hub/runner split (wave 1). Lands DARK: purely
      // additive and all-nullable — nothing reads or writes these until the
      // @slayzone/computers domain is wired up in the integration wave.
      //
      //   - runners                    : one row per enrolled runner (a machine
      //                                  /process that can host task work).
      //                                  `capabilities_json` is a JSON object;
      //                                  `revoked_at` NULL = active.
      //   - join_tokens                : single-use enrollment tokens. Only
      //                                  sha256(token) at rest — the plaintext
      //                                  token is shown once at mint and never
      //                                  stored. `used_at` NULL = unclaimed;
      //                                  `runner_id` links the runner that
      //                                  eventually enrolled with it.
      //   - runner_project_checkouts  : where each runner has each project
      //                                  checked out, one row per pair.
      //   - tasks.runner_id            : NULL = inherit the project default.
      //   - projects.default_runner_id : NULL = no explicit default (exec falls
      //     back to the connected default runner, else in-process).
      db.exec(`
        CREATE TABLE runners (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          platform          TEXT NOT NULL,
          version           TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          auth_key_id       TEXT,
          last_seen_at      INTEGER,
          created_at        INTEGER NOT NULL,
          revoked_at        INTEGER
        );

        CREATE TABLE join_tokens (
          id         TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          label      TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at    INTEGER,
          runner_id  TEXT
        );

        CREATE TABLE runner_project_checkouts (
          runner_id  TEXT NOT NULL,
          project_id TEXT NOT NULL,
          root_path  TEXT NOT NULL,
          status     TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (runner_id, project_id)
        );

        ALTER TABLE tasks ADD COLUMN runner_id TEXT;
        ALTER TABLE projects ADD COLUMN default_runner_id TEXT;
      `)
    }
  },
  {
    version: 150,
    up: (db) => {
      // Rename the local-server discovery key `mcp_server_port` → `server_port`.
      // The "mcp" name was misleading — the value is the single port the sidecar
      // binds for /trpc+/api+/mcp+/health, unrelated to MCP-the-protocol. The
      // running server rewrites `server_port` on every boot (claimServerPort), so
      // this migration only carries the existing value forward for a CLI that runs
      // before the next boot.
      //
      // Copy the OLD value into the NEW key (old wins — it's the source of truth
      // being migrated from), then drop the old key. INSERT OR REPLACE + a guarded
      // SELECT keeps this idempotent and collision-safe: if `mcp_server_port` is
      // absent (already migrated, or a fresh DB), the INSERT's SELECT yields no row
      // and nothing changes — unlike a bare DELETE, which would wipe a live value
      // on a second application.
      db.exec(`
        INSERT OR REPLACE INTO settings (key, value)
          SELECT 'server_port', value FROM settings WHERE key = 'mcp_server_port';
        DELETE FROM settings WHERE key = 'mcp_server_port';
      `)
    }
  },
  {
    version: 151,
    up: (db) => {
      // Admit the `in-band-clear` provenance origin (see
      // task/shared/conversation-origins.ts). An agent that rotates its own
      // session id in place — Claude Code's `/clear` — reports a session id that
      // differs from the one slay pre-minted at spawn, which the v145/v147 gate
      // could only read as `foreign-observed` (audit-only, never resumed). The
      // consequence was silent and load-bearing: after a `/clear` the task kept
      // resuming the PRE-clear conversation, and the cleared session never
      // appeared in the sessions sidebar.
      //
      // A CHECK constraint can't be altered in place in SQLite, so both tables
      // are rebuilt. Mechanics that make this safe:
      //   - `PRAGMA foreign_keys = OFF` for the swap: both tables carry an FK to
      //     `tasks(id)`, and a DROP of the old table with FKs enforced would
      //     cascade. Restored immediately after. Same pattern as v?? for
      //     `integration_connections` / `terminal_modes` above.
      //   - Columns are enumerated EXPLICITLY (not `SELECT *`) so the copy stays
      //     correct if a future migration reorders columns.
      //   - Every index is recreated verbatim — a rebuilt table loses its
      //     indexes with the old one, and `agent_sessions_pending` /
      //     `_task` / `_tab` / `_pool` are all on hot resolver paths.
      // `in-band-clear` is deliberately NOT backfilled onto historical
      // `foreign-observed` rows: the SessionStart `source` field that
      // distinguishes a `/clear` from a manual `--resume <foreign>` was only
      // ever logged to diagnostics, never persisted to these tables, so there is
      // no owned data to reclassify from. Existing rows keep their recorded
      // provenance; the first `/clear` after this ships binds correctly.
      db.exec(`PRAGMA foreign_keys = OFF;`)
      db.exec(`
        CREATE TABLE task_conversations_new (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'manual-reset',
            'pending-spawn'
          ))
        );
        -- Only rows whose task still exists: the new table enforces the foreign key (and
        -- \`PRAGMA foreign_keys = OFF\` is a no-op inside this transaction), so one orphan
        -- made this copy throw on every launch. No task can reach such a row.
        INSERT INTO task_conversations_new
          (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
          SELECT id, task_id, mode, conversation_id, origin, pending_meta, created_at
            FROM task_conversations
           WHERE task_id IN (SELECT id FROM tasks);
        DROP TABLE task_conversations;
        ALTER TABLE task_conversations_new RENAME TO task_conversations;
        CREATE INDEX task_conversations_lookup
          ON task_conversations (task_id, mode, created_at DESC);
        CREATE INDEX task_conversations_pending
          ON task_conversations (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';

        CREATE TABLE agent_sessions_new (
          id              TEXT PRIMARY KEY,
          mode            TEXT NOT NULL,
          cwd             TEXT,
          task_id         TEXT,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          status          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          bound_at        INTEGER,
          tab_id          TEXT,
          ended_at        INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'pending-spawn'
          )),
          CHECK (status IN ('pooled','bound','dead'))
        );
        INSERT INTO agent_sessions_new
          (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
           created_at, bound_at, tab_id, ended_at)
          SELECT id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
                 created_at, bound_at, tab_id, ended_at
            FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
        CREATE INDEX agent_sessions_task
          ON agent_sessions (task_id, mode, created_at DESC);
        CREATE INDEX agent_sessions_pool
          ON agent_sessions (cwd, mode)
          WHERE status = 'pooled';
        CREATE INDEX agent_sessions_pending
          ON agent_sessions (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';
        CREATE INDEX agent_sessions_tab
          ON agent_sessions (tab_id, created_at DESC);
      `)
      db.exec(`PRAGMA foreign_keys = ON;`)
    }
  },
  {
    version: 152,
    up: (db) => {
      // Per-artifact document zoom, as an integer percent. NULL = 100% so the
      // column stays empty for the overwhelming majority of rows — same
      // "override only when it differs from the default" shape as
      // readability_override / width_override (v109).
      db.exec(`ALTER TABLE task_artifacts ADD COLUMN zoom_pct INTEGER DEFAULT NULL;`)
    }
  },
  {
    version: 153,
    up: (db) => {
      // Starred projects are exempt from the sidebar tree's "hide inactive
      // projects" collapse — same non-nullable default-0 boolean shape as
      // tasks.pinned (v140).
      db.exec(`ALTER TABLE projects ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    version: 154,
    up: (db) => {
      // Last known top-level pid of a managed process's spawn. Lets the manager
      // reap a leftover process (still holding its port) that survived an
      // uncontrolled app/sidecar exit — the previous run never had a chance to
      // send it a kill signal, so nothing on disk remembered its pid at all.
      db.exec(`ALTER TABLE processes ADD COLUMN pid INTEGER DEFAULT NULL;`)
    }
  },
  {
    version: 155,
    up: (db) => {
      // One-time reset of `was_spawned`. The flag is set on spawn and cleared on
      // exit by a recorder that, since the pty runtime moved to the side-car,
      // nothing installed — so no live agent was ever flagged, and the only rows
      // left at 1 are strays written directly by the REST `pty/start-main` path
      // that nothing has cleared since. Left alone, the now-working restore
      // would resurrect those long-dead tasks as background tabs on first boot.
      //
      // Safe to blanket-clear: migrations run at hub boot, before any session
      // exists in this process, so a `1` here can only be stale by construction.
      // Cost is exactly one boot without auto-restore; every boot after this
      // reflects real spawn/exit.
      db.exec(`UPDATE terminal_tabs SET was_spawned = 0 WHERE was_spawned = 1;`)
    }
  },
  {
    version: 156,
    up: (db) => {
      // Admit the `user-selected` provenance origin (see
      // task/shared/conversation-origins.ts). The sessions sidebar can now switch
      // the task back to an EARLIER session; the switch is durable only if it
      // appends an honored row naming that conversation, because the resume hint
      // (`currentConversationByMode`) is the newest honored row. Reusing
      // `slay-spawned-resume` would have worked mechanically but asserts a spawn
      // slay observed — a lie in the one table whose whole job is answering
      // "where did this conversation id come from?".
      //
      // Mechanically identical to v151 (`in-band-clear`), because it is the same
      // problem: SQLite cannot ALTER a CHECK in place, so both tables are
      // rebuilt. The same three things make that safe —
      //   - `PRAGMA foreign_keys = OFF` around the swap: both tables carry an FK
      //     to `tasks(id)`, and a DROP with FKs enforced would cascade.
      //   - columns enumerated EXPLICITLY (never `SELECT *`), so the copy stays
      //     correct if a later migration reorders columns.
      //   - every index recreated verbatim — a rebuilt table loses the old one's
      //     indexes, and four of these sit on hot resolver paths.
      // No backfill: no historical row was ever a user selection.
      db.exec(`PRAGMA foreign_keys = OFF;`)
      db.exec(`
        CREATE TABLE task_conversations_new (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'user-selected',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'manual-reset',
            'pending-spawn'
          ))
        );
        -- Only rows whose task still exists: the new table enforces the foreign key (and
        -- \`PRAGMA foreign_keys = OFF\` is a no-op inside this transaction), so one orphan
        -- made this copy throw on every launch. No task can reach such a row.
        INSERT INTO task_conversations_new
          (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
          SELECT id, task_id, mode, conversation_id, origin, pending_meta, created_at
            FROM task_conversations
           WHERE task_id IN (SELECT id FROM tasks);
        DROP TABLE task_conversations;
        ALTER TABLE task_conversations_new RENAME TO task_conversations;
        CREATE INDEX task_conversations_lookup
          ON task_conversations (task_id, mode, created_at DESC);
        CREATE INDEX task_conversations_pending
          ON task_conversations (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';

        CREATE TABLE agent_sessions_new (
          id              TEXT PRIMARY KEY,
          mode            TEXT NOT NULL,
          cwd             TEXT,
          task_id         TEXT,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          status          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          bound_at        INTEGER,
          tab_id          TEXT,
          ended_at        INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'user-selected',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'pending-spawn'
          )),
          CHECK (status IN ('pooled','bound','dead'))
        );
        INSERT INTO agent_sessions_new
          (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
           created_at, bound_at, tab_id, ended_at)
          SELECT id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
                 created_at, bound_at, tab_id, ended_at
            FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
        CREATE INDEX agent_sessions_task
          ON agent_sessions (task_id, mode, created_at DESC);
        CREATE INDEX agent_sessions_pool
          ON agent_sessions (cwd, mode)
          WHERE status = 'pooled';
        CREATE INDEX agent_sessions_pending
          ON agent_sessions (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';
        CREATE INDEX agent_sessions_tab
          ON agent_sessions (tab_id, created_at DESC);
      `)
      db.exec(`PRAGMA foreign_keys = ON;`)
    }
  },
  {
    version: 157,
    up: (db) => {
      // Session DELETE, as a tombstone rather than a `DELETE FROM`. Every table
      // in this subsystem is append-only on purpose: the provenance rows are the
      // only evidence available when a task resumes the wrong conversation, and
      // a hard delete would destroy exactly the rows you need to diagnose that.
      // So a deleted session keeps its history and gains a marker that every
      // reader excludes — structurally, in SQL, the same shape `session_resets`
      // (v147) uses for the reset cutoff.
      //
      // Scoped to (task, mode, conversation): the same provider conversation id
      // can legitimately appear under two modes for one task, and deleting it in
      // the sidebar of one must not silently hide the other.
      db.exec(`
        CREATE TABLE session_deletions (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX session_deletions_lookup
          ON session_deletions (task_id, mode, conversation_id);
      `)
    }
  },
  {
    version: 158,
    up: (db) => {
      // Resumability proof for a session.
      //
      // A provider writes its transcript at the FIRST TURN, not at startup:
      // `claude --session-id <uuid>` boots, fires SessionStart, and writes
      // NOTHING until someone submits a prompt. So between spawn and first turn
      // the id exists in slay but not on disk, and `--resume <id>` can only
      // answer "No conversation found with session ID:".
      //
      // That window used to be seconds. The warm pool made it unbounded: an
      // agent is pre-booted per (runner, project) and can sit turn-less for
      // hours before a task adopts it — at which point its id became the task's
      // resume target. Restarting the terminal then failed, and the recovery
      // path RESET the task, which cut off the conversation that was actually
      // doing the work. Measured on one day of this machine: 186 of 214 minted
      // ids had no transcript, and every one of them had taken zero turns.
      //
      // A SEPARATE append-only table, not a column on `agent_sessions` — the same
      // shape `session_resets` (v147) and `session_deletions` (v157) already use
      // for facts about a session that arrive later than the session row. It also
      // keeps the two table-rebuild migrations (v151/v156) and their column-drift
      // guard untouched: a fact recorded elsewhere cannot be dropped by a rebuild
      // that enumerates columns.
      //
      // Keyed by conversation id, because that is the only identifier shared by a
      // task-spawned agent and a warm-pool one (whose env was fixed before any
      // task existed) — and it is what the provider's own hook payload carries.
      //
      // Backfill marks every existing session proven, so an upgrade changes
      // nothing for tasks that already resume correctly; only sessions spawned
      // after this migration can be born unproven.
      db.exec(`
        CREATE TABLE session_turns (
          conversation_id TEXT PRIMARY KEY,
          first_turn_at   INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at)
        SELECT conversation_id, coalesce(bound_at, created_at)
          FROM agent_sessions
         WHERE conversation_id IS NOT NULL
           AND origin <> 'pending-spawn';
      `)
    }
  },
  {
    version: 159,
    up: (db) => {
      // Reverse lookup: which project contains this directory?
      //
      // `runner_project_checkouts` (v149) already models "where each runner has
      // each project checked out", and this is the change that starts using it.
      // The index serves `resolveProjectByPath`, which is how `slay` turns the
      // directory it is running in into a project — a scan per invocation would
      // be the one hot path on this table.
      db.exec(`
        CREATE INDEX idx_runner_checkouts_path ON runner_project_checkouts(root_path);
      `)
    }
  },
  {
    version: 161,
    up: (db) => {
      // Who a runner belongs to.
      //
      // `runners.owner_user_id`: a runner process runs as exactly ONE OS account,
      // so two SlayZone users sharing one runner share a filesystem, a credential
      // set, and a process owner. Per-user subfolders inside it would be
      // organisation, not isolation, and rotating credentials by time does not
      // help — a long-running agent outlives the rotation. A shared machine is
      // still fine; it just runs one runner per OS account, which is the unit that
      // actually carries an identity.
      //
      // NULL = pre-existing / unclaimed, which every runner is today. Not
      // backfilled: inventing an owner would be a claim about who a machine
      // belongs to that nothing here knows.
      db.exec(`
        ALTER TABLE runners ADD COLUMN owner_user_id TEXT;
      `)
    }
  },
  {
    version: 162,
    up: (db) => {
      // Who minted a join token, so the runner that redeems it can inherit an
      // owner. A token is the only thing that crosses from "a user clicked mint"
      // to "a machine enrolled", so it is the only place the attribution can be
      // carried without asking the runner to assert an identity it cannot prove.
      //
      // NULL on every existing token and on any mint from an unauthenticated
      // loopback hub, which is the normal local case — an unowned runner stays
      // unowned rather than being attributed to a guess.
      db.exec(`ALTER TABLE join_tokens ADD COLUMN minted_by_user_id TEXT;`)
    }
  },
  {
    version: 163,
    up: (db) => {
      // "Runner" was CI vocabulary — ephemeral, fungible, job-scoped — for a thing
      // that holds your checkouts, your credentials and your ptys across restarts.
      // The unit is a machine you own and keep, so it is a COMPUTER.
      //
      // Renames rather than a rebuild: SQLite's RENAME COLUMN rewrites the stored
      // schema text, so `runner_project_checkouts`' composite PRIMARY KEY
      // (runner_id, project_id) follows automatically, and RENAME TO carries the
      // table's indexes. Nothing here declares a foreign key and no view or
      // trigger references these tables, so there is no dependency to repair.
      //
      // `project_placements` rather than `..._checkouts`: with provisioning gone
      // the row is not a checkout lifecycle, it is "this project sits at this path
      // on this computer" — one placement per pair.
      //
      // The index cannot be renamed in place (SQLite has no RENAME INDEX), so it
      // is dropped and recreated under the new name.
      db.exec(`
        ALTER TABLE runners RENAME TO computers;
        ALTER TABLE runner_project_checkouts RENAME TO project_placements;

        ALTER TABLE project_placements RENAME COLUMN runner_id TO computer_id;
        ALTER TABLE join_tokens RENAME COLUMN runner_id TO computer_id;
        ALTER TABLE tasks RENAME COLUMN runner_id TO computer_id;
        ALTER TABLE projects RENAME COLUMN default_runner_id TO default_computer_id;

        DROP INDEX IF EXISTS idx_runner_checkouts_path;
        CREATE INDEX idx_project_placements_path ON project_placements(root_path);
      `)
    }
  },
  {
    version: 164,
    up: (db) => {
      // A MACHINE is the physical box; a COMPUTER is one OS user's environment on
      // it. Several computers share a machine — one per OS account — and this is
      // what lets the UI group them.
      //
      // `host_id` is a MUTABLE ATTRIBUTE, not an identity. A box's id is discovered
      // from a world-writable file (see computer/host-id.ts) and a computer can
      // ADOPT a peer's value, so it changes under you. Two consequences the schema
      // encodes deliberately:
      //
      //   - no foreign key, and no computer ever stores a machine id. Association
      //     is a value join on `host_id`. A merge DELETES the losing machine row,
      //     so any stored reference to it would dangle.
      //   - `host_id` is UNIQUE on machines, which makes "two machine rows for one
      //     box" unrepresentable going forward. The merge case arises only when a
      //     computer flips onto an id another row already holds.
      //
      // `name` NULL = never named. A named machine is the only thing here a user
      // authored, which is why the merge rule keeps the named row.
      db.exec(`
        CREATE TABLE machines (
          id         TEXT PRIMARY KEY,
          host_id    TEXT NOT NULL UNIQUE,
          name       TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        ALTER TABLE computers ADD COLUMN host_id TEXT;
        CREATE INDEX idx_computers_host_id ON computers(host_id);
      `)
    }
  },
  {
    version: 165,
    up: (db) => {
      // Private by default — but only for a computer that HAS an owner.
      //
      // An unowned computer stays visible to every authenticated user. Hiding it
      // would strand every existing install behind a claim nobody knows to
      // perform: `owner_user_id` is NULL on every row today (v161 deliberately did
      // not backfill, because inventing an owner is a claim about whose machine it
      // is that nothing here knows). `computers.claim` is how a NULL becomes a
      // real owner.
      //
      // `visibility` only means anything once owned:
      //   private — owner + explicit grants + hub admins
      //   hub     — every authenticated user on this hub
      //   shared  — reserved for cross-hub sharing; treated as `private` for now
      db.exec(`
        ALTER TABLE computers ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

        CREATE TABLE computer_grants (
          computer_id        TEXT NOT NULL,
          user_id            TEXT NOT NULL,
          role               TEXT NOT NULL DEFAULT 'use',
          granted_by_user_id TEXT,
          created_at         INTEGER NOT NULL,
          PRIMARY KEY (computer_id, user_id)
        );
        CREATE INDEX idx_computer_grants_user ON computer_grants(user_id);
      `)
    }
  },
  {
    version: 166,
    up: (db) => {
      // A scoped browser session, distinct from a better-auth session.
      //
      // WHY A SEPARATE TABLE, in the APP db rather than hub-auth's own
      // better-auth sqlite file: hub-auth's schema is better-auth's to own, and
      // this concept — "a narrower credential than the account it was minted
      // from" — has no equivalent there. `user_id` is a LOOSE reference to a
      // better-auth user id, not a foreign key: this app db has no `users`
      // table of its own (that lives in hub-auth's separate file), so nothing
      // here can enforce referential integrity across the two databases. A row
      // whose user was later removed via `slay hub users rm` simply verifies
      // against nothing (the login flow re-checks the user still exists) and
      // is harmless dead weight until it expires or is revoked.
      //
      // `token_hash`, never the raw token — this table is queried on every
      // `/trpc` connect and every `/api/*` request from a browser, so the
      // token itself must never be recoverable from a DB read the way a
      // stolen backup or a compromised replica could produce one.
      //
      // `scopes_json` is a JSON array of `Scope` values (see
      // `@slayzone/transport/scopes`) — TEXT, not a join table,
      // because the vocabulary is deliberately tiny and closed; a session's
      // scopes never need to be queried independently of the session itself.
      //
      // `revoked_at` gives real server-side logout: `expires_at` alone would
      // leave a stolen token valid until it naturally expired.
      db.exec(`
        CREATE TABLE web_sessions (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          token_hash   TEXT NOT NULL UNIQUE,
          scopes_json  TEXT NOT NULL,
          label        TEXT,
          created_at   INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          revoked_at   INTEGER
        );
        CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);
      `)
    }
  },
  {
    version: 167,
    up: (db) => {
      // Per-artifact forced color scheme for HTML preview. NULL = no
      // override (follow whatever `prefers-color-scheme` resolves to inside
      // the iframe) — same "override only when it differs from the default"
      // shape as zoom_pct (v152) / readability_override / width_override
      // (v109).
      db.exec(`ALTER TABLE task_artifacts ADD COLUMN html_theme_override TEXT DEFAULT NULL;`)
    }
  },
  {
    version: 168,
    up: (db) => {
      // Every leader pid ever spawned for a process row, not just the newest
      // (processes.pid, v154, overwrites on every restart). A restart from an
      // orphaned row only ever verified/reaped that single overwritable
      // value, so a descendant left behind by an OLDER, already-superseded
      // spawn attempt became permanently unreachable the moment a later
      // restart clobbered the column — it sat holding its port forever, and
      // no amount of restarting (the row, or the whole app) could recover
      // it. A table, not a JSON column on processes: entries need row-level
      // lookup-by-process_id and individual delete-on-prune without a
      // read-modify-write JSON cycle. No FK/CASCADE — `PRAGMA foreign_keys`
      // is toggled on/off per-connection elsewhere in this codebase, so
      // cascade delete can't be relied on; process-persistence.ts's remove()
      // deletes matching rows here explicitly instead.
      db.exec(`
        CREATE TABLE IF NOT EXISTS process_pids (
          process_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          spawned_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (process_id, pid)
        );
        CREATE INDEX IF NOT EXISTS idx_process_pids_process ON process_pids(process_id);
      `)
    }
  },
  {
    version: 169,
    up: (db) => {
      // Who owns a project, and per-user settings (T-16).
      //
      // `projects.owner_user_id` is the root of ownership on a hub with several
      // users. Tasks hang off a project, and terminal tabs, chat, artifacts and
      // agent prompts off a task, all through NOT NULL foreign keys — so they
      // inherit the owner through that chain instead of carrying a copy that
      // could drift. A LOOSE reference to a hub-auth user id, like
      // `web_sessions.user_id` (v166): the users live in the auth database, so
      // nothing here can enforce it.
      //
      // NULL = no owner recorded: every project that exists today, and every
      // project created on a hub without login (the desktop app's), where no user
      // is attached to the request. Not backfilled here, because this database
      // cannot see the users; a hub that requires login assigns unowned projects
      // to its first admin at boot (`apps/hub/src/ownership-backfill.ts`).
      //
      // `user_settings`: settings rows that are one person's state (open tabs,
      // layout, filters) rather than the hub's. Same loose `user_id`. Used only
      // for a request that carries a user; a hub without login keeps every key
      // in `settings`, exactly as before. Which key is which: `settingScope` in
      // `@slayzone/settings-core/server`. The `key` index serves the boot purge, which
      // reads every user's `viewState`.
      db.exec(`
        ALTER TABLE projects ADD COLUMN owner_user_id TEXT;
        CREATE INDEX idx_projects_owner_user_id ON projects(owner_user_id);

        CREATE TABLE user_settings (
          user_id TEXT NOT NULL,
          key     TEXT NOT NULL,
          value   TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        CREATE INDEX idx_user_settings_key ON user_settings(key);
      `)
    }
  },
  {
    version: 170,
    up: (db) => {
      // Who a join token is FOR (T-20): the user the computer that redeems it will
      // belong to. On a hub with login only an admin mints, always naming that user,
      // so the minter (`minted_by_user_id`, kept for the record) is no longer the
      // owner. Same loose hub-auth user id as v162.
      //
      // Backfilled from the minter: before this the minter WAS the owner, and an
      // unused token minted then must still enroll its computer for the same user.
      db.exec(`
        ALTER TABLE join_tokens ADD COLUMN owner_user_id TEXT;
        UPDATE join_tokens SET owner_user_id = minted_by_user_id;
      `)
    }
  },
  {
    version: 171,
    up: (db) => {
      // Agent startup mode (plans/agent-startup-mode.md).
      //
      // 1. `terminal_tabs.agent_state` replaces `was_spawned` + `hibernated`. The two
      //    flags encoded three states — (1,0) running, (0,1) idle-closed, (0,0)
      //    stopped OR never started — and could drift into a fourth. One column, plus
      //    the state the flags could not express: `new` (never started), which task
      //    create writes. Rows that exist now, and rows created lazily for older
      //    tasks, are `stopped` (the column default).
      db.exec(`
        ALTER TABLE terminal_tabs ADD COLUMN agent_state TEXT NOT NULL DEFAULT 'stopped';
        UPDATE terminal_tabs SET agent_state = CASE
          WHEN was_spawned = 1 THEN 'running'
          WHEN hibernated = 1 THEN 'auto_stopped'
          ELSE 'stopped'
        END;
        ALTER TABLE terminal_tabs DROP COLUMN was_spawned;
        ALTER TABLE terminal_tabs DROP COLUMN hibernated;
      `)

      // 2. `terminal_agent_startup` replaces the `terminal_auto_start` +
      //    `terminal_prewarm_enabled` checkboxes. An existing install keeps what it
      //    had: auto-start on + pre-warm on → instant, auto-start on → auto, auto-start
      //    off or never set → manual (the Start gate it saw before). A fresh database
      //    (no tasks yet) gets no row, i.e. the default `auto`.
      //    `terminal_auto_start` was mis-scoped as a per-user key, so on a hub with
      //    login it may sit in `user_settings` instead; any user having it on counts.
      const isOn = (key: string): boolean =>
        (db
          .prepare(
            `SELECT 1 FROM settings WHERE key = ? AND value = '1'
               UNION ALL SELECT 1 FROM user_settings WHERE key = ? AND value = '1' LIMIT 1`
          )
          .get(key, key) as unknown) !== undefined
      const hasTasks = db.prepare('SELECT 1 FROM tasks LIMIT 1').get() !== undefined
      if (hasTasks) {
        const autoStart = isOn('terminal_auto_start')
        const prewarm = isOn('terminal_prewarm_enabled')
        const mode = autoStart ? (prewarm ? 'instant' : 'auto') : 'manual'
        db.prepare(
          `INSERT INTO settings (key, value) VALUES ('terminal_agent_startup', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(mode)
      }
      db.exec(`
        DELETE FROM settings WHERE key IN ('terminal_auto_start', 'terminal_prewarm_enabled');
        DELETE FROM user_settings WHERE key IN ('terminal_auto_start', 'terminal_prewarm_enabled');
      `)
    }
  },
  {
    version: 172,
    up: (db) => {
      // The last slash-command list a chat CLI advertised (Claude Code's
      // `system/init`), so the chat composer's `/` menu lists the CLI's own
      // commands before a session's first turn — the CLI only reports them once
      // a turn starts. Keyed by project + chat mode: the list includes the
      // project's own skills and commands. One row per pair, overwritten on
      // change. Owned through the project (CASCADE), like tasks.
      //
      // The three lists are JSON string arrays: all commands, the terminal-only
      // subset (hidden in chat), and the skills subset.
      db.exec(`
        CREATE TABLE chat_cli_snapshots (
          project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          mode                    TEXT NOT NULL,
          slash_commands          TEXT NOT NULL,
          terminal_slash_commands TEXT NOT NULL,
          skills                  TEXT NOT NULL,
          cli_version             TEXT,
          observed_at             INTEGER NOT NULL,
          PRIMARY KEY (project_id, mode)
        );
      `)
    }
  },
  {
    version: 173,
    up: (db) => {
      // Claude chat runs in the mode its pill shows (chat bug N2). Its pills own
      // the spawn's permission mode, model and effort; a task's own flags are
      // extras. Two leftovers of the time they didn't:
      //  - Task create copied the claude-chat terminal mode's default flags
      //    (`--allow-dangerously-skip-permissions`) into provider_config, where
      //    they beat the chat mode (the CLI started in `default`). Flags equal
      //    to that seed (the built-in default or the mode's current default) are
      //    removed; any other flags stay.
      //  - A boot backfill tagged every Claude chat entry 'bypass'. That never
      //    really bypassed (the flag only ALLOWS bypass) and now would, so the
      //    tag moves to the new-task default 'auto-accept'.
      // Codex chat and terminal modes are untouched.
      const MODE = 'claude-chat'
      const seeded = new Set(['--allow-dangerously-skip-permissions'])
      const row = db.prepare('SELECT default_flags FROM terminal_modes WHERE id = ?').get(MODE) as
        | { default_flags: string | null }
        | undefined
      if (row?.default_flags?.trim()) seeded.add(row.default_flags.trim())

      const update = db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
      const tasks = db
        .prepare(`SELECT id, provider_config FROM tasks WHERE provider_config LIKE '%claude-chat%'`)
        .all() as { id: string; provider_config: string }[]
      for (const task of tasks) {
        let cfg: Record<string, Record<string, unknown>>
        try {
          cfg = JSON.parse(task.provider_config)
        } catch {
          continue
        }
        const entry = cfg?.[MODE]
        if (!entry || typeof entry !== 'object') continue
        const next = { ...entry }
        if (typeof next.flags === 'string' && seeded.has(next.flags.trim())) delete next.flags
        if (next.chatMode === 'bypass') next.chatMode = 'auto-accept'
        if (JSON.stringify(next) === JSON.stringify(entry)) continue
        update.run(JSON.stringify({ ...cfg, [MODE]: next }), task.id)
      }
    }
  },
  {
    version: 174,
    up: (db) => {
      // A queued chat message's content blocks (JSON array: `{type:'text',text}`
      // today; images and documents with plan item 3.5), so a queued message
      // travels exactly like a sent one. NULL for rows from before: their
      // content is their `send` text.
      db.exec(`ALTER TABLE chat_queue ADD COLUMN content TEXT;`)
    }
  },
  {
    version: 175,
    up: (db) => {
      // Admit two honored provenance origins (chat A; see
      // task-contracts/conversation-origins.ts):
      //   - `handoff`: an EXISTING conversation of this task moved between the
      //     terminal (TUI) and chat ("Continue in chat / in terminal", or picking
      //     the other mode's session in the Sessions list). The CLI shares its
      //     session files between both (verified on 2.1.312), so the same id
      //     resumes on the other side. Not `user-selected`: that origin's guard
      //     requires an honored row for the SAME (task, mode).
      //   - `slay-spawned-fork`: a fork SlayZone spawned (`--resume S
      //     --resume-session-at A --fork-session --session-id N`): a new
      //     conversation with S's history. Not `slay-spawned-resume`, which
      //     claims N existed before.
      // Same rebuild as v151/v156 (a CHECK can't be altered in place), with the
      // same safety: FKs off around the swap, explicit columns, every index
      // recreated. No backfill.
      db.exec(`PRAGMA foreign_keys = OFF;`)
      db.exec(`
        CREATE TABLE task_conversations_new (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'user-selected',
            'handoff',
            'slay-spawned-fork',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'manual-reset',
            'pending-spawn'
          ))
        );
        -- Only rows whose task still exists: the new table enforces the foreign key (and
        -- \`PRAGMA foreign_keys = OFF\` is a no-op inside this transaction), so one orphan
        -- made this copy throw on every launch. No task can reach such a row.
        INSERT INTO task_conversations_new
          (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
          SELECT id, task_id, mode, conversation_id, origin, pending_meta, created_at
            FROM task_conversations
           WHERE task_id IN (SELECT id FROM tasks);
        DROP TABLE task_conversations;
        ALTER TABLE task_conversations_new RENAME TO task_conversations;
        CREATE INDEX task_conversations_lookup
          ON task_conversations (task_id, mode, created_at DESC);
        CREATE INDEX task_conversations_pending
          ON task_conversations (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';

        CREATE TABLE agent_sessions_new (
          id              TEXT PRIMARY KEY,
          mode            TEXT NOT NULL,
          cwd             TEXT,
          task_id         TEXT,
          conversation_id TEXT,
          origin          TEXT NOT NULL,
          status          TEXT NOT NULL,
          pending_meta    TEXT,
          created_at      INTEGER NOT NULL,
          bound_at        INTEGER,
          tab_id          TEXT,
          ended_at        INTEGER,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (origin IN (
            'slay-spawned-fresh',
            'slay-spawned-resume',
            'in-band-clear',
            'user-selected',
            'handoff',
            'slay-spawned-fork',
            'cas-repoint-heal',
            'legacy-migration',
            'foreign-observed',
            'pending-spawn'
          )),
          CHECK (status IN ('pooled','bound','dead'))
        );
        INSERT INTO agent_sessions_new
          (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
           created_at, bound_at, tab_id, ended_at)
          SELECT id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
                 created_at, bound_at, tab_id, ended_at
            FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
        CREATE INDEX agent_sessions_task
          ON agent_sessions (task_id, mode, created_at DESC);
        CREATE INDEX agent_sessions_pool
          ON agent_sessions (cwd, mode)
          WHERE status = 'pooled';
        CREATE INDEX agent_sessions_pending
          ON agent_sessions (task_id, mode, conversation_id)
          WHERE origin = 'pending-spawn';
        CREATE INDEX agent_sessions_tab
          ON agent_sessions (tab_id, created_at DESC);
      `)
      db.exec(`PRAGMA foreign_keys = ON;`)
    }
  },
  {
    version: 176,
    up: (db) => {
      // A project's folder lives on a computer, not on the hub. Every project with
      // a `projects.path` gets that folder on the LOCAL computer (the desktop app's
      // own, the only place such a path ever pointed) as `pending`, and the local
      // computer as its default when it has none. The hub hands each pending folder
      // to the computer when it connects (computer-project-sync.ts).
      // Here, not at hub start: it is done before anything reads a project, and
      // needs no `computers` row (there is no FK), so the folder shows from the
      // first read — also on a first boot after skipped releases, before the local
      // computer has ever enrolled. Migrations run in order, so it also runs
      // before the release that drops the column.
      // The column is left as is: a build from before still reads its paths.
      // The local computer's id, frozen: `deterministicLocalComputerId('local-computer')`
      // (computers/server/store.ts; migration.test.ts asserts they match).
      // A row 0.36 already kept for the local computer is replaced too: it was
      // `ready` without the computer having to list it under this hub, and a ready
      // row the computer does not report is dropped on connect — the project would
      // lose its folder. Pending is delivered (again) instead, with the column's
      // path: what the 0.36 settings showed.
      const LOCAL = 'f01a216a-4803-4214-98eb-f9e28951e1bb'
      db.prepare(
        `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
           SELECT ?, id, path, 'pending', ? FROM projects
            WHERE path IS NOT NULL AND path <> ''
         ON CONFLICT(computer_id, project_id) DO UPDATE SET
           root_path = excluded.root_path,
           status = 'pending',
           updated_at = excluded.updated_at`
      ).run(LOCAL, Date.now())
      db.prepare(
        `UPDATE projects SET default_computer_id = ?
          WHERE default_computer_id IS NULL
            AND EXISTS (SELECT 1 FROM project_placements c
                         WHERE c.computer_id = ? AND c.project_id = projects.id
                           AND c.status IN ('pending', 'ready'))`
      ).run(LOCAL, LOCAL)
    }
  },
  {
    version: 177,
    up: (db) => {
      // Chat composer (plan items 3.1 + 4.2).
      //
      // `chat_cli_command_details`: description + argument hint per slash command
      // of a chat CLI (Claude Code's `initialize` reply), per project + chat mode
      // like `chat_cli_snapshots`, so the `/` menu shows them before a session
      // starts. `details` is a JSON object `{name: {description, argumentHint}}`.
      //
      // `chat_tab_state`: a chat tab's draft (text + attached files as JSON
      // artifact references) and timeline scroll anchor (JSON; NULL = bottom), so
      // neither is lost to a remount or reload. `rev` counts saves (the composer's
      // local journal compares it). Gone with its tab.
      db.exec(`
        CREATE TABLE chat_cli_command_details (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          mode        TEXT NOT NULL,
          details     TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, mode)
        );
        CREATE TABLE chat_tab_state (
          tab_id            TEXT PRIMARY KEY REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          draft_text        TEXT NOT NULL DEFAULT '',
          draft_attachments TEXT,
          scroll_anchor     TEXT,
          rev               INTEGER NOT NULL DEFAULT 0,
          updated_at        INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 178,
    up: (db) => {
      // Codex chat (X1): the models a chat CLI offers the account (Codex
      // `model/list` at each handshake), per project + chat mode like
      // `chat_cli_command_details`, so the model picker lists them before a
      // session starts. `models` is a JSON array of `ChatModelInfo`.
      db.exec(`
        CREATE TABLE chat_cli_models (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          mode        TEXT NOT NULL,
          models      TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, mode)
        );
      `)
    }
  },
  {
    version: 179,
    up: (db) => {
      // Paged chat history (chat F).
      //
      // `chat_events.saved_at`: when the event was saved (ms since epoch). A row's
      // time comes from it, so every device and every replay shows the same time.
      // NULL on rows saved before: their `created_at` (seconds) stands in.
      //
      // The hub's timeline projection — DERIVED state, safe to throw away (it is
      // rebuilt from `chat_events` whenever its `version` differs or it can't be
      // read). `chat_timeline_checkpoints`: per tab, the reducer state without
      // its rows, the page table and the hub's own folds, as of event `seq`.
      // `chat_timeline_pages`: the rows of each sealed page, a summary of what the
      // whole-history features need from them, and their searchable text. A
      // checkpoint and the pages it names are written in one transaction.
      db.exec(`
        ALTER TABLE chat_events ADD COLUMN saved_at INTEGER;
        CREATE TABLE chat_timeline_checkpoints (
          tab_id     TEXT PRIMARY KEY REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          version    TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          data       TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE chat_timeline_pages (
          tab_id      TEXT NOT NULL REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          page        INTEGER NOT NULL,
          start_row   INTEGER NOT NULL,
          end_row     INTEGER NOT NULL,
          rows        TEXT NOT NULL,
          summary     TEXT NOT NULL,
          search_text TEXT NOT NULL,
          PRIMARY KEY (tab_id, page)
        );
      `)
    }
  },
  {
    version: 180,
    up: (db) => {
      db.exec(`
        CREATE TABLE chat_threads (
          id TEXT PRIMARY KEY REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          parent_tab_id TEXT NOT NULL REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          parent_conversation_id TEXT NOT NULL,
          answer_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          source_uuid TEXT NOT NULL,
          title TEXT NOT NULL,
          conversation_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX chat_threads_parent ON chat_threads(parent_tab_id, parent_conversation_id, created_at);
        CREATE TRIGGER chat_threads_delete_tab AFTER DELETE ON chat_threads BEGIN
          DELETE FROM terminal_tabs WHERE id = OLD.id;
        END;
      `)
    }
  },
  {
    version: 181,
    up: (db) => {
      db.exec('ALTER TABLE chat_queue ADD COLUMN conversation_id TEXT')
    }
  },
  {
    version: 182,
    up: (db) => {
      // Artifact references outlive a tab's event cache (Reset / closing a tab).
      // Store references only: prompt text and image bytes stay in their existing stores.
      db.exec(`
        CREATE TABLE chat_attachment_messages (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          attachments TEXT NOT NULL,
          PRIMARY KEY (task_id, message_id)
        );
      `)
      const rows = db
        .prepare(`SELECT t.task_id, e.event FROM chat_events e
        JOIN terminal_tabs t ON t.id = e.tab_id WHERE json_valid(e.event)
        AND json_extract(e.event, '$.kind') = 'user-message'
        ORDER BY COALESCE(json_extract(e.event, '$.history'), 0), e.seq`)
        .all() as { task_id: string; event: string }[]
      const insert = db.prepare(
        'INSERT OR IGNORE INTO chat_attachment_messages (task_id, message_id, attachments) VALUES (?, ?, ?)'
      )
      for (const row of rows) {
        const event = JSON.parse(row.event) as {
          id?: string
          content?: { type?: string; attachment?: unknown }[]
        }
        const attachments = Array.isArray(event.content)
          ? event.content
              .filter((b) => b?.type === 'attachment' && b.attachment)
              .map((b) => b.attachment)
          : []
        if (event.id && attachments.length)
          insert.run(row.task_id, event.id, JSON.stringify(attachments))
      }
    }
  },
  {
    version: 183,
    up: (db) => {
      db.exec(`
        CREATE TABLE chat_workspace_changes (
          id TEXT PRIMARY KEY,
          tab_id TEXT NOT NULL REFERENCES terminal_tabs(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          computer_id TEXT,
          root_path TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          files TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX chat_workspace_changes_tab ON chat_workspace_changes(tab_id, created_at);
        CREATE TABLE chat_workspace_diffs (
          capture_id TEXT NOT NULL REFERENCES chat_workspace_changes(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          diff TEXT NOT NULL,
          PRIMARY KEY (capture_id, path)
        );
      `)
    }
  },
  {
    version: 184,
    up: (db) =>
      db.exec(`CREATE TABLE computer_runtime_state (
      computer_id TEXT PRIMARY KEY REFERENCES computers(id) ON DELETE CASCADE,
      connector_generation INTEGER NOT NULL DEFAULT 0,
      upgrade_status_json TEXT,
      reported_at INTEGER
    );`)
  },
  {
    version: 185,
    up: (db) => {
      // Codex chat tasks follow the user's default permission mode (Settings →
      // Providers). A boot backfill (now removed) tagged every Codex chat entry
      // without a `chatMode` 'bypass' on EVERY start — not a mode the Codex picker
      // offers, so no user chose it, and it beat the default for any task that
      // never picked one. Those tags go; picked modes and other providers stay.
      const MODE = 'codex-chat'
      const update = db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
      const tasks = db
        .prepare(`SELECT id, provider_config FROM tasks WHERE provider_config LIKE '%codex-chat%'`)
        .all() as { id: string; provider_config: string }[]
      for (const task of tasks) {
        let cfg: Record<string, Record<string, unknown>>
        try {
          cfg = JSON.parse(task.provider_config)
        } catch {
          continue
        }
        const entry = cfg?.[MODE]
        if (!entry || typeof entry !== 'object' || entry.chatMode !== 'bypass') continue
        const { chatMode: _dropped, ...next } = entry
        update.run(JSON.stringify({ ...cfg, [MODE]: next }), task.id)
      }
    }
  },
  {
    version: 186,
    // Artifacts panel sidebar visibility + width, per task (JSON ArtifactsSidebarState)
    up: (db) => db.exec(`ALTER TABLE tasks ADD COLUMN artifacts_sidebar TEXT DEFAULT NULL`)
  },
  {
    version: 187,
    up: (db) => {
      // Metadata only. These rows must survive task/tab deletion so offline
      // computers can receive tombstones before accepting another command.
      db.exec(`
        CREATE TABLE chat_ownership (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tab_id TEXT NOT NULL,
          mode TEXT NOT NULL, computer_id TEXT, epoch INTEGER NOT NULL CHECK(epoch > 0),
          state TEXT NOT NULL CHECK(state IN ('legacy','active','copying','verified','deleted')),
          migration_id TEXT, destination_computer_id TEXT, source_computer_id TEXT,
          manifest_hash TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 0,
          settings_revision INTEGER NOT NULL DEFAULT 0, settings_hash TEXT
        );
        CREATE INDEX chat_ownership_task ON chat_ownership(task_id);
        CREATE INDEX chat_ownership_computer ON chat_ownership(computer_id,state);
        CREATE TABLE chat_tab_bindings (
          tab_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
          revision INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE chat_provider_bindings (
          provider_session_id TEXT NOT NULL, mode TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
          PRIMARY KEY(provider_session_id,mode)
        );
        CREATE TABLE chat_queue_routes (
          id TEXT PRIMARY KEY, tab_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id)
        );
        CREATE TABLE chat_artifact_locations (
          artifact_id TEXT PRIMARY KEY REFERENCES task_artifacts(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id)
        );
        CREATE TABLE chat_folder_locations (
          folder_id TEXT PRIMARY KEY REFERENCES artifact_folders(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id)
        );
        CREATE TABLE chat_task_lifecycle (
          task_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('active','paused','deleted')),
          revision INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE chat_task_computers (
          task_id TEXT NOT NULL, computer_id TEXT NOT NULL, PRIMARY KEY(task_id,computer_id)
        );
        CREATE TABLE chat_lifecycle_acks (
          task_id TEXT NOT NULL, computer_id TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY(task_id,computer_id)
        );
        CREATE TABLE chat_metadata_progress (
          conversation_id TEXT PRIMARY KEY REFERENCES chat_ownership(id),
          sequence INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE chat_deletion_targets (
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
          computer_id TEXT NOT NULL, epoch INTEGER NOT NULL,
          acknowledged INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(conversation_id,computer_id)
        );
      `)
      const exists = (table: string) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      for (const action of ['INSERT', 'UPDATE'])
        db.exec(`CREATE TRIGGER chat_ownership_targets_${action.toLowerCase()} AFTER ${action} ON chat_ownership BEGIN
        INSERT INTO chat_task_computers SELECT NEW.task_id,NEW.computer_id WHERE NEW.computer_id IS NOT NULL ON CONFLICT(task_id,computer_id) DO NOTHING;
        INSERT INTO chat_task_computers SELECT NEW.task_id,NEW.source_computer_id WHERE NEW.source_computer_id IS NOT NULL ON CONFLICT(task_id,computer_id) DO NOTHING;
        INSERT INTO chat_task_computers SELECT NEW.task_id,NEW.destination_computer_id WHERE NEW.destination_computer_id IS NOT NULL ON CONFLICT(task_id,computer_id) DO NOTHING;
      END;`)
      if (exists('tasks')) {
        db.exec(`INSERT INTO chat_task_lifecycle(task_id,state) SELECT id,CASE WHEN deleted_at IS NULL AND archived_at IS NULL THEN 'active' ELSE 'paused' END FROM tasks;
          CREATE TRIGGER chat_task_insert AFTER INSERT ON tasks BEGIN
            INSERT OR IGNORE INTO chat_task_lifecycle(task_id,state) VALUES(NEW.id,CASE WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL THEN 'active' ELSE 'paused' END);
          END;
          CREATE TRIGGER chat_task_soft_delete AFTER UPDATE OF deleted_at,archived_at ON tasks WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.archived_at IS NOT NEW.archived_at BEGIN
            INSERT INTO chat_task_lifecycle(task_id,state) VALUES(NEW.id,CASE WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL THEN 'active' ELSE 'paused' END)
            ON CONFLICT(task_id) DO UPDATE SET state=CASE WHEN state='deleted' THEN 'deleted' ELSE excluded.state END,revision=revision+1;
          END;
          CREATE TRIGGER chat_task_purge BEFORE DELETE ON tasks BEGIN
            INSERT INTO chat_task_lifecycle(task_id,state) VALUES(OLD.id,'deleted')
            ON CONFLICT(task_id) DO UPDATE SET state='deleted',revision=revision+CASE WHEN state='deleted' THEN 0 ELSE 1 END;
            UPDATE chat_ownership SET state='deleted',epoch=epoch+1,cleanup_pending=1 WHERE task_id=OLD.id AND state<>'deleted';
            INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
              SELECT o.id,c.computer_id,o.epoch FROM chat_ownership o JOIN chat_task_computers c ON c.task_id=o.task_id WHERE o.task_id=OLD.id
              ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END;
          END;
        `)
      }
      if (exists('terminal_tabs'))
        db.exec(`CREATE TRIGGER chat_tab_purge BEFORE DELETE ON terminal_tabs BEGIN
        UPDATE chat_ownership SET state='deleted',epoch=epoch+1,cleanup_pending=1 WHERE id IN(SELECT conversation_id FROM chat_tab_bindings WHERE tab_id=OLD.id) AND state<>'deleted';
        INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
        SELECT o.id,c.computer_id,o.epoch FROM chat_ownership o JOIN chat_task_computers c ON c.task_id=o.task_id WHERE o.tab_id=OLD.id AND o.state='deleted'
        ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END;
      END;`)
      // Fencing lives in SQLite too: an old in-flight handler or retention sweep
      // cannot mutate the source after its durable migration gate closes.
      for (const table of [
        'chat_events',
        'chat_queue',
        'chat_tab_state',
        'chat_timeline_pages',
        'chat_timeline_checkpoints',
        'chat_workspace_changes'
      ]) {
        if (!exists(table)) continue
        for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
          const row = action === 'DELETE' ? 'OLD' : 'NEW'
          const states =
            action === 'DELETE' ? "'copying','verified'" : "'copying','verified','active','deleted'"
          db.exec(`CREATE TRIGGER ${table}_ownership_${action.toLowerCase()} BEFORE ${action} ON ${table}
            WHEN EXISTS(SELECT 1 FROM chat_tab_bindings b JOIN chat_ownership o ON o.id=b.conversation_id WHERE b.tab_id=${row}.tab_id AND o.state IN (${states}))
            BEGIN SELECT RAISE(ABORT,'Chat history is computer-owned or migrating'); END;`)
        }
      }
      for (const table of ['agent_prompts', 'chat_attachment_messages']) {
        if (!exists(table)) continue
        for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
          const row = action === 'DELETE' ? 'OLD' : 'NEW'
          const states =
            action === 'DELETE' ? "'copying','verified'" : "'copying','verified','active','deleted'"
          db.exec(`CREATE TRIGGER ${table}_ownership_${action.toLowerCase()} BEFORE ${action} ON ${table}
            WHEN EXISTS(SELECT 1 FROM chat_ownership o WHERE o.task_id=${row}.task_id AND o.state IN (${states}))
            BEGIN SELECT RAISE(ABORT,'Chat history is computer-owned or migrating'); END;`)
        }
      }
      if (exists('agent_turns'))
        for (const action of ['INSERT', 'UPDATE']) {
          db.exec(`CREATE TRIGGER agent_turns_ownership_${action.toLowerCase()} BEFORE ${action} ON agent_turns
          WHEN NEW.prompt_preview<>'' AND EXISTS(SELECT 1 FROM chat_ownership o WHERE o.task_id=NEW.task_id AND o.state<>'legacy')
          BEGIN SELECT RAISE(ABORT,'Prompt previews are computer-owned'); END;`)
        }
    }
  },
  {
    version: 188,
    up(db) {
      db.exec(`CREATE TABLE chat_folder_deletions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,folder_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL
      );
      CREATE INDEX chat_folder_deletions_task ON chat_folder_deletions(task_id,sequence);
      CREATE TABLE chat_folder_deletion_acks (
        task_id TEXT NOT NULL,computer_id TEXT NOT NULL,sequence INTEGER NOT NULL,
        PRIMARY KEY(task_id,computer_id)
      );`)
    }
  },
  {
    version: 189,
    up(db) {
      db.exec(`CREATE TABLE chat_bootstrap_reservations (
        conversation_id TEXT PRIMARY KEY REFERENCES chat_ownership(id),
        computer_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0)
      );
      CREATE TABLE chat_folder_placeholders (
        folder_id TEXT PRIMARY KEY REFERENCES artifact_folders(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL
      );
      CREATE TABLE chat_provider_config_revisions (
        task_id TEXT NOT NULL,mode TEXT NOT NULL,revision INTEGER NOT NULL,config_hash TEXT,
        PRIMARY KEY(task_id,mode)
      );
      CREATE TABLE chat_unavailable_owners (
        conversation_id TEXT PRIMARY KEY REFERENCES chat_ownership(id),
        computer_id TEXT NOT NULL,epoch INTEGER NOT NULL,reason TEXT NOT NULL
      );`)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_turns'").get())
        db.exec(
          `CREATE INDEX chat_legacy_turn_previews_task ON agent_turns(task_id) WHERE prompt_preview<>'';
          CREATE TRIGGER agent_turns_ownership_delete BEFORE DELETE ON agent_turns
          WHEN OLD.prompt_preview<>'' AND EXISTS(SELECT 1 FROM chat_ownership o WHERE o.task_id=OLD.task_id AND o.state IN ('copying','verified'))
          BEGIN SELECT RAISE(ABORT,'Chat turn preview migration is pending'); END;`
        )
    }
  },
  {
    version: 190,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS artifact_blob_pins(
        scope TEXT NOT NULL,owner_id TEXT NOT NULL,token TEXT NOT NULL,reference_key TEXT NOT NULL,
        task_id TEXT NOT NULL,artifact_id TEXT NOT NULL,owner_epoch INTEGER NOT NULL,
        content_hash TEXT NOT NULL,size INTEGER NOT NULL,
        PRIMARY KEY(scope,owner_id,token,reference_key)
      );
      CREATE INDEX IF NOT EXISTS artifact_blob_pins_hash ON artifact_blob_pins(content_hash);
      CREATE TABLE IF NOT EXISTS artifact_blob_leases(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_blob_gc_pending(id INTEGER PRIMARY KEY CHECK(id=1));
      CREATE TABLE IF NOT EXISTS artifact_blob_gc_generation(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO artifact_blob_gc_generation VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS artifact_blob_gc_requested BEFORE INSERT ON artifact_blob_gc_pending
      BEGIN UPDATE artifact_blob_gc_generation SET version=version+1 WHERE id=1; END;
      CREATE TRIGGER chat_owner_blob_pins_deleted AFTER UPDATE OF state ON chat_ownership
      WHEN NEW.state='deleted' BEGIN
        INSERT OR IGNORE INTO artifact_blob_gc_pending SELECT 1 WHERE EXISTS(SELECT 1 FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND owner_id=NEW.id);
        DELETE FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND owner_id=NEW.id;
      END;
      CREATE TRIGGER chat_owner_blob_pins_removed AFTER DELETE ON chat_ownership BEGIN
        INSERT OR IGNORE INTO artifact_blob_gc_pending SELECT 1 WHERE EXISTS(SELECT 1 FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND owner_id=OLD.id);
        DELETE FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND owner_id=OLD.id;
      END;
      CREATE TRIGGER chat_task_blob_pins_deleted AFTER DELETE ON tasks BEGIN
        INSERT OR IGNORE INTO artifact_blob_gc_pending SELECT 1 WHERE EXISTS(SELECT 1 FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND task_id=OLD.id);
        DELETE FROM artifact_blob_pins WHERE scope='legacy-chat-migration' AND task_id=OLD.id;
      END;`)
    }
  },
  {
    version: 191,
    up(db) {
      db.exec(`CREATE TABLE chat_legacy_task_authority (
        task_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES chat_ownership(id)
      );
      CREATE TABLE chat_legacy_task_copies (
        conversation_id TEXT NOT NULL,migration_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,
        kind TEXT NOT NULL,source_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id,migration_id,kind,source_id)
      );
      CREATE TABLE chat_legacy_session_authority (
        task_id TEXT NOT NULL,mode TEXT NOT NULL,provider_session_id TEXT NOT NULL,
        conversation_id TEXT REFERENCES chat_ownership(id),
        PRIMARY KEY(task_id,mode,provider_session_id)
      );
      CREATE TABLE chat_provider_transitions (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
        task_id TEXT NOT NULL,tab_id TEXT NOT NULL,archive_tab_id TEXT NOT NULL UNIQUE,
        next_conversation_id TEXT NOT NULL UNIQUE,next_mode TEXT NOT NULL,computer_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','complete'))
      );
      CREATE UNIQUE INDEX chat_provider_transition_pending ON chat_provider_transitions(conversation_id) WHERE state='reserved';`)
    }
  },
  {
    version: 192,
    up(db) {
      // "Terminal mode" → "agent": the UI has said Agent for a long time, and
      // `agent_id` is already the code's word for this value (`agent_prompts.agent_id`,
      // the agent-hook envelope's `agentId`).
      //
      // 1. `terminal_modes` → `agents`. No view, trigger, index or foreign key names
      //    the table (checked against the v191 schema), so the rename is the whole job.
      // 2. `tasks.terminal_mode` + `task_templates.terminal_mode` → `agent_id` — the
      //    only two columns of that name. RENAME COLUMN also rewrites any trigger or
      //    view that names them (none today), and keeps the `'claude-code'` default.
      // 3. Setting `default_terminal_mode` → `default_agent_id`, in `settings` and —
      //    for a hub with login, where a row may have landed before the key was scoped
      //    hub-wide — `user_settings`. The old key's value wins: until now it was the
      //    only one any build read.
      //
      // No JSON blob in the DB stores the value under a `terminalMode`/`terminal_mode`
      // key (`provider_config` is keyed BY the agent id, not under that name).
      // Automation templates still saying `{{task.terminal_mode}}` keep resolving —
      // the automations engine keeps it as an alias, so their text is not rewritten.
      db.exec(`
        ALTER TABLE terminal_modes RENAME TO agents;
        ALTER TABLE tasks RENAME COLUMN terminal_mode TO agent_id;
        ALTER TABLE task_templates RENAME COLUMN terminal_mode TO agent_id;

        INSERT INTO settings (key, value)
          SELECT 'default_agent_id', value FROM settings WHERE key = 'default_terminal_mode'
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        DELETE FROM settings WHERE key = 'default_terminal_mode';

        INSERT INTO user_settings (user_id, key, value)
          SELECT user_id, 'default_agent_id', value FROM user_settings WHERE key = 'default_terminal_mode'
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value;
        DELETE FROM user_settings WHERE key = 'default_terminal_mode';
      `)
    }
  },
  {
    version: 193,
    // Session lookup by provider conversation id (legacy diagnostics attribution at
    // first boot after the computer-owned chat upgrade, `conversation_id = ?` reads).
    // Unindexed, each lookup walked every session: a large history blocked the hub
    // past the desktop's 10s health deadline.
    up: (db) => {
      // Guarded like v187/v189. The guard was added for chat-runtime fixtures that
      // replayed a migration slice on a skeleton DB; they now use the full schema.
      // Every real store has the table, so the guard is a no-op there; kept as shipped.
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get()
      )
        db.exec('CREATE INDEX agent_sessions_conversation ON agent_sessions(conversation_id)')
    }
  },
  {
    version: 194,
    // Disabling a computer (`computers.setDisabled`): it stays enrolled and connected,
    // and gets no new work. Distinct from `revoked_at`, which ends its credential.
    // NULL = enabled. Kept across re-enrollment: a computer an operator turned off
    // stays off until they turn it on.
    up: (db) => {
      db.exec('ALTER TABLE computers ADD COLUMN disabled_at INTEGER')
    }
  },
  {
    version: 195,
    up(db) {
      // Usage logs are parsed on each computer: a parse cursor belongs to (computer,
      // file) — two computers' `~/.claude/projects/x.jsonl` are different files.
      // Existing cursors were the hub's own parse ('' = this hub's disk). A schema
      // built from a later baseline may lack the old table: then there is nothing to keep.
      const hadOld = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_parse_state'")
        .get()
      db.exec(`CREATE TABLE usage_parse_state_by_computer (
        computer_id TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        last_offset INTEGER NOT NULL DEFAULT 0,
        last_modified_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (computer_id, file_path)
      );`)
      if (hadOld) {
        db.exec(`INSERT INTO usage_parse_state_by_computer (computer_id, file_path, last_offset, last_modified_ms)
          SELECT '', file_path, last_offset, last_modified_ms FROM usage_parse_state;
        DROP TABLE usage_parse_state;`)
      }
      db.exec(`ALTER TABLE usage_parse_state_by_computer RENAME TO usage_parse_state;`)
    }
  },
  {
    version: 196,
    up(db) {
      // Which computer a legacy (hub-era) chat tab's agent ran on — where its provider
      // session lives, so the migration copies it from there. It was read from the
      // legacy `chat_workspace_changes` (nothing writes it any more); kept here, so the
      // legacy tables are no longer read and can be dropped.
      db.exec(`CREATE TABLE chat_legacy_tab_computers (
        tab_id TEXT PRIMARY KEY,
        computer_id TEXT NOT NULL
      );`)
      const hasLegacy = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_workspace_changes'")
        .get()
      if (!hasLegacy) return
      db.exec(`INSERT INTO chat_legacy_tab_computers (tab_id, computer_id)
        SELECT w.tab_id, w.computer_id FROM chat_workspace_changes w
        WHERE w.computer_id IS NOT NULL AND w.id = (
          SELECT w2.id FROM chat_workspace_changes w2
          WHERE w2.tab_id = w.tab_id AND w2.computer_id IS NOT NULL
          ORDER BY w2.created_at DESC, w2.id DESC LIMIT 1
        );`)
    }
  },
  {
    version: 197,
    up(db) {
      // The computer a task's worktree was made on — where it is removed (Trash purge,
      // archive). Without it the removal went to the task's CURRENT computer, which for
      // an unbound task is whichever computer is the default now: on a hub with several
      // computers that may not be the one holding the worktree. NULL = not recorded
      // (worktrees made before this, linked by hand): the task's computer, as before.
      // Kept when that computer is deleted, so the purge sees it is gone.
      db.exec('ALTER TABLE tasks ADD COLUMN worktree_computer_id TEXT DEFAULT NULL')
    }
  },
  {
    version: 198,
    up(db) {
      db.exec(CONTENT_ERASURE_SCHEMA)
      db.exec(CONTENT_ERASURE_ARTIFACT_FENCES)
      // Sealed legacy chat copies are independent consumers of immutable bytes.
      // Their pins must outlive deletion/pruning of the original artifact and be
      // respected by every GC path, not only the new erasure operation.
      for (const spec of [
        {
          table: 'chat_attachment_messages',
          owner: 'task_id',
          token: 'message_id',
          document: 'attachments',
          scope: 'legacy-chat-reference',
          task: (row: string) => `${row}.task_id`
        },
        {
          table: 'chat_events',
          owner: 'tab_id',
          token: 'seq',
          document: 'event',
          scope: 'legacy-chat-event',
          task: (row: string) => `(SELECT task_id FROM terminal_tabs WHERE id=${row}.tab_id)`
        }
      ]) {
        const source = (row: string, from = '') =>
          `SELECT ${row}.${spec.owner} AS owner,CAST(${row}.${spec.token} AS TEXT) AS token,${row}.${spec.document} AS document,${spec.task(row)} AS task_id ${from}`
        const pin = (
          select: string
        ) => `INSERT OR IGNORE INTO artifact_blob_pins(scope,owner_id,token,reference_key,task_id,artifact_id,owner_epoch,content_hash,size)
          SELECT '${spec.scope}',r.owner,r.token,j.fullkey,r.task_id,
            COALESCE(json_extract(r.document,substr(j.fullkey,1,length(j.fullkey)-12)||'.artifactId'),'__sealed__'),
            1,j.atom,COALESCE(json_extract(r.document,substr(j.fullkey,1,length(j.fullkey)-12)||'.size'),(SELECT size FROM artifact_blobs WHERE hash=j.atom),0)
          FROM (${select}) r,json_tree(CASE WHEN json_valid(r.document) THEN r.document ELSE '{}' END) j
          WHERE r.task_id IS NOT NULL AND j.key='contentHash' AND j.type='text'
            AND length(j.atom)=64 AND j.atom NOT GLOB '*[^a-f0-9]*';`
        const release = `DELETE FROM artifact_blob_pins WHERE scope='${spec.scope}' AND owner_id=OLD.${spec.owner} AND token=CAST(OLD.${spec.token} AS TEXT);`
        db.exec(`CREATE TRIGGER ${spec.table}_sealed_pins_insert AFTER INSERT ON ${spec.table} BEGIN ${pin(source('NEW'))} END;
          CREATE TRIGGER ${spec.table}_sealed_pins_update AFTER UPDATE ON ${spec.table} BEGIN ${release} ${pin(source('NEW'))} END;
          CREATE TRIGGER ${spec.table}_sealed_pins_delete AFTER DELETE ON ${spec.table} BEGIN ${release} END;`)
        db.exec(pin(source('s', `FROM ${spec.table} s`)))
      }
      db.exec(`
        CREATE TRIGGER erased_task_cannot_return BEFORE INSERT ON tasks
          WHEN EXISTS(SELECT 1 FROM content_erasure_tasks WHERE task_id=NEW.id)
          BEGIN SELECT RAISE(ABORT,'Task was permanently erased'); END;
        CREATE TRIGGER erasing_task_has_no_new_artifacts BEFORE INSERT ON task_artifacts
          WHEN EXISTS(SELECT 1 FROM content_erasure_tasks t JOIN content_erasure_jobs j ON j.id=t.job_id WHERE t.task_id=NEW.task_id AND j.db_erased=0)
          BEGIN SELECT RAISE(ABORT,'Task is being permanently erased'); END;
        CREATE TRIGGER erasing_task_has_no_updated_artifacts BEFORE UPDATE ON task_artifacts
          WHEN EXISTS(SELECT 1 FROM content_erasure_tasks t JOIN content_erasure_jobs j ON j.id=t.job_id WHERE t.task_id=NEW.task_id AND j.db_erased=0)
          BEGIN SELECT RAISE(ABORT,'Task is being permanently erased'); END;
      `)
      // Preserve existing recoverable items when Trash is removed. Updating both
      // columns together keeps computer lifecycle paused, never active.
      db.exec(`UPDATE tasks SET archived_at=COALESCE(archived_at,deleted_at),deleted_at=NULL
        WHERE deleted_at IS NOT NULL`)
      // A late agent hook/editor save must not recreate erased content. Delivery
      // metadata is exempt: offline computers still need their deletion fences.
      const delivery = new Set([
        'chat_task_lifecycle',
        'chat_task_computers',
        'chat_lifecycle_acks',
        'chat_ownership',
        'chat_deletion_targets',
        'chat_tab_bindings',
        'chat_provider_bindings',
        'chat_metadata_progress',
        'chat_bootstrap_reservations',
        'chat_unavailable_owners',
        'chat_folder_deletions',
        'chat_folder_deletion_acks'
      ])
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      for (const { name } of tables) {
        if (name.startsWith('content_erasure_') || delivery.has(name) || name === 'tasks') continue
        const quoted = '"' + name.replaceAll('"', '""') + '"'
        const columns = new Set(
          (db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>).map(
            (c) => c.name
          )
        )
        for (const action of ['INSERT', 'UPDATE']) {
          if (name === 'task_artifacts' && action === 'UPDATE') continue
          const conditions: string[] = []
          if (columns.has('task_id'))
            conditions.push('EXISTS(SELECT 1 FROM content_erasure_tasks WHERE task_id=NEW.task_id)')
          if (columns.has('tab_id'))
            conditions.push('EXISTS(SELECT 1 FROM content_erasure_tabs WHERE tab_id=NEW.tab_id)')
          if (!conditions.length) continue
          const trigger =
            '"content_erasure_' + name.replaceAll('"', '""') + '_' + action.toLowerCase() + '"'
          db.exec(`CREATE TRIGGER ${trigger} BEFORE ${action} ON ${quoted} WHEN ${conditions.join(' OR ')}
            BEGIN SELECT RAISE(ABORT,'Content was permanently erased'); END;`)
        }
      }
    }
  },
  {
    version: 199,
    up(db) {
      // v198 fenced artifact_blob_pins like content. Backup pins are retention
      // metadata for bytes a retained backup still holds (erasure keeps them until
      // that backup is gone), so the hub's startup re-pin of every backup taken
      // before an erasure aborted: GC stayed deferred and every later deletion
      // stayed incomplete. Reinstall all fences from the one shared definition,
      // which keeps 'hub-backup' pins writable. Future migrations that create or
      // rebuild a task_id/tab_id table call it too (see content-erasure-fences.ts).
      installContentErasureFences(db)
    }
  },
  {
    version: 200,
    up(db) {
      const exists = (table: string) =>
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      // 1. A computer id that is gone for good: re-enrolled under `successor_id`,
      //    or deleted / missing (no successor). Written in the same transaction
      //    as the computer change; the chat domain repoints or retires the work
      //    that still names it (applyComputerRetirements), idempotently.
      //    Revoked computers are NOT retired: their work waits for them.
      db.exec(`CREATE TABLE computer_retirements (
        computer_id TEXT PRIMARY KEY, successor_id TEXT,
        reason TEXT NOT NULL CHECK(reason IN ('re-enrolled','deleted','missing')),
        retired_at INTEGER NOT NULL
      );
      CREATE TABLE chat_retired_work (
        kind TEXT NOT NULL, item_id TEXT NOT NULL, computer_id TEXT NOT NULL,
        reason TEXT NOT NULL, retired_at INTEGER NOT NULL,
        PRIMARY KEY(kind,item_id,computer_id)
      );`)
      // 2. Pending = an unacknowledged deletion target exists. Enforced here, so
      //    every writer (triggers, deleteForTask, acks, retirements) conforms: a
      //    deleted chat with nothing left to deliver never blocks its task.
      const pending = (id: string) =>
        `EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=${id} AND d.acknowledged=0)`
      db.exec(`CREATE TRIGGER chat_deleted_pending_sync AFTER UPDATE OF state,cleanup_pending ON chat_ownership
        WHEN NEW.state='deleted' AND NEW.cleanup_pending<>${pending('NEW.id')}
        BEGIN UPDATE chat_ownership SET cleanup_pending=${pending('NEW.id')} WHERE id=NEW.id; END;
      CREATE TRIGGER chat_deleted_pending_insert AFTER INSERT ON chat_ownership
        WHEN NEW.state='deleted' AND NEW.cleanup_pending<>${pending('NEW.id')}
        BEGIN UPDATE chat_ownership SET cleanup_pending=${pending('NEW.id')} WHERE id=NEW.id; END;`)
      for (const [action, row] of [
        ['INSERT', 'NEW'],
        ['UPDATE', 'NEW'],
        ['DELETE', 'OLD']
      ])
        db.exec(`CREATE TRIGGER chat_deletion_targets_pending_${action.toLowerCase()} AFTER ${action} ON chat_deletion_targets BEGIN
          UPDATE chat_ownership SET cleanup_pending=${pending('chat_ownership.id')}
          WHERE id=${row}.conversation_id AND state='deleted' AND cleanup_pending<>${pending('chat_ownership.id')};
        END;`)
      // Purges target every computer of the task AND the conversation's own
      // computers (a chat whose task was never tracked still reaches its holder);
      // the tab purge targets exactly the conversations it deletes (by binding).
      // A retired computer (re-enrolled or removed) never becomes a new target:
      // nothing could ever be delivered to its id.
      const live = (column: string) =>
        `${column} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM computer_retirements r WHERE r.computer_id=${column})`
      for (const action of ['INSERT', 'UPDATE'])
        db.exec(`DROP TRIGGER IF EXISTS chat_ownership_targets_${action.toLowerCase()};
          CREATE TRIGGER chat_ownership_targets_${action.toLowerCase()} AFTER ${action} ON chat_ownership BEGIN
          ${['computer_id', 'source_computer_id', 'destination_computer_id']
            .map(
              (c) =>
                `INSERT INTO chat_task_computers SELECT NEW.task_id,NEW.${c} WHERE ${live(`NEW.${c}`)} ON CONFLICT(task_id,computer_id) DO NOTHING;`
            )
            .join('\n')}
        END;`)
      const target = (
        where: string
      ) => `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
        SELECT o.id,c.computer_id,o.epoch FROM chat_ownership o JOIN chat_task_computers c ON c.task_id=o.task_id WHERE ${where} AND ${live('c.computer_id')}
        UNION SELECT o.id,o.computer_id,o.epoch FROM chat_ownership o WHERE ${where} AND ${live('o.computer_id')}
        UNION SELECT o.id,o.source_computer_id,o.epoch FROM chat_ownership o WHERE ${where} AND ${live('o.source_computer_id')}
        UNION SELECT o.id,o.destination_computer_id,o.epoch FROM chat_ownership o WHERE ${where} AND ${live('o.destination_computer_id')}
        ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END;`
      if (exists('tasks'))
        db.exec(`DROP TRIGGER IF EXISTS chat_task_purge;
          CREATE TRIGGER chat_task_purge BEFORE DELETE ON tasks BEGIN
            INSERT INTO chat_task_lifecycle(task_id,state) VALUES(OLD.id,'deleted')
            ON CONFLICT(task_id) DO UPDATE SET state='deleted',revision=revision+CASE WHEN state='deleted' THEN 0 ELSE 1 END;
            UPDATE chat_ownership SET state='deleted',epoch=epoch+1 WHERE task_id=OLD.id AND state<>'deleted';
            ${target("o.task_id=OLD.id AND o.state='deleted'")}
          END;`)
      if (exists('terminal_tabs'))
        db.exec(`DROP TRIGGER IF EXISTS chat_tab_purge;
          CREATE TRIGGER chat_tab_purge BEFORE DELETE ON terminal_tabs BEGIN
            UPDATE chat_ownership SET state='deleted',epoch=epoch+1 WHERE id IN(SELECT conversation_id FROM chat_tab_bindings WHERE tab_id=OLD.id) AND state<>'deleted';
            ${target("o.id IN(SELECT conversation_id FROM chat_tab_bindings WHERE tab_id=OLD.id) AND o.state='deleted'")}
          END;`)
      // One-time repair: deleted chats marked pending with nothing to deliver.
      db.exec(`UPDATE chat_ownership SET cleanup_pending=${pending('chat_ownership.id')}
        WHERE state='deleted' AND cleanup_pending<>${pending('chat_ownership.id')}`)
      // 3. A reserved provider transition that ownership moved past is
      //    'superseded' (logged, never shown): the tab can switch again.
      db.exec(`CREATE TABLE chat_provider_transitions_v200 (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
        task_id TEXT NOT NULL,tab_id TEXT NOT NULL,archive_tab_id TEXT NOT NULL UNIQUE,
        next_conversation_id TEXT NOT NULL UNIQUE,next_mode TEXT NOT NULL,computer_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','complete','superseded'))
      );
      INSERT INTO chat_provider_transitions_v200 SELECT * FROM chat_provider_transitions;
      DROP TABLE chat_provider_transitions;
      ALTER TABLE chat_provider_transitions_v200 RENAME TO chat_provider_transitions;
      CREATE UNIQUE INDEX chat_provider_transition_pending ON chat_provider_transitions(conversation_id) WHERE state='reserved';`)
      // 4. Which conversations a placeholder folder waits on: those holding
      //    entries inside it. Once each was re-read without the folder's own
      //    record (or is gone), the placeholder resolves to a normal folder.
      //    One no chat holds anything in awaits nothing: resolved now.
      db.exec(`CREATE TABLE chat_folder_placeholder_waits (
        folder_id TEXT NOT NULL REFERENCES artifact_folders(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        PRIMARY KEY(folder_id,conversation_id)
      );
      INSERT OR IGNORE INTO chat_folder_placeholder_waits
        SELECT p.folder_id,l.conversation_id FROM chat_folder_placeholders p
          JOIN task_artifacts a ON a.folder_id=p.folder_id JOIN chat_artifact_locations l ON l.artifact_id=a.id
        UNION SELECT p.folder_id,l.conversation_id FROM chat_folder_placeholders p
          JOIN artifact_folders f ON f.parent_id=p.folder_id JOIN chat_folder_locations l ON l.folder_id=f.id;
      DELETE FROM chat_folder_placeholders WHERE NOT EXISTS(
        SELECT 1 FROM chat_folder_placeholder_waits w WHERE w.folder_id=chat_folder_placeholders.folder_id);`)
      // 5. Backfill retirements for computer ids live chat bookkeeping still
      //    names but that no longer exist. Only a computer that connected writes
      //    these tables, and a connected computer has a row; tasks, projects and
      //    placements are rewritten whenever a computer is retired or deleted
      //    (tasks.worktree_computer_id deliberately keeps a deleted id: not checked).
      //    So an id with neither a row nor any such reference was removed (or
      //    restored away). The local computer before it enrolls has no chat
      //    references, so it never matches. chat_legacy_tab_computers is a
      //    migration-source hint copied from legacy data: not proof of a connection.
      db.exec(`INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at)
        SELECT r.id,NULL,'missing',CAST(strftime('%s','now') AS INTEGER)*1000 FROM (
          SELECT computer_id AS id FROM chat_ownership UNION SELECT source_computer_id FROM chat_ownership
          UNION SELECT destination_computer_id FROM chat_ownership UNION SELECT computer_id FROM chat_task_computers
          UNION SELECT computer_id FROM chat_lifecycle_acks UNION SELECT computer_id FROM chat_deletion_targets
          UNION SELECT computer_id FROM chat_bootstrap_reservations UNION SELECT computer_id FROM chat_unavailable_owners
          UNION SELECT computer_id FROM chat_provider_transitions UNION SELECT computer_id FROM chat_folder_deletion_acks
        ) r WHERE r.id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM computers c WHERE c.id=r.id)
          AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.computer_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.default_computer_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM project_placements pp WHERE pp.computer_id=r.id)`)
      // The provider-transition rebuild dropped its erasure fences.
      installContentErasureFences(db)
    }
  },
  {
    version: 201,
    up(db) {
      // Terminal agent sessions are scoped per TAB: (task, mode, tab). Until now the
      // ledger was keyed (task, mode), so a second agent tab of the same mode resolved
      // the main tab's session, and a reset for the main tab (e.g. switching the main
      // agent's mode) cut off every tab of the task — the lost "deploy" tab session.
      //
      // The main tab's id IS the task id (terminal_tabs v19), so every pre-existing
      // row is backfilled to the main tab = exactly today's behaviour. A reset row
      // with `tab_id IS NULL` is a WHOLE-TASK reset (worktree/project change,
      // `reset-conversation --all-tabs`); none exist before this migration.
      //
      // Rows of erased content are skipped: their erasure fence aborts any UPDATE,
      // and nothing can resume them.
      db.exec(`
        ALTER TABLE session_resets ADD COLUMN tab_id TEXT;
        ALTER TABLE task_conversations ADD COLUMN tab_id TEXT;

        UPDATE session_resets SET tab_id = task_id
         WHERE NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = session_resets.task_id);
        UPDATE task_conversations SET tab_id = task_id
         WHERE NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = task_conversations.task_id);
        UPDATE agent_sessions SET tab_id = task_id
         WHERE task_id IS NOT NULL AND tab_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = agent_sessions.task_id);

        DROP INDEX IF EXISTS session_resets_lookup;
        CREATE INDEX session_resets_lookup
          ON session_resets (task_id, mode, tab_id, created_at DESC);
        CREATE INDEX agent_sessions_task_tab
          ON agent_sessions (task_id, mode, tab_id, created_at DESC);

        -- One-time work list for the hub's session-tab recovery
        -- (apps/hub/src/session-tab-recovery.ts): every backfilled conversation of a
        -- task that has a NON-main tab of the same mode — the only conversations whose
        -- real tab can differ from the main tab. The recovery re-attributes them from
        -- diagnostics evidence and deletes each row once tried. \`backfilled_at\` is
        -- the moment of this migration: resets before it were applied task-wide.
        CREATE TABLE session_tab_recovery (
          task_id         TEXT NOT NULL,
          mode            TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          backfilled_at   INTEGER NOT NULL,
          PRIMARY KEY (task_id, mode, conversation_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
      `)
      db.prepare(
        `INSERT OR IGNORE INTO session_tab_recovery (task_id, mode, conversation_id, backfilled_at)
         SELECT DISTINCT s.task_id, s.mode, s.conversation_id, ?
           FROM agent_sessions s
          WHERE s.task_id IS NOT NULL AND s.conversation_id IS NOT NULL
            AND s.task_id IN (SELECT id FROM tasks)
            AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = s.task_id)
            AND EXISTS (SELECT 1 FROM terminal_tabs t
                         WHERE t.task_id = s.task_id AND t.is_main = 0 AND t.mode = s.mode)`
      ).run(Date.now())
      // New tab_id columns (session_resets, task_conversations) and the work table.
      installContentErasureFences(db)
    }
  },
  {
    version: 202,
    up(db) {
      // Chat metadata stamps are never trusted as proof (the computer is the
      // authority). A receipt names an update the hub applied (`acked`=1 once the
      // computer confirmed it; the newest acked ones are kept so a late duplicate
      // delivery is still recognized). An update at an already-consumed position
      // WITHOUT a receipt means the computer's counter went back (restored from
      // a backup) → the hub re-reads the conversation in full instead of
      // acking and dropping it. `store_id`: the computer chat database the
      // cursor counts in; another store means its counters are not comparable.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_metadata_receipts (
          conversation_id TEXT NOT NULL REFERENCES chat_ownership(id),
          operation_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          acked INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (conversation_id, operation_id)
        );
        ALTER TABLE chat_metadata_progress ADD COLUMN store_id TEXT;
        ALTER TABLE chat_artifact_locations ADD COLUMN unavailable_reason TEXT;
        ALTER TABLE chat_artifact_locations ADD COLUMN unavailable_since INTEGER;
        ALTER TABLE chat_folder_locations ADD COLUMN unavailable_reason TEXT;
        ALTER TABLE chat_folder_locations ADD COLUMN unavailable_since INTEGER;
      `)
      // A computer restored from an older backup no longer lists files the hub
      // knows: their rows stay, marked `unavailable_reason`, instead of being
      // deleted (they may still be wanted, and the hub cannot tell).
    }
  },
  {
    version: 203,
    up(db) {
      // Per-item fault ledger: a pass (cleanup, erasure fan-out, backup pins, project
      // sync, session refresh, …) records the ONE item it could not process instead of
      // aborting for every other item. Transient faults retry with backoff; structural
      // ones stay quarantined until the item's fingerprint changes. Rows with
      // origin='computer' are the latest snapshot a computer reported of its own
      // ledger (replaced wholesale, never merged). Frozen copy of ITEM_FAULTS_DDL
      // (@slayzone/platform isolation.ts); v203's test asserts they match.
      db.exec(`CREATE TABLE IF NOT EXISTS item_faults (
  origin TEXT NOT NULL CHECK (origin IN ('hub','computer')),
  computer_id TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL,
  item_key TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('transient','structural')),
  fingerprint TEXT,
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  next_retry_at INTEGER,
  PRIMARY KEY (origin, computer_id, pass, item_key)
);
        CREATE INDEX IF NOT EXISTS idx_item_faults_task ON item_faults(task_id) WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_item_faults_computer ON item_faults(computer_id);`)
      // task_id column: fenced like every task table, so a late fault cannot outlive erasure.
      installContentErasureFences(db)
    }
  },
  {
    version: 204,
    up(db) {
      // Computer-only data moves off the hub (robustness plan §9, P0). A row here is
      // one item the hub still holds that belongs to the computer owning its task
      // (`kind`: what it is, e.g. a session record; `payload`: its JSON). The hub
      // delivers a task's rows to that computer (`data.import`) when it connects and
      // before an agent or chat of the task starts there, and deletes each row once
      // the computer confirmed it. Nothing reads these rows otherwise: the computer
      // is the only copy from then on. Fenced like every task table.
      db.exec(`CREATE TABLE IF NOT EXISTS computer_data_handoff (
        kind TEXT NOT NULL,
        item_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, item_key)
      );
      CREATE INDEX IF NOT EXISTS idx_computer_data_handoff_task ON computer_data_handoff(task_id);`)
      installContentErasureFences(db)
    }
  },
  {
    version: 205,
    up(db) {
      // Chat settings (permission mode, model, effort, collaboration, fast) and the
      // chat session id live only on the chat's computer (robustness plan §9,
      // decision 2): the hub keeps no copy, so there is no revision to reconcile.
      // A task's chat keys go for every mode whose chat a computer owns (it holds
      // them already). A chat not on a computer yet (legacy, or mid-migration)
      // keeps them: they are the starting values its computer is seeded with, and
      // the hub removes them once that computer has its own (hub-relay). Hub-owned
      // keys (spawn `flags`, terminal session ids) stay.
      db.exec('DROP TABLE IF EXISTS chat_provider_config_revisions')
      const keys = [
        'chatMode',
        'chatModel',
        'chatEffort',
        'chatCollaboration',
        'chatFastMode',
        'chatConversationId'
      ]
      const owned = db
        .prepare(
          `SELECT DISTINCT o.task_id AS taskId,o.mode FROM chat_ownership o JOIN tasks t ON t.id=o.task_id
           WHERE o.state='active' AND json_valid(t.provider_config)
             AND json_type(t.provider_config,'$.'||json_quote(o.mode))='object'`
        )
        .all() as Array<{ taskId: string; mode: string }>
      const strip = db.prepare(
        `UPDATE tasks SET provider_config=json_remove(provider_config,${keys.map(() => '?').join(',')}) WHERE id=?`
      )
      // The computer may not hold them all (seen on a production copy: an active
      // chat whose computer had no configuration — its auto-accept mode was lost).
      // The settings are staged for the task's computer first (computer_data_handoff,
      // v204), which fills only what it lacks: its own values are newer. The session
      // id is not: the session ledger is the computer's.
      const settingKeys = keys.filter((key) => key !== 'chatConversationId')
      const read = db.prepare(
        `SELECT ${settingKeys.map((key) => `json_extract(provider_config,?) AS ${key}`).join(',')}
           FROM tasks WHERE id=? AND NOT EXISTS
             (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = tasks.id)`
      )
      const stage = db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         VALUES ('chat-settings', ?, ?, ?, ?)`
      )
      const now = Date.now()
      for (const { taskId, mode } of owned) {
        const row = read.get(
          ...settingKeys.map((key) => `$.${JSON.stringify(mode)}.${key}`),
          taskId
        ) as Record<string, unknown> | undefined
        const settings = Object.fromEntries(
          Object.entries(row ?? {}).filter(([, value]) => value !== null && value !== undefined)
        )
        // json_extract answers a JSON boolean as 0/1: keep the setting's type.
        if (typeof settings.chatFastMode === 'number')
          settings.chatFastMode = settings.chatFastMode === 1
        if (Object.keys(settings).length)
          stage.run(`${taskId}:${mode}`, taskId, JSON.stringify({ mode, settings }), now)
        strip.run(...keys.map((key) => `$.${JSON.stringify(mode)}.${key}`), taskId)
      }
    }
  },
  {
    version: 206,
    up(db) {
      // The agent-session ledger lives only on the computer running a task's agents
      // (robustness plan §9, P0): which conversations its agents ran, per (task,
      // mode, tab), and which one each tab resumes. The hub keeps the user's intent
      // about sessions — resets and deletions — and delivers it to every computer of
      // the task (`session_intent_acks`: what each confirmed).
      //
      // Existing ledger rows are staged in `computer_data_handoff` (v204) for the
      // task's computer, then the hub copies go: `agent_sessions` (warm-pool rows
      // without a task are dead after any restart and are dropped),
      // `task_conversations`, `session_turns` (staged per task that names the
      // conversation), the task row's `provider_config.<mode>.conversationId` /
      // `conversationHistory` and the legacy `*_conversation_id` columns (staged as
      // the task's pre-ledger history, which the heal path still reads). Erased
      // tasks' rows are not staged (their fences refuse it; nothing could use them).
      db.exec(`ALTER TABLE session_resets ADD COLUMN except_chat INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE session_intent_acks (
          intent_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          computer_id TEXT NOT NULL,
          PRIMARY KEY (intent_id, computer_id)
        );
        CREATE INDEX idx_session_intent_acks_task ON session_intent_acks(task_id);`)
      const live = (alias: string) =>
        `${alias}.task_id IN (SELECT id FROM tasks)
         AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = ${alias}.task_id)`
      const now = Date.now()
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'agent-session', s.id, s.task_id, json_object(
           'id', s.id, 'mode', s.mode, 'cwd', s.cwd, 'taskId', s.task_id, 'tabId', s.tab_id,
           'conversationId', s.conversation_id, 'origin', s.origin, 'status', s.status,
           'pendingMeta', s.pending_meta, 'createdAt', s.created_at, 'boundAt', s.bound_at,
           'endedAt', s.ended_at), ?
         FROM agent_sessions s WHERE s.task_id IS NOT NULL AND ${live('s')}`
      ).run(now)
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'task-conversation', c.id, c.task_id, json_object(
           'id', c.id, 'taskId', c.task_id, 'mode', c.mode, 'tabId', c.tab_id,
           'conversationId', c.conversation_id, 'origin', c.origin,
           'pendingMeta', c.pending_meta, 'createdAt', c.created_at), ?
         FROM task_conversations c WHERE ${live('c')}`
      ).run(now)
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'session-turn', x.task_id || ':' || t.conversation_id, x.task_id,
           json_object('conversationId', t.conversation_id, 'firstTurnAt', t.first_turn_at), ?
         FROM session_turns t JOIN (
           SELECT task_id, conversation_id FROM agent_sessions WHERE task_id IS NOT NULL
           UNION SELECT task_id, conversation_id FROM task_conversations
         ) x ON x.conversation_id = t.conversation_id
         WHERE ${live('x')}`
      ).run(now)
      // The pre-ledger history per (task, mode): conversationHistory, the current
      // conversationId and the legacy column.
      const legacyCol: Record<string, string> = {
        'claude-code': 'claude_conversation_id',
        codex: 'codex_conversation_id',
        'cursor-agent': 'cursor_conversation_id',
        gemini: 'gemini_conversation_id',
        opencode: 'opencode_conversation_id'
      }
      const tasks = db
        .prepare(
          `SELECT t.id, t.provider_config, t.claude_conversation_id, t.codex_conversation_id,
             t.cursor_conversation_id, t.gemini_conversation_id, t.opencode_conversation_id
           FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = t.id)`
        )
        .all() as Array<Record<string, string | null> & { id: string }>
      const stage = db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         VALUES ('legacy-conversation-history', ?, ?, ?, ?)`
      )
      for (const t of tasks) {
        let config: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(t.provider_config ?? '{}') as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            config = parsed as Record<string, unknown>
        } catch {
          /* unreadable: no history */
        }
        const byMode = new Map<string, string[]>()
        const add = (mode: string, id: unknown) => {
          if (typeof id !== 'string' || !id) return
          const list = byMode.get(mode) ?? []
          if (!list.includes(id)) list.push(id)
          byMode.set(mode, list)
        }
        for (const [mode, entry] of Object.entries(config)) {
          if (!entry || typeof entry !== 'object') continue
          const e = entry as { conversationHistory?: unknown; conversationId?: unknown }
          if (Array.isArray(e.conversationHistory))
            for (const id of e.conversationHistory) add(mode, id)
          add(mode, e.conversationId)
        }
        for (const [mode, col] of Object.entries(legacyCol)) add(mode, t[col])
        for (const [mode, ids] of byMode)
          stage.run(
            `${t.id}:${mode}`,
            t.id,
            JSON.stringify({ mode, ids: ids.slice(0, 10_000) }),
            now
          )
      }
      // The hub copies go.
      const strip = db.prepare(
        `UPDATE tasks SET provider_config = (
           SELECT json_group_object(m.key, CASE WHEN json_type(m.value) = 'object'
             THEN json(json_remove(m.value, '$.conversationId', '$.conversationHistory'))
             ELSE json(m.value) END)
           FROM json_each(tasks.provider_config) m)
         WHERE json_valid(provider_config) AND json_type(provider_config) = 'object'
           AND EXISTS (SELECT 1 FROM json_each(tasks.provider_config) m
             WHERE json_type(m.value) = 'object'
               AND (json_type(m.value, '$.conversationId') IS NOT NULL
                 OR json_type(m.value, '$.conversationHistory') IS NOT NULL))
           AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = tasks.id)`
      )
      strip.run()
      db.exec(`DROP TABLE agent_sessions;
        DROP TABLE task_conversations;
        DROP TABLE session_turns;
        ALTER TABLE tasks DROP COLUMN claude_conversation_id;
        ALTER TABLE tasks DROP COLUMN codex_conversation_id;
        ALTER TABLE tasks DROP COLUMN cursor_conversation_id;
        ALTER TABLE tasks DROP COLUMN gemini_conversation_id;
        ALTER TABLE tasks DROP COLUMN opencode_conversation_id;`)
      // New task_id table (session_intent_acks).
      installContentErasureFences(db)
    }
  },
  {
    version: 207,
    up(db) {
      // A task's prompt history (`agent_prompts`) and turn snapshots (`agent_turns`)
      // live only on the computer running its agents (robustness plan §9, P0): the
      // computer captures prompts, snapshots turns and keeps both; the hub keeps the
      // task's "last interaction" and nothing else.
      //
      // Existing rows are staged in `computer_data_handoff` (v204) for the task's
      // computer, then both hub tables go (with their v187/v189 fences). A turn whose
      // task the hub deleted (`task_id` NULL) still belongs to its checkout's history:
      // it is staged under the live task that last recorded in the same checkout,
      // else it goes (no computer could be told). Erased tasks' rows are not staged.
      const live = (column: string) =>
        `${column} IN (SELECT id FROM tasks)
         AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = ${column})`
      const now = Date.now()
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'agent-prompt', p.id, p.task_id, json_object(
           'id', p.id, 'agentId', p.agent_id, 'cliSessionId', p.cli_session_id,
           'text', p.text, 'createdAt', p.created_at), ?
         FROM agent_prompts p WHERE ${live('p.task_id')}`
      ).run(now)
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'agent-turn', a.id, COALESCE(a.task_id, (
             SELECT o.task_id FROM agent_turns o
              WHERE o.worktree_path = a.worktree_path AND o.task_id IS NOT NULL AND ${live('o.task_id')}
              ORDER BY o.created_at DESC LIMIT 1)),
           json_object(
             'id', a.id, 'worktreePath', a.worktree_path, 'taskId', a.task_id,
             'tabId', a.terminal_tab_id, 'snapshotSha', a.snapshot_sha,
             'headShaAtSnap', a.head_sha_at_snap, 'promptPreview', a.prompt_preview,
             'createdAt', a.created_at), ?
         FROM agent_turns a
         WHERE (a.task_id IS NULL OR ${live('a.task_id')})
           AND COALESCE(a.task_id, (
             SELECT o.task_id FROM agent_turns o
              WHERE o.worktree_path = a.worktree_path AND o.task_id IS NOT NULL AND ${live('o.task_id')}
              ORDER BY o.created_at DESC LIMIT 1)) IS NOT NULL`
      ).run(now)
      db.exec(`DROP TABLE agent_prompts;
        DROP TABLE agent_turns;`)
    }
  },
  {
    version: 208,
    up(db) {
      // Mirror bookkeeping the hub no longer needs (robustness plan §9, P0):
      // - `chat_provider_bindings` mirrored which chat holds a provider session. The
      //   chat's computer records it (its `session:*` record) and answers
      //   (`chatSessionOwner`); the session ledger lives there too (v206).
      // - `chat_queue_routes` mirrored which chat holds each queued message. A queue
      //   operation names the message's tab; the hub routes and authorizes by the tab,
      //   the computer refuses an item that tab does not hold.
      // The metadata cursor and receipts stay: they still guard the hub-owned caches
      // (file locations, agent state, activity). No trigger reads either table, and
      // dropping a table drops its own erasure fences.
      db.exec(`DROP TABLE chat_provider_bindings;
        DROP TABLE chat_queue_routes;`)
    }
  },
  {
    version: 209,
    up(db) {
      // Robustness plan §9 (P0): data only the computer running the work uses lives
      // only there.
      // - Usage-log read offsets: each computer keeps its own (its per-hub chat store)
      //   and commits one only after the hub stored that page's records. The hub's
      //   cursors become a one-time handoff: each computer's rows (and the hub-disk
      //   rows, computer_id '', which the hub machine's own computer reads) go with
      //   its next collect; the hub drops the table once it is empty
      //   (usage-analytics cache.ts). Records keep deterministic ids, so a re-parse
      //   never double counts.
      // - `processes.pid` / `process_pids`: no writer since runs live on computers
      //   (the live pid is in memory, adopted from the computer's `proc.list`).
      db.exec(`ALTER TABLE usage_parse_state RENAME TO usage_cursor_handoff;
        DROP TABLE process_pids;
        ALTER TABLE processes DROP COLUMN pid;`)
    }
  },
  {
    version: 210,
    up(db) {
      // Robustness plan §9 (P0), Phase 7a: a task's worktree path and base dir live
      // on the computer holding its work (chat-runtime task-paths.ts); that computer
      // runs every write (set, inherit, clear). Each task holding either is staged
      // once (kind `task-path`, keyed by task) for its worktree computer, else its
      // task computer (hub computer-task-paths.ts picks the target at delivery).
      // The hub columns stay until Phase 7e: until every path-taking request names a
      // task or project, they are the hub's authorization input, written alongside
      // the computer's row (consistency rule `task-path-hub-computer-drift`).
      // Erased tasks' paths are not staged. A path cleared to '' (the API accepted it)
      // is unset, as v211 counts it: the computer takes only absolute paths, and a ''
      // row faulted for good (found by tools/migration-personas, p10-v0380-worktrees;
      // v214 repairs a database that already ran this).
      db.prepare(
        `INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         SELECT 'task-path', t.id, t.id, json_object(
           'projectId', t.project_id, 'worktreePath', NULLIF(t.worktree_path, ''),
           'baseDir', NULLIF(t.base_dir, ''), 'at', ?), ?
         FROM tasks t
         WHERE (NULLIF(t.worktree_path, '') IS NOT NULL OR NULLIF(t.base_dir, '') IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = t.id)`
      ).run(Date.now(), Date.now())
    }
  },
  {
    version: 211,
    up(db) {
      // Robustness plan §9 (P0), Phase 7e: the hub keeps no task path. Every
      // path-taking request names its task or project and the computer confines the
      // path there; the worktree path and base dir live only on the computer holding
      // the task's folders (`worktree_computer_id`). The hub keeps whether each is set.
      //
      // 1. Where the folders are: a task holding a path but no recorded computer gets
      //    its task's computer, else its project's (where its work ran). Still none:
      //    the hand-off picks one at delivery (hub computer-task-paths.ts) and records it.
      //    A subtask holding its parent's folders (it inherited them: the same worktree
      //    and base dir) is where its parent's are, not where its own pin or project
      //    points — the subtask inherited the folder, not the pin (found by
      //    tools/migration-personas, p10-v0380-worktrees; v214 repairs a database that
      //    already ran this). A holder recorded before this (v197 on) is kept.
      db.exec(`
        CREATE TEMP TABLE v211_derived AS SELECT id FROM tasks
         WHERE worktree_computer_id IS NULL
           AND (NULLIF(worktree_path, '') IS NOT NULL OR NULLIF(base_dir, '') IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = tasks.id);
        UPDATE tasks SET worktree_computer_id = COALESCE(computer_id,
          (SELECT p.default_computer_id FROM projects p WHERE p.id = tasks.project_id))
        WHERE id IN (SELECT id FROM v211_derived);`)
      const followParent = db.prepare(`
        UPDATE tasks SET worktree_computer_id = (
            SELECT p.worktree_computer_id FROM tasks p WHERE p.id = tasks.parent_id)
         WHERE id IN (SELECT id FROM v211_derived)
           AND EXISTS (SELECT 1 FROM tasks p WHERE p.id = tasks.parent_id
             AND p.worktree_computer_id IS NOT NULL
             AND p.worktree_computer_id IS NOT tasks.worktree_computer_id
             AND NULLIF(p.worktree_path, '') IS NULLIF(tasks.worktree_path, '')
             AND NULLIF(p.base_dir, '') IS NULLIF(tasks.base_dir, ''))`)
      // One generation per pass (a grandchild follows its corrected parent); a task
      // tree is acyclic, the bound only guards.
      for (let i = 0; i < 1000 && followParent.run().changes > 0; i++);
      db.exec('DROP TABLE v211_derived')
      // 2. Staged once more at `at` 0 (the oldest): a computer already holding the row
      //    keeps its own; one that never took it (a quarantined v210 item, a computer
      //    restored from an older backup) gets it. A row still pending is newer: kept.
      db.exec(`
        INSERT OR IGNORE INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
          SELECT 'task-path', t.id, t.id, json_object(
            'projectId', t.project_id,
            'worktreePath', NULLIF(t.worktree_path, ''),
            'baseDir', NULLIF(t.base_dir, ''), 'at', 0), 0
          FROM tasks t
          WHERE ((t.worktree_path IS NOT NULL AND t.worktree_path <> '')
              OR (t.base_dir IS NOT NULL AND t.base_dir <> ''))
            AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = t.id);`)
      // 3. Flags, then the columns go.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN has_worktree INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN has_base_dir INTEGER NOT NULL DEFAULT 0;
        UPDATE tasks SET
          has_worktree = (worktree_path IS NOT NULL AND worktree_path <> ''),
          has_base_dir = (base_dir IS NOT NULL AND base_dir <> '')
        WHERE NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = tasks.id);
        ALTER TABLE tasks DROP COLUMN worktree_path;
        ALTER TABLE tasks DROP COLUMN base_dir;`)
    }
  },
  {
    version: 212,
    up: (db) => {
      // A project's legacy folder reaches every computer its work was bound to.
      // v176 (shipped, so it stays as it is) handed each `projects.path` to the LOCAL
      // computer only. But before folders were per computer, that one path served
      // whichever computer ran the work: the project's default computer and every
      // computer a task was pinned to lost it, and on a standalone hub — which has no
      // local computer — the project had a folder nowhere. Found by the migration
      // persona suite (tools/migration-personas, p02-v0362-multi).
      // Staged `pending` like v176's rows, so the hub delivers (and the computer checks)
      // each one on connect. A folder a computer already holds is left as it is.
      db.prepare(
        `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
           SELECT DISTINCT b.computer_id, p.id, p.path, 'pending', ?
             FROM projects p
             JOIN (SELECT id AS project_id, default_computer_id AS computer_id FROM projects
                   UNION
                   SELECT project_id, computer_id FROM tasks) b ON b.project_id = p.id
            WHERE p.path IS NOT NULL AND p.path <> '' AND b.computer_id IS NOT NULL
         ON CONFLICT(computer_id, project_id) DO NOTHING`
      ).run(Date.now())
    }
  },
  {
    version: 213,
    up: (db) => {
      // The per-tab session recovery queue (v201) holds terminal sessions only. v201
      // queued chat-mode sessions too, but the recovery (hub session-tab-recovery.ts)
      // re-attributes a session only from the `pty.create` diagnostics of the spawn
      // that minted it, and runs only when the hub prepares a task before a terminal
      // resume. A chat session has neither: its row could only ever settle on the main
      // tab — which it already is — yet stayed queued forever. Found by the migration
      // persona suite (tools/migration-personas, p08-v0380-tabs-usage).
      // The chat modes as of this migration (CHAT_SUPPORTED_MODES), frozen.
      db.exec(`DELETE FROM session_tab_recovery WHERE mode IN ('claude-chat', 'codex-chat')`)
    }
  },
  {
    version: 214,
    up: (db) => {
      // Repairs the task-path hand-off of v210/v211 (both unreleased then), from the
      // staged `task-path` rows — the only copy of the paths left on the hub. Found by
      // the migration persona suite (tools/migration-personas, p10-v0380-worktrees).
      //
      // 1. A path cleared to '' (the pre-v210 API accepted it) was staged by v210 as ''.
      //    The computer takes only absolute paths, so the row faulted for good and
      //    never drained. '' is unset (as v211 already counts it): staged as null.
      const notErased = `NOT EXISTS (SELECT 1 FROM content_erasure_tasks e
        WHERE e.task_id = computer_data_handoff.task_id)`
      for (const field of ['worktreePath', 'baseDir'])
        db.exec(`
          UPDATE computer_data_handoff SET payload = json_set(payload, '$.${field}', json('null'))
           WHERE kind = 'task-path' AND json_extract(payload, '$.${field}') = '' AND ${notErased};`)
      // 2. A subtask inherits its parent's worktree and base dir — the parent's folder,
      //    on the parent's computer — but not the parent's pin. v211 recorded its holder
      //    as its own pin, else its project's default computer: not where the folder is
      //    when the parent was pinned elsewhere. A task whose staged paths equal its
      //    parent's (both fields given in both rows, one set) takes the parent's holder;
      //    repeated so a grandchild follows its corrected parent. Only a holder the old
      //    v211 derived (its pin, else its project's default) moves: one a real write
      //    recorded (v197 on) is kept, as v211 keeps it.
      //    Not derivable: a hub that delivered its staged rows (ran v211 with computers
      //    connected) before this migration keeps no path to compare — the holder v211
      //    chose stays there (no release shipped v210/v211 before this one).
      const both = (alias: string) =>
        `json_type(${alias}.payload, '$.worktreePath') IS NOT NULL
         AND json_type(${alias}.payload, '$.baseDir') IS NOT NULL
         AND json_type(${alias}.payload, '$.inheritFrom') IS NULL`
      const inherit = db.prepare(`
        UPDATE tasks SET worktree_computer_id = (
            SELECT p.worktree_computer_id FROM tasks p WHERE p.id = tasks.parent_id)
         WHERE tasks.parent_id IS NOT NULL
           AND (tasks.has_worktree = 1 OR tasks.has_base_dir = 1)
           AND tasks.worktree_computer_id IS COALESCE(tasks.computer_id,
                 (SELECT d.default_computer_id FROM projects d WHERE d.id = tasks.project_id))
           AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id = tasks.id)
           AND EXISTS (
             SELECT 1 FROM tasks p
               JOIN computer_data_handoff hp ON hp.kind = 'task-path' AND hp.item_key = p.id
               JOIN computer_data_handoff hc ON hc.kind = 'task-path' AND hc.item_key = tasks.id
              WHERE p.id = tasks.parent_id
                AND p.worktree_computer_id IS NOT NULL
                AND p.worktree_computer_id IS NOT tasks.worktree_computer_id
                AND ${both('hp')} AND ${both('hc')}
                AND json_extract(hc.payload, '$.worktreePath') IS json_extract(hp.payload, '$.worktreePath')
                AND json_extract(hc.payload, '$.baseDir') IS json_extract(hp.payload, '$.baseDir')
                AND COALESCE(json_extract(hc.payload, '$.worktreePath'),
                             json_extract(hc.payload, '$.baseDir')) IS NOT NULL)`)
      // Each pass moves one generation; a task tree is acyclic, the bound only guards.
      for (let i = 0; i < 1000 && inherit.run().changes > 0; i++);
    }
  },
  {
    version: 215,
    up: (db) => {
      // One answer about a removed computer (post-v0.39.0 review).
      //
      // 1. A retirement names its final successor, or none (computers store
      //    `computerStanding`; its writers keep it so from now on). A computer
      //    re-enrolled as one that was re-enrolled again names the last; one whose
      //    successor was deleted or went missing is removed for good, with that reason.
      //    Every single-row check (SQL and code) then reads a chain right. A cycle names
      //    no live computer: removed, 'missing'.
      const rows = db
        .prepare('SELECT computer_id, successor_id, reason FROM computer_retirements')
        .all() as Array<{ computer_id: string; successor_id: string | null; reason: string }>
      const byId = new Map(rows.map((r) => [r.computer_id, r]))
      const collapse = db.prepare(
        'UPDATE computer_retirements SET successor_id = ?, reason = ? WHERE computer_id = ?'
      )
      for (const r of rows) {
        if (r.successor_id === null) continue
        const seen = new Set([r.computer_id])
        let next: string = r.successor_id
        let end: { successor: string | null; reason: string }
        for (;;) {
          const further = byId.get(next)
          if (!further) {
            end = { successor: next, reason: r.reason }
            break
          }
          if (further.successor_id === null) {
            end = { successor: null, reason: further.reason }
            break
          }
          seen.add(next)
          if (seen.has(further.successor_id)) {
            end = { successor: null, reason: 'missing' }
            break
          }
          next = further.successor_id
        }
        if (end.successor !== r.successor_id || end.reason !== r.reason)
          collapse.run(end.successor, end.reason, r.computer_id)
      }
      // 2. A chat's unavailable reason is a code; its text lives in one place
      //    (terminal-contracts `chatUnavailableDetail`). The hub only ever stored these
      //    two texts (v0.39.0), frozen here; any other reads as not returned.
      db.prepare(
        `UPDATE chat_unavailable_owners SET reason = CASE reason WHEN ? THEN 'computer-removed' ELSE 'not-returned' END
          WHERE reason NOT IN ('computer-removed', 'not-returned')`
      ).run(
        'Chat history unavailable. Its computer was removed. Connect a computer that holds this chat (e.g. the same machine re-enrolled with its chat data) to restore it.'
      )
    }
  },
  {
    version: 216,
    up: (db) => {
      // Moving tasks to another hub (cross-hub move, slice 3a). The hub the tasks
      // leave keeps the move's journal: every step is recorded, so a paused or
      // interrupted move resumes from any device. While a move is running or paused,
      // its tasks are locked (writes refused). Once released, a redirect names the hub
      // each task went to, so old links and open tabs find it.
      db.exec(`
        CREATE TABLE task_moves (
          id                TEXT PRIMARY KEY,
          direction         TEXT NOT NULL CHECK (direction IN ('out', 'in')),
          peer_hub_id       TEXT NOT NULL,
          target_project_id TEXT NOT NULL,
          root_task_ids     TEXT NOT NULL,
          include_subtasks  INTEGER NOT NULL,
          include_sessions  INTEGER NOT NULL DEFAULT 1,
          step              TEXT NOT NULL,
          status            TEXT NOT NULL
                            CHECK (status IN ('running', 'paused', 'failed', 'canceled', 'done')),
          error             TEXT,
          progress          TEXT,
          created_by        TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_task_moves_status ON task_moves(status);
        CREATE TABLE task_move_tasks (
          move_id TEXT NOT NULL REFERENCES task_moves(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          PRIMARY KEY (move_id, task_id)
        );
        CREATE INDEX idx_task_move_tasks_task ON task_move_tasks(task_id);
        CREATE TABLE task_move_redirects (
          task_id    TEXT PRIMARY KEY,
          hub_id     TEXT NOT NULL,
          move_id    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      // A blocker between tasks on two hubs (a move split them): each hub keeps its
      // side — its own task, and whether it blocks or is blocked by the other hub's.
      db.exec(`
        CREATE TABLE task_remote_blockers (
          task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role           TEXT NOT NULL CHECK (role IN ('blocks', 'blocked_by')),
          remote_hub_id  TEXT NOT NULL,
          remote_task_id TEXT NOT NULL,
          remote_title   TEXT,
          created_at     INTEGER NOT NULL,
          PRIMARY KEY (task_id, role, remote_hub_id, remote_task_id)
        );
      `)
      // The chats of tasks that moved away: their computer still holds them (a move
      // never erases them), so a task moving back takes them up again — each with the
      // ownership it had when it left (the delete triggers mark it deleted meanwhile).
      db.exec(`
        CREATE TABLE task_move_parked_chats (
          conversation_id TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          state           TEXT NOT NULL,
          epoch           INTEGER NOT NULL,
          cleanup_pending INTEGER NOT NULL
        );
        CREATE INDEX idx_task_move_parked_chats_task ON task_move_parked_chats(task_id);
      `)
      // task_move_tasks / task_move_redirects / task_remote_blockers /
      // task_move_parked_chats carry a task_id:
      // fenced like every such table.
      installContentErasureFences(db)
    }
  },
  {
    version: 217,
    up: (db) => {
      // Moving a whole project to another hub: a move of every task in the project,
      // plus the project's own rows. `scope` says which; `project_id` names the
      // project (its id is kept, so the target project is the same id). One unfinished
      // project move per project, either direction.
      db.exec(`
        ALTER TABLE task_moves ADD COLUMN scope TEXT NOT NULL DEFAULT 'task'
          CHECK (scope IN ('task', 'project'));
        ALTER TABLE task_moves ADD COLUMN project_id TEXT;
        CREATE UNIQUE INDEX idx_task_moves_project_unfinished ON task_moves(project_id)
          WHERE scope = 'project' AND status IN ('running', 'paused', 'failed');
        CREATE TABLE project_move_redirects (
          project_id TEXT PRIMARY KEY,
          hub_id     TEXT NOT NULL,
          move_id    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
    }
  }
]

export const LATEST_MIGRATION_VERSION = migrations[migrations.length - 1].version

/**
 * Thrown when the DB was migrated by a NEWER build than this one. Migrations are
 * forward-only (there is no `down`), so an older binary would run its queries
 * against a schema it was never written for — refuse instead of corrupting data.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly latestVersion: number
  ) {
    super(
      `Database schema v${dbVersion} is newer than this build supports (v${latestVersion}). ` +
        'Install the newer build again, or restore a backup taken before the upgrade.'
    )
    this.name = 'SchemaTooNewError'
  }
}

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion > LATEST_MIGRATION_VERSION) {
    throw new SchemaTooNewError(currentVersion, LATEST_MIGRATION_VERSION)
  }

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        migration.up(db)
        db.pragma(`user_version = ${migration.version}`)
      })()
      console.log(`Migration ${migration.version} applied`)
    }
  }
}
