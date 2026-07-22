# SlayZone

You and I are developing SlayZone, a desktop task management app with integrated AI coding assistants (Claude Code, Codex, Gemini, and more).

You (this instance) is actually running inside SlayZone now. We are dogfooding SlayZone, i.e. using SlayZone to develop SlayZone.

You are able to interact with the running SlayZone application via the CLI. But **you MUST load the** **`slay`** **skill before running any** **`slay`** **CLI command.** Do not guess subcommands or flags — the skill has the full reference.

You can omit the task-id unless you want to target another task — commands auto-resolve to your current task: `$SLAYZONE_TASK_ID` is used if set, otherwise the task bound to `$SLAYZONE_SESSION_ID` (always set in a task terminal) is looked up. Trust the resolution: just run the command, don't check or echo the env vars, and pass an explicit task-id only when you deliberately target a different task.

## Communication Style

Default to **caveman ultra** mode for entire session. Load the `caveman` skill at session start. Skill's own boundaries (code/commits/PRs stay normal) still apply.

## Engineering Mindset

Assume near-infinite dev capability. Always pick most sustainable, robust long-term solution — never the quick hack. But **never drop existing functionality** to get there. Migrate, refactor, preserve behavior.

## Stack

* **Runtime**: Electron 41

* **Frontend**: React 19, TailwindCSS 4, Radix UI

* **Database**: SQLite (better-sqlite3)

* **Backend**: Convex (cloud), Express (local API)

* **Terminal**: node-pty, xterm.js

* **AI**: Claude Code, Codex, Gemini, Cursor, OpenCode, Copilot, Qwen + custom modes

* **Protocols**: MCP (Model Context Protocol)

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system architecture and [PHILOSOPHY.md](./PHILOSOPHY.md) for structural principles.

## Commands

| Command          | Purpose                        |
| ---------------- | ------------------------------ |
| `pnpm dev`       | Start dev server               |
| `pnpm build`     | Build for production           |
| `pnpm build:mac` | Build macOS .app               |
| `pnpm typecheck` | Typecheck all packages         |
| `pnpm test:e2e`  | Run E2E tests (requires build) |
| `pnpm lint`      | Lint all packages              |

## Dev Env Flags

Opt-in env vars for `pnpm dev`. Set inline: `FLAG=1 pnpm dev`.

| Flag                            | Default | Effect                                                                                                       |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `SLAYZONE_REACT_DEV=1`          | off     | Use React's **development** build instead of the prod-aliased dev default. Re-enables StrictMode + warnings. |
| `SLAYZONE_PROFILE=1`            | off     | Swap to React's profiling builds so `<Profiler>` fires `onRender`. Required by `e2e/perf/scenarios.spec.ts`. |
| `SLAYZONE_DEBUG_BOOT=1`         | off     | Verbose main-process boot logging.                                                                           |
| `SLAYZONE_REGISTER_DEV_PROTOCOL=1` | off  | Register the `slayzone://` custom protocol in dev. Needed when testing OAuth deep-link callbacks.            |
| `SLAYZONE_SIDECAR_HOT_RESTART=1`   | off  | Dev-only. Supervisor hot-restarts the sidecar when its on-disk build changes (server-src watcher rebuilds `bin.cjs`). Off = staleness only shown in Diagnostics tab, no auto-restart. `pnpm dev` always runs the server watcher regardless. |

**React transform**: Babel + `babel-plugin-react-compiler` in all modes (dev + prod). Auto-memoization active everywhere; compiler rule violations surface at build time.

**React prod in dev**: `pnpm dev` runs React's production build via a single lever — `optimizeDeps.esbuildOptions.define` sets `NODE_ENV=production` so the pre-bundled `react`/`react-dom` chunks resolve to `cjs/*.production`. Source + every pre-bundled dep share that one optimized React instance. Paired with `esbuild.jsxDev:false` (emit `jsx`, not `jsxDEV`, since the prod define stubs `jsx-dev-runtime`). **Do NOT** alias `react/*` to on-disk cjs files (serves source a 2nd React copy → dual dispatcher → `useMemo` null in ConvexAuthProvider) and **do NOT** add a top-level `define: process.env.NODE_ENV` (stubs the react-refresh runtime). `import.meta.env.DEV`/`__DEV__` stay `true`. `SLAYZONE_REACT_DEV=1` opts out; `SLAYZONE_PROFILE=1` overrides.

**HMR in dev**: channel kept enabled. Under prod React, react-refresh is an inert no-op (prod react-dom omits `scheduleRefresh` → no targeted hot-reload, never throws), but the channel is required for Vite's full-reload on dep re-optimize — without it, a runtime re-optimize leaves mixed dep-hash modules → multiple React copies. File changes trigger full page reload.

## Theming

All colors must reference theme tokens. Never use raw Tailwind palette classes (`bg-neutral-*`, `text-zinc-*`, `border-gray-*`) or arbitrary hex (`bg-[#1a1a1a]`) — they bypass the theme and break under custom themes.

Token map:

* Surfaces: `bg-background`, `bg-surface-0/1/2/3`, `bg-card`, `bg-popover`, `bg-sidebar`

* Controls: `bg-accent`, `bg-muted`, `bg-primary`, `bg-secondary`, `bg-destructive`

* Active tab: `bg-tab-active`

* Text: `text-foreground`, `text-muted-foreground`, `text-*-foreground` (paired)

* Borders: `border-border`, `border-input`, `border-ring`

* Inputs: `bg-input` (alpha overlay, context-aware)

Form surfaces (`SelectTrigger`, `Input`, `Button variant="outline"`) use `dark:bg-input/30` alpha overlay — auto-tints parent. Don't override with solid colors.

`pnpm lint:theme` enforces — runs in `pnpm lint`. Tutorial scenes + project-color palette are excluded.

## Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/):

| Prefix      | Use for                                 |
| ----------- | --------------------------------------- |
| `feat:`     | New features                            |
| `fix:`      | Bug fixes                               |
| `chore:`    | Deps, CI, build, config                 |
| `refactor:` | Code restructuring (no behavior change) |
| `docs:`     | Documentation                           |
| `test:`     | Tests                                   |
| `release:`  | Version bumps (auto-generated)          |

Scope optional: `feat(terminal): ...`

## E2E Testing Rules

* **TDD**: Always run tests FIRST to see them fail, then fix code. Never write tests alongside code and assume they pass.

* **useRef + useEffect for DOM measurement**: If a component has early returns (loading/null guards) before the measured element, `useEffect([], [])` runs when the ref is still null. Use a **callback ref** instead.

* **Hook lifecycle across tabs**: Hooks' `useEffect` only runs on mount. Tabs stay mounted with `display: none` — seeding settings and navigating doesn't re-trigger effects. Test by opening a NEW task (fresh hook mount).
