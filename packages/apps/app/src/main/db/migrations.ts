import Database from 'better-sqlite3'

interface Migration {
  version: number
  up: (db: Database.Database) => void
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
  }
]

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
