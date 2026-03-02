# Changelog


## v0.2.3

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.2.2...v0.2.3)

### 🚀 Enhancements

- **ccs:** CCS integration with profile dropdown ([7f03312](https://github.com/debuglebowski/SlayZone/commit/7f03312))
- **projects:** Execution context (host/docker/ssh) ([8910a0e](https://github.com/debuglebowski/SlayZone/commit/8910a0e))

### ❤️ Contributors

- Debuglebowski

## v0.2.2

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.2.1...v0.2.2)

### 🩹 Fixes

- **undo:** Use functional updater in completion undo to avoid stale task snapshot ([358caad](https://github.com/debuglebowski/SlayZone/commit/358caad))
- **test-utils:** Add missing better-sqlite3 dep for typecheck ([98974a9](https://github.com/debuglebowski/SlayZone/commit/98974a9))
- **typecheck:** Replace import.meta.env.DEV with false in domain packages ([b2fa65d](https://github.com/debuglebowski/SlayZone/commit/b2fa65d))
- **types:** Add ImportMeta.env types to shared global.d.ts ([fe1fe0a](https://github.com/debuglebowski/SlayZone/commit/fe1fe0a))
- **task:** Kill task processes on archive/purge ([323d735](https://github.com/debuglebowski/SlayZone/commit/323d735))

### ❤️ Contributors

- Debuglebowski

## v0.2.1

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- **ui:** Add IconButton with required aria-label, migrate all icon buttons ([7721d22](https://github.com/debuglebowski/SlayZone/commit/7721d22))
- **worktrees:** .slay/worktree-setup.sh convention + source branch ([94ac2e0](https://github.com/debuglebowski/SlayZone/commit/94ac2e0))
- Undo/redo system for task mutations ([ba4e8b6](https://github.com/debuglebowski/SlayZone/commit/ba4e8b6))
- **settings:** Light/dark/system theme selector + light theme polish ([dc2c269](https://github.com/debuglebowski/SlayZone/commit/dc2c269))
- **task:** Add Settings panel header matching other panel headers ([acfd862](https://github.com/debuglebowski/SlayZone/commit/acfd862))

### 🩹 Fixes

- **cli:** Cross-platform esbuild build script ([fc9897e](https://github.com/debuglebowski/SlayZone/commit/fc9897e))
- **terminal:** Auto-detect Codex session ID from disk ([fddb4d0](https://github.com/debuglebowski/SlayZone/commit/fddb4d0))
- **worktrees:** Strip "Command failed" prefix from execGit errors ([4ad5ef6](https://github.com/debuglebowski/SlayZone/commit/4ad5ef6))
- **db:** Make v51 migration idempotent for drifted DBs ([ce306e7](https://github.com/debuglebowski/SlayZone/commit/ce306e7))

### 💅 Refactors

- **ai-config:** Extract shared sync components, fix sync bugs, improve nav ([cd1e02c](https://github.com/debuglebowski/SlayZone/commit/cd1e02c))

### 🏡 Chore

- **ci:** Add typecheck + build CI workflow, gate releases on typecheck ([fafffb8](https://github.com/debuglebowski/SlayZone/commit/fafffb8))

### ✅ Tests

- **db:** Add worktree source branch migration test ([ca9e430](https://github.com/debuglebowski/SlayZone/commit/ca9e430))

### ❤️ Contributors

- Debuglebowski

## v0.2.0

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.69...v0.2.0)

### 🚀 Enhancements

- Auto-switch project when activating task tab ([bbeb01e](https://github.com/debuglebowski/SlayZone/commit/bbeb01e))
- Cmd+R reloads browser webview when focused ([2579a57](https://github.com/debuglebowski/SlayZone/commit/2579a57))
- **cli:** Browser control via `slay tasks browser` commands ([bf89238](https://github.com/debuglebowski/SlayZone/commit/bf89238))
- Implement customizable task status workflows ([c7d059e](https://github.com/debuglebowski/SlayZone/commit/c7d059e))
- Stage/unstage folders in git diff panel ([6933377](https://github.com/debuglebowski/SlayZone/commit/6933377))
- Add discard button to unstaged folder rows ([78822fc](https://github.com/debuglebowski/SlayZone/commit/78822fc))
- Allow discarding untracked files via git clean ([26bcbd0](https://github.com/debuglebowski/SlayZone/commit/26bcbd0))
- **website:** Comparison page, glitter waterfall, mobile responsive ([6ecfd4e](https://github.com/debuglebowski/SlayZone/commit/6ecfd4e))
- Gate context manager behind dev flag ([d084346](https://github.com/debuglebowski/SlayZone/commit/d084346))
- **ai-config:** Harden sync behavior and provider capabilities ([c0318b2](https://github.com/debuglebowski/SlayZone/commit/c0318b2))
- **ai-config:** Add flat project context manager and files view ([4b117e2](https://github.com/debuglebowski/SlayZone/commit/4b117e2))
- **tasks:** Support project-defined status semantics ([0f7d246](https://github.com/debuglebowski/SlayZone/commit/0f7d246))
- **notifications:** Group attention tasks by project status labels ([2dd25e2](https://github.com/debuglebowski/SlayZone/commit/2dd25e2))
- **settings:** Load and persist renderer theme preference ([7e6cef4](https://github.com/debuglebowski/SlayZone/commit/7e6cef4))
- **website:** Easter eggs + 404 terminal page ([c776524](https://github.com/debuglebowski/SlayZone/commit/c776524))
- **cli:** Add projects create with auto path creation ([288a2d0](https://github.com/debuglebowski/SlayZone/commit/288a2d0))
- **website:** Developer Suffering Index benchmark section ([373c386](https://github.com/debuglebowski/SlayZone/commit/373c386))
- **ai-config:** Context manager overhaul — remove commands, inline diff, manual sync ([4323c9a](https://github.com/debuglebowski/SlayZone/commit/4323c9a))
- **processes:** Scope processes per project instead of global ([4bf0a6e](https://github.com/debuglebowski/SlayZone/commit/4bf0a6e))
- **worktrees:** Confirmation modals for git diff destructive actions ([53382d6](https://github.com/debuglebowski/SlayZone/commit/53382d6))
- **ai-config:** Per-provider skill file sync + e2e tests ([deeca01](https://github.com/debuglebowski/SlayZone/commit/deeca01))

### 🩹 Fixes

- **usage:** Actionable error messages in rate-limit popover ([4ce4da3](https://github.com/debuglebowski/SlayZone/commit/4ce4da3))
- Cmd+R reloads app when browser panel not focused ([73065ad](https://github.com/debuglebowski/SlayZone/commit/73065ad))
- Align kanban status order with workflow categories ([269c884](https://github.com/debuglebowski/SlayZone/commit/269c884))
- **main:** Support node runtime fallbacks for credentials and diagnostics ([2b74e52](https://github.com/debuglebowski/SlayZone/commit/2b74e52))
- **ai-config:** Normalize skill sync paths across providers ([36c2d92](https://github.com/debuglebowski/SlayZone/commit/36c2d92))
- Add vite/client and node types to tsconfig.base ([42ad28a](https://github.com/debuglebowski/SlayZone/commit/42ad28a))
- **leaderboard:** Guard useQuery behind ConvexProvider check ([083ed01](https://github.com/debuglebowski/SlayZone/commit/083ed01))
- **website:** Move benchmark footnote below card ([2714bf2](https://github.com/debuglebowski/SlayZone/commit/2714bf2))
- **processes:** Ignore stale exit events on restart ([d2e6999](https://github.com/debuglebowski/SlayZone/commit/d2e6999))
- **browser:** Stale ref race losing non-main tab URLs ([8c97b62](https://github.com/debuglebowski/SlayZone/commit/8c97b62))
- **terminal:** Auto-detect Codex session ID from disk ([c83aa6b](https://github.com/debuglebowski/SlayZone/commit/c83aa6b))

### 💅 Refactors

- **settings:** Reorder global settings tabs by usage frequency ([cac7cf4](https://github.com/debuglebowski/SlayZone/commit/cac7cf4))
- **tasks:** Per-view-mode filter/display persistence ([053e6fa](https://github.com/debuglebowski/SlayZone/commit/053e6fa))
- **tasks:** Remove filter pills, auto-width filter popover ([58c73d6](https://github.com/debuglebowski/SlayZone/commit/58c73d6))
- **website:** Partials build system to eliminate HTML duplication ([06cc10f](https://github.com/debuglebowski/SlayZone/commit/06cc10f))

### 📖 Documentation

- Branch tab concept for git panel ([2db6631](https://github.com/debuglebowski/SlayZone/commit/2db6631))
- **comparison:** Expand devin research and update matrix ([8a2db1d](https://github.com/debuglebowski/SlayZone/commit/8a2db1d))
- **comparison:** Expand competitor evaluations and update website matrix ([5a53a58](https://github.com/debuglebowski/SlayZone/commit/5a53a58))
- Overhaul website and comprehensive usage guide ([6c3b0e9](https://github.com/debuglebowski/SlayZone/commit/6c3b0e9))

### 🏡 Chore

- Update pnpm-lock.yaml ([25f46dc](https://github.com/debuglebowski/SlayZone/commit/25f46dc))
- Add skills, remove stale config files ([c5a0ba3](https://github.com/debuglebowski/SlayZone/commit/c5a0ba3))
- Pin packageManager, refresh lockfile ([b6ad7cc](https://github.com/debuglebowski/SlayZone/commit/b6ad7cc))
- **settings:** Add tab titles and concise descriptions ([43698c7](https://github.com/debuglebowski/SlayZone/commit/43698c7))
- **db:** Add ai-config migrations and slug migration test ([1f8aa8f](https://github.com/debuglebowski/SlayZone/commit/1f8aa8f))
- **labels:** Remove CLI suffix from codex and gemini names ([c79e667](https://github.com/debuglebowski/SlayZone/commit/c79e667))
- Tidy minor comments and dependency ordering ([9ad3d10](https://github.com/debuglebowski/SlayZone/commit/9ad3d10))
- **ui:** Add diff dependency ([e6c14c8](https://github.com/debuglebowski/SlayZone/commit/e6c14c8))

### ✅ Tests

- **e2e:** Cover context manager sync workflows ([7e0c4ec](https://github.com/debuglebowski/SlayZone/commit/7e0c4ec))
- **e2e:** Align project flows with single-project selection ([29d36fe](https://github.com/debuglebowski/SlayZone/commit/29d36fe))
- **worktrees:** Replace hardcoded user paths with generic fixtures ([4c47cac](https://github.com/debuglebowski/SlayZone/commit/4c47cac))

### 🎨 Styles

- Polish task statuses settings visuals ([7232b35](https://github.com/debuglebowski/SlayZone/commit/7232b35))
- Change panel focus shadow from orange to white ([63e2813](https://github.com/debuglebowski/SlayZone/commit/63e2813))

### ❤️ Contributors

- Debuglebowski

## v0.1.69

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.68...v0.1.69)

### 🚀 Enhancements

- **onboarding:** Add data responsibility disclaimer + refine analytics copy ([ca5eaf8](https://github.com/debuglebowski/SlayZone/commit/ca5eaf8))
- **worktrees:** Improve git diff empty states ([8222ced](https://github.com/debuglebowski/SlayZone/commit/8222ced))
- **worktrees:** Add Initialize Git empty state to ProjectGeneralTab ([33cb442](https://github.com/debuglebowski/SlayZone/commit/33cb442))
- **home:** Panel shortcuts + Cmd+G/Shift+G like task ([9c74a28](https://github.com/debuglebowski/SlayZone/commit/9c74a28))
- Project color tint on tabs, task detail, and kanban ([f5a3a86](https://github.com/debuglebowski/SlayZone/commit/f5a3a86))
- **startup:** Parallel splash + populated app on show ([8bb3b0a](https://github.com/debuglebowski/SlayZone/commit/8bb3b0a))
- **browser:** Per-tab theme toggle (system/dark/light) ([2c96d2f](https://github.com/debuglebowski/SlayZone/commit/2c96d2f))
- **settings:** Appearance tab with font sizes + reduce motion ([485d163](https://github.com/debuglebowski/SlayZone/commit/485d163))
- **sidebar:** Prefer capital letters for project abbreviations ([7854647](https://github.com/debuglebowski/SlayZone/commit/7854647))
- **settings:** Labs tab with leaderboard toggle ([13c7ee7](https://github.com/debuglebowski/SlayZone/commit/13c7ee7))
- **updater:** Periodic update check every 4 hours ([03cadf0](https://github.com/debuglebowski/SlayZone/commit/03cadf0))
- In-app changelog modal with auto-open on version upgrade ([795b30e](https://github.com/debuglebowski/SlayZone/commit/795b30e))
- Tutorial animation modal replacing driver.js ([1c842df](https://github.com/debuglebowski/SlayZone/commit/1c842df))
- **browser:** Add hard reload and reload context menu ([e5d006c](https://github.com/debuglebowski/SlayZone/commit/e5d006c))
- **usage:** Configurable inline usage bars via pin toggles ([3990f54](https://github.com/debuglebowski/SlayZone/commit/3990f54))
- **file-editor:** Global search across project files ([43f4b34](https://github.com/debuglebowski/SlayZone/commit/43f4b34))
- **notifications:** Add count badge to bell icon ([13eeb36](https://github.com/debuglebowski/SlayZone/commit/13eeb36))
- **terminal:** Click active terminal in popover to navigate to task ([f55e763](https://github.com/debuglebowski/SlayZone/commit/f55e763))
- **onboarding:** Show tour prompt to existing users on upgrade ([7ddf3d8](https://github.com/debuglebowski/SlayZone/commit/7ddf3d8))
- Add Cmd+P and Cmd+Shift+F shortcuts to home tab ([266640d](https://github.com/debuglebowski/SlayZone/commit/266640d))
- **task:** Focus and select title on temp-to-task conversion ([50089ec](https://github.com/debuglebowski/SlayZone/commit/50089ec))
- **web-panels:** Add per-panel desktop handoff policy and config migration ([28c47bf](https://github.com/debuglebowski/SlayZone/commit/28c47bf))

### 🩹 Fixes

- **terminal:** Use platform-appropriate command syntax on Windows ([f74c338](https://github.com/debuglebowski/SlayZone/commit/f74c338))
- **home:** Stable panel toggle layout + disabled states ([afc813f](https://github.com/debuglebowski/SlayZone/commit/afc813f))
- **worktrees:** Replace FileSlash with FileMinus (lucide-react) ([292f882](https://github.com/debuglebowski/SlayZone/commit/292f882))
- **sidebar:** Rename Tutorial tooltip to Onboarding ([1ae07de](https://github.com/debuglebowski/SlayZone/commit/1ae07de))
- **integrations:** Use correct GraphQL query to list projects by team in Linear ([36174a6](https://github.com/debuglebowski/SlayZone/commit/36174a6))
- **windows:** Stabilize shell, env, and git for win32 ([a9ca6f7](https://github.com/debuglebowski/SlayZone/commit/a9ca6f7))
- **leaderboard:** Self-guard Convex hooks, remove prop-threading ([c2ee734](https://github.com/debuglebowski/SlayZone/commit/c2ee734))
- **renderer:** Enable window dragging from tab bar area ([71c886f](https://github.com/debuglebowski/SlayZone/commit/71c886f))
- **file-editor:** Cmd+Shift+F opens editor panel before toggling search ([e72f2ca](https://github.com/debuglebowski/SlayZone/commit/e72f2ca))
- **sidebar:** Update tour, changelog, onboarding icons ([b1dd585](https://github.com/debuglebowski/SlayZone/commit/b1dd585))
- **ui:** Add spacing between usage bars and header buttons ([af34d1d](https://github.com/debuglebowski/SlayZone/commit/af34d1d))
- **ui:** Fix JSX comment syntax in TabBar return ([f1d2ef0](https://github.com/debuglebowski/SlayZone/commit/f1d2ef0))
- Deduplicate zod via pnpm override ([19f8289](https://github.com/debuglebowski/SlayZone/commit/19f8289))
- **ui:** Fix TS errors in NotificationPopover and SceneGit ([81c86b4](https://github.com/debuglebowski/SlayZone/commit/81c86b4))
- **handoff:** Block encoded + loopback desktop handoff paths ([1cba6b4](https://github.com/debuglebowski/SlayZone/commit/1cba6b4))

### 💅 Refactors

- Remove device emulation from web panels ([a539f84](https://github.com/debuglebowski/SlayZone/commit/a539f84))
- **usage:** Pin toggles as sole inline bar control, enforce min 1 ([869b846](https://github.com/debuglebowski/SlayZone/commit/869b846))
- Extract postinstall into script file ([c99354d](https://github.com/debuglebowski/SlayZone/commit/c99354d))
- **app:** Unify webview desktop-handoff hardening script ([122c74f](https://github.com/debuglebowski/SlayZone/commit/122c74f))

### 📖 Documentation

- Make star history image full width ([18b1c81](https://github.com/debuglebowski/SlayZone/commit/18b1c81))

### 🏡 Chore

- Add Apache 2.0 license ([8bab2bf](https://github.com/debuglebowski/SlayZone/commit/8bab2bf))
- Add react-icons dependency ([01837d5](https://github.com/debuglebowski/SlayZone/commit/01837d5))
- **e2e:** Harden fixture sidebar and settings click helpers ([82dc769](https://github.com/debuglebowski/SlayZone/commit/82dc769))

### ✅ Tests

- **handoff:** Add unit and e2e coverage for routing behavior ([250b8b3](https://github.com/debuglebowski/SlayZone/commit/250b8b3))

### ❤️ Contributors

- Debuglebowski
- Arvidsson-geins
- David Gundry

## v0.1.62...v0.1.68

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.62...v0.1.68)

### 🚀 Enhancements

- **cli:** Add slay CLI with DB watcher and install UI ([4345619](https://github.com/debuglebowski/SlayZone/commit/4345619))
- **cli:** Add update, archive, delete, open, projects list ([a73d5e0](https://github.com/debuglebowski/SlayZone/commit/a73d5e0))
- **cli:** Add processes list and logs commands ([5f4608f](https://github.com/debuglebowski/SlayZone/commit/5f4608f))
- **app:** Allow multiple global panels active simultaneously ([a051b2a](https://github.com/debuglebowski/SlayZone/commit/a051b2a))
- **cli:** Add subtasks, search, kill, follow, completions + auto-scoping ([e011d2a](https://github.com/debuglebowski/SlayZone/commit/e011d2a))
- **diagnostics:** Separate diagnostics DB to avoid watchDatabase conflicts ([de75eff](https://github.com/debuglebowski/SlayZone/commit/de75eff))
- **app:** Multi-panel home tab, ResizeHandle cleanup, PTY dispose on exit ([6b35695](https://github.com/debuglebowski/SlayZone/commit/6b35695))
- **ui:** Add tooltips to panels, settings, and task controls ([b771e70](https://github.com/debuglebowski/SlayZone/commit/b771e70))

### 🩹 Fixes

- **cli:** Replace watchDatabase polling with REST notify ([b33ab51](https://github.com/debuglebowski/SlayZone/commit/b33ab51))
- **app:** Dynamic remote-debug port, mcp port try-catch, rm stale watchDatabase comments ([9a6be73](https://github.com/debuglebowski/SlayZone/commit/9a6be73))
- **ui:** Uniform h-10 panel headers, add border-border + bg-surface-1 ([58ccba4](https://github.com/debuglebowski/SlayZone/commit/58ccba4))
- **ci:** Use random keychain password to unblock codesign ([42508fc](https://github.com/debuglebowski/SlayZone/commit/42508fc))
- **ci:** Use CSC_LINK for signing, add hardenedRuntime ([94b138f](https://github.com/debuglebowski/SlayZone/commit/94b138f))
- **ci:** Fix YAML indentation ([e930817](https://github.com/debuglebowski/SlayZone/commit/e930817))
- **ci:** Restore proper keychain setup with random password + partition list ([001cb30](https://github.com/debuglebowski/SlayZone/commit/001cb30))
- **ci:** Add 30min timeout to package and publish step ([b9c77b7](https://github.com/debuglebowski/SlayZone/commit/b9c77b7))
- Restore workspace deps accidentally stripped during local test ([1a03e16](https://github.com/debuglebowski/SlayZone/commit/1a03e16))

### 💅 Refactors

- **worktrees:** Unify home+task git panels, share panel sizes ([f04d218](https://github.com/debuglebowski/SlayZone/commit/f04d218))

### 🏡 Chore

- Add macOS code signing and notarization ([3714c06](https://github.com/debuglebowski/SlayZone/commit/3714c06))
- Build CLI in CI, fix notarize config ([e640607](https://github.com/debuglebowski/SlayZone/commit/e640607))
- Update lockfile for v0.1.67 ([1d72550](https://github.com/debuglebowski/SlayZone/commit/1d72550))
- Disable notarization until Apple clears new account queue ([317548f](https://github.com/debuglebowski/SlayZone/commit/317548f))

### ❤️ Contributors

- Debuglebowski

## v0.1.62...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.62...main)

### 🚀 Enhancements

- **cli:** Add slay CLI with DB watcher and install UI ([4345619](https://github.com/debuglebowski/SlayZone/commit/4345619))
- **cli:** Add update, archive, delete, open, projects list ([a73d5e0](https://github.com/debuglebowski/SlayZone/commit/a73d5e0))
- **cli:** Add processes list and logs commands ([5f4608f](https://github.com/debuglebowski/SlayZone/commit/5f4608f))
- **app:** Allow multiple global panels active simultaneously ([a051b2a](https://github.com/debuglebowski/SlayZone/commit/a051b2a))
- **cli:** Add subtasks, search, kill, follow, completions + auto-scoping ([e011d2a](https://github.com/debuglebowski/SlayZone/commit/e011d2a))
- **diagnostics:** Separate diagnostics DB to avoid watchDatabase conflicts ([de75eff](https://github.com/debuglebowski/SlayZone/commit/de75eff))
- **app:** Multi-panel home tab, ResizeHandle cleanup, PTY dispose on exit ([6b35695](https://github.com/debuglebowski/SlayZone/commit/6b35695))
- **ui:** Add tooltips to panels, settings, and task controls ([b771e70](https://github.com/debuglebowski/SlayZone/commit/b771e70))

### 🩹 Fixes

- **cli:** Replace watchDatabase polling with REST notify ([b33ab51](https://github.com/debuglebowski/SlayZone/commit/b33ab51))
- **app:** Dynamic remote-debug port, mcp port try-catch, rm stale watchDatabase comments ([9a6be73](https://github.com/debuglebowski/SlayZone/commit/9a6be73))

### 💅 Refactors

- **worktrees:** Unify home+task git panels, share panel sizes ([f04d218](https://github.com/debuglebowski/SlayZone/commit/f04d218))

### 🏡 Chore

- Add macOS code signing and notarization ([3714c06](https://github.com/debuglebowski/SlayZone/commit/3714c06))

### ❤️ Contributors

- Debuglebowski




## v0.1.61...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.61...main)

### 🩹 Fixes

- **ci:** Commit convex _generated types for build typecheck ([7cbd9e6](https://github.com/debuglebowski/SlayZone/commit/7cbd9e6))

### ❤️ Contributors

- Debuglebowski




## v0.1.60...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.60...main)

### 🩹 Fixes

- **ci:** Add @types/node to root and convex tsconfig for process.env ([2c3728f](https://github.com/debuglebowski/SlayZone/commit/2c3728f))

### ❤️ Contributors

- Debuglebowski




## v0.1.59...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.59...main)

### 🩹 Fixes

- **ci:** Add @auth/core to root deps for convex deploy ([920eea1](https://github.com/debuglebowski/SlayZone/commit/920eea1))

### ❤️ Contributors

- Debuglebowski




## v0.1.58...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.58...main)

### 🩹 Fixes

- **ci:** Add @convex-dev/auth to root deps for convex deploy ([931caff](https://github.com/debuglebowski/SlayZone/commit/931caff))

### ❤️ Contributors

- Debuglebowski




## v0.1.57...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.57...main)

### 🩹 Fixes

- **ci:** Remove --prod flag from convex deploy ([84d2394](https://github.com/debuglebowski/SlayZone/commit/84d2394))

### ❤️ Contributors

- Debuglebowski




## v0.1.56...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.56...main)

### 🚀 Enhancements

- **mcp:** Add get_current_task_id and create_subtask tools ([1796cfc](https://github.com/debuglebowski/SlayZone/commit/1796cfc))
- **telemetry:** Make heartbeat foreground-aware and add active-time background event ([1a2bd62](https://github.com/debuglebowski/SlayZone/commit/1a2bd62))
- **task:** Add Processes panel for background process management ([422d3b0](https://github.com/debuglebowski/SlayZone/commit/422d3b0))
- **leaderboard:** Daily stats pipeline with ccusage + real Convex queries ([a4bed40](https://github.com/debuglebowski/SlayZone/commit/a4bed40))
- **task:** Processes panel UI polish + global/task scope toggle ([5945524](https://github.com/debuglebowski/SlayZone/commit/5945524))
- **leaderboard:** Show best rank on leaderboard tab badge ([7c50a89](https://github.com/debuglebowski/SlayZone/commit/7c50a89))
- **browser:** Inline Chromium DevTools panel ([1648428](https://github.com/debuglebowski/SlayZone/commit/1648428))
- **browser:** Highlight DevTools button when panel is open ([f023138](https://github.com/debuglebowski/SlayZone/commit/f023138))
- **processes:** Persistent processes with improved UI ([b86d987](https://github.com/debuglebowski/SlayZone/commit/b86d987))
- **processes:** Add ⌘O shortcut for processes panel; panel focus glow ([989e84f](https://github.com/debuglebowski/SlayZone/commit/989e84f))
- **ui:** Focused panel glow + borders ([9bd89b8](https://github.com/debuglebowski/SlayZone/commit/9bd89b8))
- **convex:** ForgetMe, path aliases, CSP github.com, gitignore ([fe89e5a](https://github.com/debuglebowski/SlayZone/commit/fe89e5a))
- **terminal:** Implement codex detectError ([0341906](https://github.com/debuglebowski/SlayZone/commit/0341906))
- **worktrees:** Show keyboard shortcuts on git panel tabs ([82a80c7](https://github.com/debuglebowski/SlayZone/commit/82a80c7))
- **ui:** Hide panel glow when only one panel visible ([9221bb1](https://github.com/debuglebowski/SlayZone/commit/9221bb1))

### 🩹 Fixes

- **browser:** Harden inline DevTools stability ([eaf49b7](https://github.com/debuglebowski/SlayZone/commit/eaf49b7))
- **ci:** Pipe jwt/jwks via stdin to avoid multiline CLI parse error ([114c537](https://github.com/debuglebowski/SlayZone/commit/114c537))
- **browser:** Minimize DevTools resize handle ([ac65e81](https://github.com/debuglebowski/SlayZone/commit/ac65e81))
- **leaderboard:** Npx ccusage, skip zero-token days, dev-only rank query ([c2b83a0](https://github.com/debuglebowski/SlayZone/commit/c2b83a0))
- **browser:** Remove native DevTools window button ([6725cd0](https://github.com/debuglebowski/SlayZone/commit/6725cd0))
- **browser:** Use Bug icon for DevTools toggle button ([297cb4c](https://github.com/debuglebowski/SlayZone/commit/297cb4c))
- **browser:** Reorder toolbar buttons to Import, Responsive, Select, DevTools ([c8f0962](https://github.com/debuglebowski/SlayZone/commit/c8f0962))
- **browser:** Remove did-navigate verification from popup suppression ([56a9504](https://github.com/debuglebowski/SlayZone/commit/56a9504))
- **browser:** Remove pre-warm to eliminate startup popup ([0e6edcb](https://github.com/debuglebowski/SlayZone/commit/0e6edcb))
- **browser:** Restore pre-warm and fix suppressPopup cleanup timing ([552975a](https://github.com/debuglebowski/SlayZone/commit/552975a))
- **terminal:** Prevent garbage injection from escape sequence responses ([ab08bd1](https://github.com/debuglebowski/SlayZone/commit/ab08bd1))

### 💅 Refactors

- **browser:** Clean up inline DevTools main process code ([927b103](https://github.com/debuglebowski/SlayZone/commit/927b103))
- **browser:** Improve DevTools sustainability ([be32c16](https://github.com/debuglebowski/SlayZone/commit/be32c16))

### 🏡 Chore

- Restore previously staged non-telemetry changes ([88d8ce0](https://github.com/debuglebowski/SlayZone/commit/88d8ce0))
- **ci:** Deploy Convex to prod on release + bake VITE_CONVEX_URL ([6ae8fd6](https://github.com/debuglebowski/SlayZone/commit/6ae8fd6))
- **ci:** Set JWT_PRIVATE_KEY and JWKS in Convex prod on deploy ([4eb2061](https://github.com/debuglebowski/SlayZone/commit/4eb2061))
- **ci:** Remove jwt/jwks from release workflow (one-time setup, not per-deploy) ([d5beac3](https://github.com/debuglebowski/SlayZone/commit/d5beac3))

### ✅ Tests

- **browser:** Add devtools e2e tests ([b1b35af](https://github.com/debuglebowski/SlayZone/commit/b1b35af))

### ❤️ Contributors

- Debuglebowski




## v0.1.55...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.55...main)




## v0.1.54...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.54...main)

### 🩹 Fixes

- **lockfile:** Sync app importer deps ([f7ba93a](https://github.com/debuglebowski/SlayZone/commit/f7ba93a))

### ❤️ Contributors

- Debuglebowski




## v0.1.52...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.52...main)

### 🩹 Fixes

- **app:** Add missing radix collapsible dependency ([98a7abf](https://github.com/debuglebowski/SlayZone/commit/98a7abf))

### 📖 Documentation

- Improve get started macOS instructions ([840bcb7](https://github.com/debuglebowski/SlayZone/commit/840bcb7))

### ❤️ Contributors

- Debuglebowski




## v0.1.51...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.51...main)

### 🚀 Enhancements

- **web-panel:** Add copy URL button ([5651bc7](https://github.com/debuglebowski/SlayZone/commit/5651bc7))
- **terminal:** Crash recovery, PATH enrichment, doctor validation ([5baa678](https://github.com/debuglebowski/SlayZone/commit/5baa678))
- **terminal:** Cmd+W closes focused pane, focuses adjacent pane/group ([5a9ea80](https://github.com/debuglebowski/SlayZone/commit/5a9ea80))
- **webview:** Block external app protocol launches ([aa08810](https://github.com/debuglebowski/SlayZone/commit/aa08810))
- **terminal:** Cmd+W closes task tab when sub-panel has nothing to close ([1d8a1a6](https://github.com/debuglebowski/SlayZone/commit/1d8a1a6))
- Update keyboard shortcuts modal ([e591aaa](https://github.com/debuglebowski/SlayZone/commit/e591aaa))

### 🩹 Fixes

- **terminal:** Fish PATH, unsupported shell doctor feedback, remove shell setting ([79a8da3](https://github.com/debuglebowski/SlayZone/commit/79a8da3))
- **kanban:** Ring only on keyboard focus, not hover ([600ebb4](https://github.com/debuglebowski/SlayZone/commit/600ebb4))
- **webview:** Remove preload-based window.open patching, rely on protocol handler ([4543ef2](https://github.com/debuglebowski/SlayZone/commit/4543ef2))

### ❤️ Contributors

- Debuglebowski




## v0.1.50...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.50...main)

### 🩹 Fixes

- Push specific tag instead of all tags on release ([f2bc8db](https://github.com/debuglebowski/SlayZone/commit/f2bc8db))
- Surface update errors to UI, show download progress ([262706a](https://github.com/debuglebowski/SlayZone/commit/262706a))

### ❤️ Contributors

- Debuglebowski




## v0.1.49...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.49...main)

### 📖 Documentation

- Second test change ([19edc26](https://github.com/debuglebowski/SlayZone/commit/19edc26))

### ❤️ Contributors

- Debuglebowski




## v0.1.48...main

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.1.48...main)

### 🩹 Fixes

- Release script guards + clean changelog generation ([626930e](https://github.com/debuglebowski/SlayZone/commit/626930e))

### 📖 Documentation

- Add trailing newline ([0038a3a](https://github.com/debuglebowski/SlayZone/commit/0038a3a))

### ❤️ Contributors

- Debuglebowski




## v0.1.47...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.47...main)

### 🚀 Enhancements

- **tasks:** Signal bar priority indicators on kanban cards ([f33bc8c](https://github.com/debuglebowski/omgslayzone/commit/f33bc8c))
- **ui:** Add scroll + thin scrollbar to keyboard shortcuts dialog ([4c64a90](https://github.com/debuglebowski/omgslayzone/commit/4c64a90))
- **task:** Replace in-progress modal with header button ([ce37d16](https://github.com/debuglebowski/omgslayzone/commit/ce37d16))
- **updater:** Show in-app toast when update downloaded ([4b25110](https://github.com/debuglebowski/omgslayzone/commit/4b25110))
- **file-editor:** Render image files in editor panel ([c9d7fcb](https://github.com/debuglebowski/omgslayzone/commit/c9d7fcb))
- **file-editor:** Drag-and-drop files/folders from Finder into editor ([7d9cdac](https://github.com/debuglebowski/omgslayzone/commit/7d9cdac))
- **terminal:** Split terminals into groups with drag-and-drop ([dd53716](https://github.com/debuglebowski/omgslayzone/commit/dd53716))
- **file-editor:** Drag-and-drop to move files/folders within tree ([e0a8279](https://github.com/debuglebowski/omgslayzone/commit/e0a8279))
- **browser:** Multi-device responsive preview + web panel emulation ([4e8068d](https://github.com/debuglebowski/omgslayzone/commit/4e8068d))

### 🩹 Fixes

- **task:** Align title padding and font with kanban header ([ce6fa15](https://github.com/debuglebowski/omgslayzone/commit/ce6fa15))
- **ui:** Add left padding in zen mode to match right/bottom ([08c3fc9](https://github.com/debuglebowski/omgslayzone/commit/08c3fc9))

### 📖 Documentation

- Add known bugs section and star history to README ([750003a](https://github.com/debuglebowski/omgslayzone/commit/750003a))
- Update known bugs list ([656dc14](https://github.com/debuglebowski/omgslayzone/commit/656dc14))
- Trim known bugs list ([59052ae](https://github.com/debuglebowski/omgslayzone/commit/59052ae))

### 🏡 Chore

- Add star history image to assets ([b66bf1e](https://github.com/debuglebowski/omgslayzone/commit/b66bf1e))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.46...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.46...main)

### 🩹 Fixes

- **file-editor:** Show gitignored files grayed out instead of hiding them ([62929e2](https://github.com/debuglebowski/omgslayzone/commit/62929e2))
- **ci:** Inject PostHog secrets into release build ([ed4dfc2](https://github.com/debuglebowski/omgslayzone/commit/ed4dfc2))

### 📖 Documentation

- **website:** Sync features with README, add status tracking ([a3b4a90](https://github.com/debuglebowski/omgslayzone/commit/a3b4a90))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.45...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.45...main)

### 🩹 Fixes

- **terminal:** Catch EBADF on PTY resize when fd is invalid ([9ee1d2f](https://github.com/debuglebowski/omgslayzone/commit/9ee1d2f))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.44...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.44...main)

### 🩹 Fixes

- Auto-updater restart — download before quitAndInstall, add dock progress ([9d0897f](https://github.com/debuglebowski/omgslayzone/commit/9d0897f))

### 💅 Refactors

- Remove checkAvailability + shell-path dependency ([56226fa](https://github.com/debuglebowski/omgslayzone/commit/56226fa))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.43...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.43...main)

### 🩹 Fixes

- CLI detection in prod — use full path + enrich PATH with common bin dirs ([b7440ab](https://github.com/debuglebowski/omgslayzone/commit/b7440ab))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.42...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.42...main)

### 🚀 Enhancements

- Add explode mode — grid view of all open task terminals ([7126a78](https://github.com/debuglebowski/omgslayzone/commit/7126a78))

### 🩹 Fixes

- Move shellPath() into checkAvailability to fix CLI detection without blocking startup ([77da6c5](https://github.com/debuglebowski/omgslayzone/commit/77da6c5))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.40...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.40...main)

### 🩹 Fixes

- Await shellPath() to fix CLI detection in production ([ca522d6](https://github.com/debuglebowski/omgslayzone/commit/ca522d6))
- Auto-updater CJS/ESM interop — use default import ([d5774c7](https://github.com/debuglebowski/omgslayzone/commit/d5774c7))

### 🏡 Chore

- Replace tsc with tsgo for typechecking (22s → 5s) ([fd98337](https://github.com/debuglebowski/omgslayzone/commit/fd98337))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.39...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.39...main)

### 🩹 Fixes

- Change Monosketch shortcut from Cmd+K to Cmd+U ([159cf09](https://github.com/debuglebowski/omgslayzone/commit/159cf09))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.38...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.38...main)

### 🩹 Fixes

- Update Monosketch panel URL to app.monosketch.io ([5a37d14](https://github.com/debuglebowski/omgslayzone/commit/5a37d14))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.37...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.37...main)

### 🩹 Fixes

- **tasks:** Add missing react-hotkeys-hook dependency ([903bccf](https://github.com/debuglebowski/omgslayzone/commit/903bccf))

### ❤️ Contributors

- Debuglebowski <>

## ...main

## v0.1.35...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.35...main)

### 🚀 Enhancements

- Add "Check for Updates" to app menu ([bfa6670](https://github.com/debuglebowski/omgslayzone/commit/bfa6670))

### 🩹 Fixes

- Disable auto-download on startup ([50c9bf2](https://github.com/debuglebowski/omgslayzone/commit/50c9bf2))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.34...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.34...main)

### 🩹 Fixes

- Add favicon to website ([886b767](https://github.com/debuglebowski/omgslayzone/commit/886b767))
- Allow Cmd+R reload in production ([5404504](https://github.com/debuglebowski/omgslayzone/commit/5404504))
- Restore user PATH in production, simplify Claude CLI check ([d9f8443](https://github.com/debuglebowski/omgslayzone/commit/d9f8443))

### 📖 Documentation

- MacOS Gatekeeper note in README ([6040e4a](https://github.com/debuglebowski/omgslayzone/commit/6040e4a))

### ❤️ Contributors

- Debuglebowski <>

## v0.1.31...main

[compare changes](https://github.com/debuglebowski/omgslayzone/compare/v0.1.31...main)

### 🩹 Fixes

- GitHub links on website → SlayZone/SlayZone ([2799cfd](https://github.com/debuglebowski/omgslayzone/commit/2799cfd))

### ❤️ Contributors

- Debuglebowski <>
