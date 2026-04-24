import Database from 'better-sqlite3'
import { parseSkillFrontmatter, renderSkillFrontmatter, validateSkillFrontmatter } from '@slayzone/ai-config/shared'

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

const migrations: Migration[] = [
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
      db.exec(`ALTER TABLE tasks ADD COLUMN dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0;`)
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
      const tasks = db.prepare(`SELECT id, browser_url FROM tasks WHERE browser_url IS NOT NULL AND browser_url != ''`).all() as Array<{ id: string; browser_url: string }>
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
      const tasks = db.prepare(`SELECT id, terminal_mode FROM tasks`).all() as Array<{ id: string; terminal_mode: string | null }>
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
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('default_claude_flags', '--allow-dangerously-skip-permissions')
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('default_codex_flags', '--full-auto --search')
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

      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('diagnostics_enabled', '1')
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('diagnostics_verbose', '0')
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('diagnostics_include_pty_output', '0')
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('diagnostics_retention_days', '14')
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
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
        .run('auto_create_worktree_on_task_create', '0')
    }
  },
  {
    version: 29,
    up: (db) => {
      db.prepare(`UPDATE settings SET value = '--allow-dangerously-skip-permissions' WHERE key = 'default_claude_flags' AND value = '--dangerously-skip-permissions'`).run()
      db.prepare(`UPDATE tasks SET claude_flags = '--allow-dangerously-skip-permissions' WHERE claude_flags = '--dangerously-skip-permissions'`).run()
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
      const stmt = db.prepare(`INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`)
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
      const insertStmt = db.prepare(`INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`)
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
      const tasks = db.prepare(`
        SELECT id,
          claude_conversation_id, codex_conversation_id, cursor_conversation_id,
          gemini_conversation_id, opencode_conversation_id,
          claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags
        FROM tasks
      `).all() as Array<{
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
          { mode: 'opencode', convId: task.opencode_conversation_id, flags: task.opencode_flags },
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
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
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
      db.prepare(`UPDATE ai_config_sources SET enabled = 0, updated_at = datetime('now') WHERE kind = 'codex'`).run()

      // 3) Strip codex from per-project provider settings payloads.
      const rows = db.prepare(`
        SELECT key, value
        FROM settings
        WHERE key LIKE 'ai_providers:%'
      `).all() as Array<{ key: string; value: string }>
      const updateStmt = db.prepare(`UPDATE settings SET value = ? WHERE key = ?`)

      for (const row of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row.value)
        } catch {
          continue
        }
        if (!Array.isArray(parsed)) continue

        const filtered = parsed.filter((provider): provider is string => typeof provider === 'string' && provider !== 'codex')
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
      const rows = db.prepare(`
        SELECT key, value
        FROM settings
        WHERE key LIKE 'ai_providers:%'
      `).all() as Array<{ key: string; value: string }>
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

        const filtered = parsed.filter((provider): provider is string => typeof provider === 'string' && !removedSet.has(provider))
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
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
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
      const rows = db.prepare(`
        SELECT id, scope, project_id, type, slug
        FROM ai_config_items
        ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string
        scope: 'global' | 'project'
        project_id: string | null
        type: string
        slug: string
      }>

      const updateSlug = db.prepare('UPDATE ai_config_items SET slug = ?, name = ?, updated_at = datetime(\'now\') WHERE id = ?')
      const seenByBucket = new Map<string, Set<string>>()

      for (const row of rows) {
        const bucket = row.scope === 'global'
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
        return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
      }

      const rows = db.prepare(`
        SELECT id, scope, project_id, type, slug
        FROM ai_config_items
        ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string
        scope: 'global' | 'project'
        project_id: string | null
        type: string
        slug: string
      }>

      const updateSlug = db.prepare('UPDATE ai_config_items SET slug = ?, name = ?, updated_at = datetime(\'now\') WHERE id = ?')
      const seenByBucket = new Map<string, Set<string>>()

      for (const row of rows) {
        const bucket = row.scope === 'global'
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
      const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
      const hasWorktreeSourceBranch = projectColumns.some((column) => column.name === 'worktree_source_branch')
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
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run('ccs_enabled', '0')
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
        ['default_opencode_flags', 'opencode'],
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
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'panel_config'`).get() as { value: string } | undefined
      if (!row) return
      try {
        const config = JSON.parse(row.value) as { builtinEnabled?: Record<string, boolean>; viewEnabled?: Record<string, Record<string, boolean>>; [k: string]: unknown }
        if (config.viewEnabled) {
          if (config.builtinEnabled) { delete config.builtinEnabled }
          else return
        } else {
          const legacy = config.builtinEnabled ?? {}
          delete config.builtinEnabled
          const homeIds = new Set(['git', 'diff', 'editor', 'processes', 'tests'])
          config.viewEnabled = {
            home: Object.fromEntries(Object.entries(legacy).filter(([id]) => homeIds.has(id))),
            task: { ...legacy },
          }
        }
        db.prepare(`UPDATE settings SET value = ? WHERE key = 'panel_config'`).run(JSON.stringify(config))
      } catch { /* malformed JSON, skip */ }
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
      const rows = db.prepare(`
        SELECT id, slug, content, metadata_json
        FROM ai_config_items
        WHERE type = 'skill'
      `).all() as Array<{
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
        nextMetadata.skillValidation = validateSkillFrontmatter(row.slug, parseSkillFrontmatter(nextContent))
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
      db.prepare(`INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`)
        .run('provider-qwen', 'Qwen Code', 'qwen', 0, 'active')
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
      const stmt = db.prepare(`INSERT OR IGNORE INTO ai_config_sources (id, name, kind, enabled, status) VALUES (?, ?, ?, ?, ?)`)
      stmt.run('provider-copilot', 'Copilot', 'copilot', 0, 'active')
    }
  },
  {
    version: 82,
    up: (db) => {
      db.exec(`ALTER TABLE integration_project_mappings ADD COLUMN assigned_to_me INTEGER DEFAULT 0`)
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
      const firstProject = db.prepare('SELECT id FROM projects ORDER BY sort_order LIMIT 1').get() as { id: string } | undefined
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
      const existingTags = db.prepare('SELECT * FROM tags ORDER BY name').all() as { id: string; name: string; color: string; created_at: string }[]
      const insertTag = db.prepare('INSERT INTO tags_new (id, project_id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
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
        markdown: '.md', code: '.txt', html: '.html', svg: '.svg', mermaid: '.mmd'
      }
      const typeToRenderMode: Record<string, string> = {
        markdown: 'markdown', code: 'code', html: 'html-preview', svg: 'svg-preview', mermaid: 'mermaid-preview'
      }
      // Extension → inferred render mode (mirrors EXTENSION_RENDER_MODES in types.ts)
      const extToRenderMode: Record<string, string> = {
        '.md': 'markdown', '.mdx': 'markdown',
        '.html': 'html-preview', '.htm': 'html-preview',
        '.svg': 'svg-preview',
        '.mmd': 'mermaid-preview', '.mermaid': 'mermaid-preview',
        '.txt': 'code',
      }

      const assets = db.prepare('SELECT id, title, type FROM task_assets').all() as
        { id: string; title: string; type: string }[]
      const updateStmt = db.prepare('UPDATE task_assets SET title = ?, render_mode = ? WHERE id = ?')

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
      const row = db.prepare("SELECT value FROM settings WHERE key = 'agentPanelState'").get() as { value: string } | undefined
      if (!row) return
      try {
        const state = JSON.parse(row.value)
        if (state.floatingEnabled === true) {
          state.floatingEnabled = false
          db.prepare("UPDATE settings SET value = ? WHERE key = 'agentPanelState'").run(JSON.stringify(state))
        }
      } catch { /* malformed JSON, skip */ }
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
  }
]

export const LATEST_MIGRATION_VERSION = migrations[migrations.length - 1].version

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number

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
