/**
 * The typed env-var scope manifest + the central spawn-env sanitizer.
 *
 * WHY: one desktop client hosts the hub sidecar + a local runner + user
 * terminals, all forked from the SAME `process.env`. Every spawn used
 * `{...process.env}` with no allowlist, so a var set high in the tree (e.g. the
 * runner's `SLAYZONE_HUB_ADDRESS`) silently leaked DOWN into a user terminal,
 * where a different consumer (`slay` CLI) reinterpreted it and hard-exited. An
 * ALLOWLIST can't work at these boundaries — the hub/runner ARE the parents of
 * user terminals, which legitimately need the full user env (PATH/HOME/
 * toolchains). So the mechanism is a DENYLIST derived from this manifest.
 *
 * FAIL CLOSED: the strip-list is derived from the scope tags, NOT hand-written.
 * Only a var explicitly tagged `global` survives; every other SLAYZONE_* —
 * including one not yet in the manifest — is stripped. So adding a new secret to
 * the manifest auto-strips it, and forgetting to add a new var at all ALSO
 * strips it (safe default). The only way to leak a var into a terminal is the
 * deliberate `global` tag.
 *
 * Lean leaf (node builtins only, like slayzone-mode.ts) so the runner bundle can
 * import it via the `@slayzone/platform/env-manifest` subpath WITHOUT pulling the
 * platform barrel (which references better-sqlite3 + the shell/cli-install graph).
 *
 * @module platform/env-manifest
 */

/**
 * The scope of a SlayZone env var, deciding whether it survives into a spawned
 * user-terminal / agent child:
 *   - `global`   — same app-wide, safe to inherit verbatim. KEEP.
 *   - `infra`    — SlayZone process wiring a terminal must not reinterpret
 *                  (hub address, ports, mode, dev toggles). STRIP.
 *   - `secret`   — credentials/tokens. Must never reach a terminal. STRIP.
 *   - `identity` — per-task/agent identity. STRIP from the inherited base; the
 *                  caller's per-spawn overlay (buildMcpEnv) re-adds the CORRECT
 *                  value, so a terminal for task B never inherits task A's id and
 *                  a taskless shell has it ABSENT rather than stale.
 */
export type EnvScope = 'global' | 'infra' | 'secret' | 'identity'

/**
 * Every `SLAYZONE_*` var the product reads/writes at runtime, tagged by scope.
 * NOT included (intentionally): compile-time `define` constants (`__…__`
 * forms — SLAYZONE_PROFILE/CHROMIUM_PROD/REACT_DEV read only at build config
 * time), JS const names, script-only comment markers (SLAYZONE_NOTIFY_VERSION),
 * and retired/inert/test-only vars (SLAYZONE_HUB_URL, HUB_HOST, HUB_PORT,
 * HUB_PUBLIC_URL — all folded into HUB_ADDRESS/HUB_PUBLIC_ADDRESS; STORE_DIR,
 * DB_DIR, AGENT_MODE, RUNNER_CONFIG, RUNNER_TRANSPORT_BASE_URL,
 * RUNNER_ALLOWED_ROOTS, RUNNER_NAME, RUNNER_CREDENTIALS_DIR, SEED_DEMO). An
 * unlisted SLAYZONE_* is stripped by default (fail closed), so omissions are
 * safe, never leaky — which is also why a RETIRED name needs no entry: a stale
 * inherited value is stripped by the same default that covers a brand-new var.
 */
export const ENV_MANIFEST: Record<string, EnvScope> = {
  // --- secret: credentials/tokens, never in a terminal ---
  SLAYZONE_HUB_TOKEN: 'secret',
  SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET: 'secret',
  SLAYZONE_RUNNER_JOIN_TOKEN: 'secret',
  SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS: 'secret',

  // --- infra: SlayZone wiring a terminal must not reinterpret ---
  // The hub's address, host[:port], scheme from MODE. ONE concept whose value
  // depends on the app: the hub BINDS it, the runner/CLI CONNECT to it. Stripping
  // it here is what keeps those two values from ever bleeding into each other.
  SLAYZONE_HUB_ADDRESS: 'infra',
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'infra', // hub-only; written into join tokens
  SLAYZONE_BRIDGE_URL: 'infra', // sidecar→host capability bridge
  SLAYZONE_MODE: 'infra', // local vs remote hardening lever
  SLAYZONE_SUPERVISED: 'infra', // "the Electron host owns me" flag
  SLAYZONE_DB_PATH: 'infra', // explicit DB path override (CLI/e2e)
  SLAYZONE_USER_DATA_DIR: 'infra', // Playwright Electron userData redirect
  SLAYZONE_SIDECAR_HOT_RESTART: 'infra',
  SLAYZONE_BOOT_LOG_PATH: 'infra',
  SLAYZONE_DEBUG_BOOT: 'infra',
  SLAYZONE_REGISTER_DEV_PROTOCOL: 'infra',
  SLAYZONE_NONINTERACTIVE: 'infra',
  SLAYZONE_E2E_ALLOW_RUNNER: 'infra',
  SLAYZONE_E2E_INSTALL_HOOKS: 'infra',
  // per-provider config/hook/plugin path overrides (test/sandbox redirects)
  SLAYZONE_CLAUDE_SETTINGS_PATH: 'infra',
  SLAYZONE_GEMINI_SETTINGS_PATH: 'infra',
  SLAYZONE_CODEX_HOOKS_PATH: 'infra',
  SLAYZONE_ANTIGRAVITY_HOOKS_PATH: 'infra',
  SLAYZONE_OPENCODE_PLUGIN_PATH: 'infra',

  // --- identity: per-task/agent; overlay re-adds the correct value per spawn ---
  SLAYZONE_TASK_ID: 'identity',
  SLAYZONE_PROJECT_ID: 'identity',
  SLAYZONE_SESSION_ID: 'identity',
  SLAYZONE_AGENT_ID: 'identity',
  SLAYZONE_AGENT_HOOK_URL: 'identity',
  SLAYZONE_HOOK_CONTEXT: 'identity',

  // --- global: same app-wide, safe to inherit verbatim ---
  SLAYZONE_RELEASE_CHANNEL: 'global', // attribution-only (hook envelope channel)
  // INSTALL IDENTITY — which SlayZone install this process tree belongs to, not
  // which task/session. A child MUST resolve the SAME install as its parent: the
  // `slay` CLI derives its DB from BOTH (getStorageDir() reads ROOT; the
  // filename is `slayzone{.dev}.sqlite` per DEV — apps/cli/src/db.ts getDbPath).
  // Strip either and a bare `slay` in a dev-app task terminal exits 1
  // ("Database not found … Re-run with --dev"), and under an isolated e2e ROOT a
  // child would escape the sandbox to the real ~/.slayzone. Neither is a
  // credential and neither can be reinterpreted as a different kind of target
  // (unlike a hub address), so both inherit verbatim.
  //
  // ROOT is NOT covered by the identity overlay: buildMcpEnv sets it only inside
  // setHookIdentity(), gated on a hook-capable agent mode — a plain `terminal`
  // PTY, a non-hook agent, or a pre-warmed pool spawn gets no overlay at all.
  SLAYZONE_ROOT: 'global',
  SLAYZONE_DEV: 'global'
}

/**
 * Non-`SLAYZONE_`-prefixed keys that are still SlayZone INFRA and must be
 * stripped from a terminal child. These wire the spawned sidecar/runner to the
 * Node runtime + native modules; a user terminal must inherit none of them
 * (e.g. `ELECTRON_RUN_AS_NODE=1` would make a nested Electron launch run as bare
 * Node; `PLAYWRIGHT=1` would flip in-app test-only branches).
 */
export const NON_PREFIXED_INFRA = new Set<string>([
  'ELECTRON_RUN_AS_NODE',
  'NODE_PATH',
  'PLAYWRIGHT'
])

/**
 * Produce the base env for a spawned USER-TERMINAL / agent child: keep the
 * user's own environment (PATH/HOME/toolchains) and any `global`-scoped SlayZone
 * var; strip every infra/secret/identity var, every unmanifested `SLAYZONE_*`
 * (fail closed), and every {@link NON_PREFIXED_INFRA} key. Values that are not
 * strings (an unset key present as `undefined`) are dropped, so the result is a
 * clean `Record<string,string>` ready for `child_process`/`node-pty`.
 *
 * The caller layers its per-spawn overlay (identity via buildMcpEnv, adapter
 * env, TERM/COLORTERM, etc.) AFTER this — so identity vars stripped here are
 * re-added with the correct per-spawn value, never the parent's stale one.
 *
 * Pure: never mutates `base`.
 */
export function sanitizeSpawnEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue
    if (NON_PREFIXED_INFRA.has(key)) continue
    if (key.startsWith('SLAYZONE_')) {
      // Fail closed: only an explicit `global` tag survives. infra/secret/
      // identity AND any unmanifested SLAYZONE_* are dropped.
      if (ENV_MANIFEST[key] === 'global') out[key] = value
      continue
    }
    out[key] = value
  }
  return out
}
