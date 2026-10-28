/**
 * The SQLite schema migrations, below every domain: this package depends on no
 * domain, so domain tests can build the real schema without a dependency cycle.
 * Migrations are historical — any domain value one needs is frozen inside it
 * (see `frozen/`), never imported live.
 *
 * Runtime boot steps that are NOT migrations (project status normalization,
 * terminal-mode sync) belong to their domains; the DB owner composes them after
 * `runMigrations` (see the hub's `bootstrapSchema`).
 */

export {
  migrations,
  LATEST_MIGRATION_VERSION,
  runMigrations,
  SchemaTooNewError
} from './migrations'
export { createPreMigrationBackup } from './pre-migration-backup'
