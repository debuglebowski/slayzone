/** Shared table layout for hub and computer erasure journals; no content payloads. */
export const CONTENT_ERASURE_SCHEMA = `
        CREATE TABLE IF NOT EXISTS content_erasure_jobs (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          owner_user_id TEXT,
          actor_user_id TEXT,
          manifest TEXT NOT NULL,
          db_erased INTEGER NOT NULL DEFAULT 0,
          local_erased INTEGER NOT NULL DEFAULT 0,
          gc_generation INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'incomplete' CHECK(state IN ('incomplete','complete')),
          failure_codes TEXT NOT NULL DEFAULT '[]',
          retained_shared_blobs INTEGER NOT NULL DEFAULT 0,
          retained_backup_blobs INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS content_erasure_tasks (
          task_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES content_erasure_jobs(id),
          owner_user_id TEXT
        );
        CREATE INDEX IF NOT EXISTS content_erasure_jobs_owner ON content_erasure_jobs(owner_user_id,state);
        CREATE INDEX IF NOT EXISTS content_erasure_tasks_job ON content_erasure_tasks(job_id);
        CREATE TABLE IF NOT EXISTS content_erasure_tabs (
          tab_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES content_erasure_jobs(id)
        );
        CREATE TABLE IF NOT EXISTS content_erasure_artifacts (
          artifact_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES content_erasure_jobs(id)
        );
        CREATE TABLE IF NOT EXISTS content_erasure_computer_acks (
          job_id TEXT NOT NULL REFERENCES content_erasure_jobs(id),
          computer_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          method TEXT NOT NULL DEFAULT 'computer' CHECK(method IN ('computer','operator')),
          verified_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(job_id,computer_id,task_id)
        );
        CREATE TABLE IF NOT EXISTS content_erasure_offline_requests (
          job_id TEXT NOT NULL REFERENCES content_erasure_jobs(id),
          computer_id TEXT NOT NULL,
          request_json TEXT NOT NULL,
          PRIMARY KEY(job_id,computer_id)
        );
`

export const CONTENT_ERASURE_ARTIFACT_FENCES = `
  CREATE TRIGGER IF NOT EXISTS erased_artifact_cannot_return BEFORE INSERT ON task_artifacts
    WHEN EXISTS(SELECT 1 FROM content_erasure_artifacts WHERE artifact_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'Artifact was permanently erased'); END;
  CREATE TRIGGER IF NOT EXISTS erased_artifact_has_no_new_versions BEFORE INSERT ON artifact_versions
    WHEN EXISTS(SELECT 1 FROM content_erasure_artifacts WHERE artifact_id=NEW.artifact_id)
    BEGIN SELECT RAISE(ABORT,'Artifact was permanently erased'); END;
`
