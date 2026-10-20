# Backup and restore: `<ROOT>` is one unit

A hub keeps all its state under one directory, `<ROOT>` (`SLAYZONE_ROOT`; see
`getStorageDir()` in `shared/platform/src/paths.ts`). Back it up and restore it
**as a whole**, from one point in time. Restoring one file without the others leaves
them disagreeing (sessions without users, artifact rows without files, or the reverse).

| Path under `<ROOT>` | What | In the built-in backup? |
|---|---|---|
| `slayzone.sqlite` (+ `-wal`, `-shm`) | Main DB: projects, tasks, artifact rows | Yes (`apps/hub/src/backup.ts`) |
| `slayzone.diagnostics.sqlite` | Diagnostics events | No (disposable) |
| `hub-auth.sqlite` | Users, sessions, computer enrollments | **No** |
| `artifacts/` | Artifact file contents | **No** |
| `identity/` | Hub TLS key + certificate | **No** |
| `hub.config.json`, `hub.state.json` | Operator config; generated secrets | **No** |
| `backups/` | The built-in backups themselves | — |

(`.dev` builds use `slayzone.dev.*` names.)

## Rules

- **Stop the hub first**, then copy `<ROOT>` (or snapshot the volume). A copy of a
  live SQLite file without its `-wal` is not a backup.
- **Forward only.** Migrations have no `down`. A build refuses to start on a DB
  migrated by a newer build (`SchemaTooNewError`,
  `shared/transport/src/db-bootstrap/migrations.ts`). To go back a version, restore
  the whole `<ROOT>` from before the upgrade; never run the old binary on the new DB.
- Each upgrade that migrates writes `backups/*.migration.sqlite` (main DB only; the
  last 3 are kept). It covers the main DB only, not the rest of the table above.
