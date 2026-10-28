/**
 * Multi-hub federation (client-side hub registry).
 *
 * A "hub" is a full data server: it owns a SQLite DB + all routers/auth. The
 * client can connect to several at once and merges their projects into one flat
 * rail. A project belongs to exactly one hub (the DB it lives in) — there is no
 * user-facing "active hub".
 *
 * The registry lives in the pre-boot `client.boot.json` (a hub can't store the
 * list of hubs — it may be down), so this contract is shared between the main
 * process (boot-config) and the renderer (via the `app:get-hub-registry` IPC).
 *
 * Type-only and dependency-free: also the lean `@slayzone/platform/hub-registry`
 * subpath, safe to import from renderer bundles.
 */
export type HubKind = 'local' | 'remote'

export interface HubEntry {
  /** Stable id — the `'local'` sentinel for the co-located sidecar; for a remote
   * hub `hub:<url>`, or `remote-legacy` for a migrated pre-multi-hub remote. */
  id: string
  kind: HubKind
  /** User-facing display name. */
  label: string
  /** Canonical ws(s)://host[:port]/trpc URL. Absent for local (resolved at
   * runtime from the live sidecar port). A remote wss:// hub's certificate is
   * verified the normal way (CA chain + hostname) — nothing is pinned. */
  url?: string
}
