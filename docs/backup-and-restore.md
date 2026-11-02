# Backup and restore: `<ROOT>` is one unit

A hub keeps all its state under one directory, `<ROOT>` (`SLAYZONE_ROOT`; see
`getStorageDir()` in `shared/platform/src/paths.ts`). Back it up and restore it
**as a whole**, from one point in time. Restoring one file without the others leaves
them disagreeing (sessions without users, artifact rows without files, or the reverse).

| Path under `<ROOT>` | What | In the built-in backup? |
|---|---|---|
| `slayzone.data.sqlite` (+ `-wal`, `-shm`) | Main DB: projects, tasks, artifact rows | Yes (`apps/hub/src/backup.ts`) |
| `slayzone.diagnostics.sqlite` | Diagnostics events | No (disposable) |
| `slayzone.auth.sqlite` | Users, sessions, computer enrollments | **No** |
| `artifacts/` | Artifact file contents | **No** |
| `identity/` | Hub TLS key + certificate | **No** |
| `hub.config.json`, `hub.state.json` | Operator config; generated secrets | **No** |
| `backups/` | The built-in backups themselves | — |

(`.dev` builds use `slayzone.dev.data.sqlite` and `slayzone.dev.diagnostics.sqlite`.)

The desktop app's `<ROOT>` is `~/.slayzone/stable/hub` (dev builds: `~/.slayzone/dev/hub`;
on Windows the same folders under the user profile).

## Rules

- **Stop the hub first**, then copy `<ROOT>` (or snapshot the volume). A copy of a
  live SQLite file without its `-wal` is not a backup.
- **Forward only.** Migrations have no `down`. A build refuses to start on a DB
  migrated by a newer build (`SchemaTooNewError`,
  `shared/db-migrations/src/migrations.ts`). To go back a version, restore
  the whole `<ROOT>` from before the upgrade; never run the old binary on the new DB.
- Each upgrade that migrates writes `backups/*.migration.sqlite` (main DB only; the
  last 3 are kept). It covers the main DB only, not the rest of the table above.

## Computer-owned chat

Chat history, drafts, queued messages, prompt history, workspace diffs and sealed
attachments live on the owning computer, scoped to its authenticated hub. Its
storage directory contains `computer-runtime/<hub-scope-hash>/chat.sqlite` and
referenced blobs. A hub-only backup does not include this computer data.
Use each computer's chat backup controls to snapshot its database and referenced
files together, including original task files and their saved versions. Restored
archives let you download each version or include it in the history export.
Restores open separate, read-only archives: readable history is
guaranteed after verification; provider session resumability is not.

`SLAYZONE_HUB_SESSION_RETENTION_DAYS` also configures computer chat retention for
that hub. Unset or `0` keeps content until explicit deletion. A positive whole
number enables a sweep shortly after connection/startup and then daily. Each
computer persists its last configured policy for offline operation. Expiry removes
old saved chat content, invalidates derived pages and collects unreferenced sealed
attachments. Live agents, in-flight operations, Trash and unfinished migrations
defer pruning. Original task files remain; backups follow their separate retention
policy. Existing hub backups remain under their original retention rules.

Operation IDs survive expiry to prevent delayed retries from resending messages.
Expired cached results return an explicit error. Receipts created before timestamps
were tracked receive a full retention window from upgrade, since their age is unknown.

## Upgrading from v0.35.0

v0.35.0 kept its data in the Electron app-data folder (macOS:
`~/Library/Application Support/slayzone`). The first launch of the next release **copies**
it into `<ROOT>`; it never moves or deletes anything there.

- **Quit v0.35.0 first.** Both apps share one single-instance lock; a launch that does not
  hold it touches nothing, so the import simply waits for the next launch.
- **What is copied:** the database (+ WAL), artifacts, blobs, project icons and the two
  newest backups. The copy is atomic and size-checked; a database that cannot be copied
  stops the launch with a dialog naming the file, rather than starting empty.
- **The old folder stays**, so the data exists twice. Delete it yourself once you have
  checked the new app.
- **There is no way back that keeps new work.** After the first launch the two apps keep
  separate databases: v0.35.0 never sees what you did in the new version, and re-installing
  v0.35.0 will not import it. A newer database is refused by older builds.
- **Windows:** an installed `slay` CLI is refreshed to the bundled version on launch.
  Before that, a v0.35.0 `slay.js` writes into the old database.
- **Before migrating**, the app saves `backups/*.migration.sqlite` (the last 3 are kept).

