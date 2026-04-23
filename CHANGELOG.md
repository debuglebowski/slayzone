# Changelog


## v0.22.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.21.0...v0.22.0)

### 🚀 Enhancements

- **task:** Add progress field (0-100) w/ UI + CLI ([723f6de2](https://github.com/debuglebowski/slayzone/commit/723f6de2))
- **skills:** Resync builtin skills + expand CLI reference ([dfa7d72f](https://github.com/debuglebowski/slayzone/commit/dfa7d72f))
- **app:** Hide task tabs + show count in explode mode ([b733bf6b](https://github.com/debuglebowski/slayzone/commit/b733bf6b))
- **labs:** Gate Agent panel rename behind labs flag ([8656ceda](https://github.com/debuglebowski/slayzone/commit/8656ceda))
- **tasks:** Persist manager_mode per task + recursive subtask query ([70943e00](https://github.com/debuglebowski/slayzone/commit/70943e00))
- **task-terminals:** Agent overview sidebar + manager-mode orchestrator ([ab157dd5](https://github.com/debuglebowski/slayzone/commit/ab157dd5))
- **task-terminals:** Agent sidebar polish — tree lines, status, progress ([1c14b4a8](https://github.com/debuglebowski/slayzone/commit/1c14b4a8))
- **cli:** Slay init wrapper — instructions + skills bootstrap ([b4952aa7](https://github.com/debuglebowski/slayzone/commit/b4952aa7))
- **task-terminals:** Agent sidebar row context menu ([c1554457](https://github.com/debuglebowski/slayzone/commit/c1554457))
- **kanban:** Progress ring around blob, gray fallback ([9cd4d573](https://github.com/debuglebowski/slayzone/commit/9cd4d573))
- **task-terminals:** Hide terminal during agent overview resize ([d682360f](https://github.com/debuglebowski/slayzone/commit/d682360f))
- **assets-panel:** Persist folder expanded state per task ([17738d94](https://github.com/debuglebowski/slayzone/commit/17738d94))

### 🩹 Fixes

- **cli:** Hint alt DB when openDb misses ([35bbdcb9](https://github.com/debuglebowski/slayzone/commit/35bbdcb9))
- **app:** Anchor overlay views in explode mode ([408c95e1](https://github.com/debuglebowski/slayzone/commit/408c95e1))
- **renderer:** Allow blob workers in CSP for Vite HMR ([5de14de9](https://github.com/debuglebowski/slayzone/commit/5de14de9))
- **file-editor:** Close/flag tabs when underlying file deleted ([0c63dbf5](https://github.com/debuglebowski/slayzone/commit/0c63dbf5))
- **ai-config:** Scrub orphan marketplace metadata on seed ([e9286eca](https://github.com/debuglebowski/slayzone/commit/e9286eca))

### 💅 Refactors

- **ui:** Rename Terminal panel label to Agent ([dbf7755d](https://github.com/debuglebowski/slayzone/commit/dbf7755d))

### 📖 Documentation

- **cli:** Slay init — rewrite INSTRUCTIONS ([8ae04c02](https://github.com/debuglebowski/slayzone/commit/8ae04c02))
- **release:** Add auto-title step ([c28ab443](https://github.com/debuglebowski/slayzone/commit/c28ab443))

### 🏡 Chore

- **skills:** Resync builtin slay skill docs + register sync-slay-skill ([3e5d6a93](https://github.com/debuglebowski/slayzone/commit/3e5d6a93))

### ❤️ Contributors

- Debuglebowski

## v0.21.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.20.0...v0.21.0)

### 🚀 Enhancements

- **theme:** Reskin slay dark Ghostty-inspired with white text ([8796a0c1](https://github.com/debuglebowski/slayzone/commit/8796a0c1))
- **cli:** Open asset in UI after create/upload ([9d24090d](https://github.com/debuglebowski/slayzone/commit/9d24090d))
- **editor:** Auto-expand compacted folders to first branch point ([d7ed28e4](https://github.com/debuglebowski/slayzone/commit/d7ed28e4))
- **git:** Add stash tab to unified git panel ([a5c7ef72](https://github.com/debuglebowski/slayzone/commit/a5c7ef72))
- **projects:** Toast when locked project blocks new tabs ([39aef83f](https://github.com/debuglebowski/slayzone/commit/39aef83f))
- **web-panels:** Migrate from webview to WebContentsView ([f3af76b5](https://github.com/debuglebowski/slayzone/commit/f3af76b5))
- **processes:** Show server URL pill, move pills to bottom ([ecca533e](https://github.com/debuglebowski/slayzone/commit/ecca533e))
- **zen-mode:** Add icon toggle, hide task header ([03cf1c33](https://github.com/debuglebowski/slayzone/commit/03cf1c33))
- **processes:** URL pill opens in browser panel ([5cb9319e](https://github.com/debuglebowski/slayzone/commit/5cb9319e))
- **website:** Add og-preview.jpg + build:og script ([c2b572b1](https://github.com/debuglebowski/slayzone/commit/c2b572b1))
- **website:** Add Features + Comparison to nav ([92172873](https://github.com/debuglebowski/slayzone/commit/92172873))
- **skills:** Add slay-orchestrate local skill ([5dc862ee](https://github.com/debuglebowski/slayzone/commit/5dc862ee))
- **website:** JSON-LD SoftwareApplication schema on homepage ([3ead33d8](https://github.com/debuglebowski/slayzone/commit/3ead33d8))
- **website:** Tighten meta descriptions for AI-search queries ([952bc25d](https://github.com/debuglebowski/slayzone/commit/952bc25d))
- **website:** Add FAQPage JSON-LD on /faq ([7cfa0420](https://github.com/debuglebowski/slayzone/commit/7cfa0420))
- **website:** Add llms.txt endpoint for AI crawlers ([f5dd5541](https://github.com/debuglebowski/slayzone/commit/f5dd5541))
- **task:** Copy task ID button in settings header ([a946a131](https://github.com/debuglebowski/slayzone/commit/a946a131))
- **task:** Enrich explode-mode header ([3baa6274](https://github.com/debuglebowski/slayzone/commit/3baa6274))
- **task:** Reparent tasks via update (CLI + MCP + UI) ([7ea63b6d](https://github.com/debuglebowski/slayzone/commit/7ea63b6d))
- **task:** In-asset search highlight + jump in both raw and preview ([4e5ce340](https://github.com/debuglebowski/slayzone/commit/4e5ce340))
- **task-assets:** Content-addressed version history for assets ([8ae384bb](https://github.com/debuglebowski/slayzone/commit/8ae384bb))
- **chat:** Structured chat transport w/ autocomplete + streaming ([5e68fad3](https://github.com/debuglebowski/slayzone/commit/5e68fad3))
- **task-assets:** Version tree w/ current pointer, lock rule, and modal ([47758ebe](https://github.com/debuglebowski/slayzone/commit/47758ebe))
- **task:** Clickable sub-task status icon w/ popover ([35d5a49e](https://github.com/debuglebowski/slayzone/commit/35d5a49e))
- **task-assets:** Review fixes — HEAD=current, diff default, prune guard, CLI set-current, UI polish ([8eac2ddb](https://github.com/debuglebowski/slayzone/commit/8eac2ddb))
- **browser:** Enable trackpad pinch zoom (1x–3x) ([b164d45a](https://github.com/debuglebowski/slayzone/commit/b164d45a))
- **task-terminals:** Add "Enable chat" to header menu + widen ctx menu ([7bab3452](https://github.com/debuglebowski/slayzone/commit/7bab3452))
- **task:** Settings cards use grid w/ fit-content share ([f6bfb003](https://github.com/debuglebowski/slayzone/commit/f6bfb003))
- **chat:** Resilient reset + streaming UX + idle state + effort + queue ([b524d2f4](https://github.com/debuglebowski/slayzone/commit/b524d2f4))
- **skills:** Add comparison-page skill ([6083005f](https://github.com/debuglebowski/slayzone/commit/6083005f))
- **worktrees:** Export DiffView + GhMarkdown + diff types ([83ac9108](https://github.com/debuglebowski/slayzone/commit/83ac9108))
- **chat:** Loading state during history replay ([8c196bb6](https://github.com/debuglebowski/slayzone/commit/8c196bb6))
- **worktrees:** Auto-init submodules on worktree create ([9891b6d8](https://github.com/debuglebowski/slayzone/commit/9891b6d8))
- **worktrees:** Color-code worktree list and never color-code main worktree ([#75](https://github.com/debuglebowski/slayzone/pull/75))
- **explode:** Size grid cols by available width ([183bb139](https://github.com/debuglebowski/slayzone/commit/183bb139))
- **terminal:** Persist chat history across app reload ([6953645b](https://github.com/debuglebowski/slayzone/commit/6953645b))
- **website:** Add Superset.sh head-to-head page ([725a7028](https://github.com/debuglebowski/slayzone/commit/725a7028))
- **website:** Add ?static flag to freeze hero animations ([15282311](https://github.com/debuglebowski/slayzone/commit/15282311))

### 🩹 Fixes

- **file-editor:** Show rename input for directory entries ([ce6f05c2](https://github.com/debuglebowski/slayzone/commit/ce6f05c2))
- **file-editor:** Prevent Escape from triggering rename via onBlur ([bece1b70](https://github.com/debuglebowski/slayzone/commit/bece1b70))
- **website:** Switch to clean URLs, drop .html suffixes ([07a916be](https://github.com/debuglebowski/slayzone/commit/07a916be))
- **import:** Defer FK checks + auto-derive FK remap ([b3e93048](https://github.com/debuglebowski/slayzone/commit/b3e93048))
- **markdown:** Match wide-mode horizontal pad to vertical ([aa3633de](https://github.com/debuglebowski/slayzone/commit/aa3633de))
- **website:** SSR download button href fallback ([7673eeae](https://github.com/debuglebowski/slayzone/commit/7673eeae))
- **tasks:** Allow new-task modal in locked project ([c0e92518](https://github.com/debuglebowski/slayzone/commit/c0e92518))
- **task:** Stop new-task modal flashing state during close ([80f3b868](https://github.com/debuglebowski/slayzone/commit/80f3b868))
- **task:** Scope Cmd+D to focused cell in explode mode ([80acdcfa](https://github.com/debuglebowski/slayzone/commit/80acdcfa))
- **task:** Settings panel overflow with long sub-task list ([35da7e71](https://github.com/debuglebowski/slayzone/commit/35da7e71))
- **terminal:** Trim trailing spaces from copied selection ([6f59279f](https://github.com/debuglebowski/slayzone/commit/6f59279f))
- **browser:** Ignore sub-frame did-fail-load ([67e13510](https://github.com/debuglebowski/slayzone/commit/67e13510))
- **usage:** Harden provider fetch against transient net::ERR_FAILED ([8a96cb47](https://github.com/debuglebowski/slayzone/commit/8a96cb47))
- **task:** Subtasks min-h when few, flex-1 when many ([fbef03c3](https://github.com/debuglebowski/slayzone/commit/fbef03c3))
- **cli:** Make subtask-add parent an option so title default works ([#72](https://github.com/debuglebowski/slayzone/pull/72))
- **terminal:** Revive PTY on task status done→in_progress ([50f15aa1](https://github.com/debuglebowski/slayzone/commit/50f15aa1))
- **worktrees:** Authoritative color registry, no tab/panel divergence ([530ddec1](https://github.com/debuglebowski/slayzone/commit/530ddec1))
- **file-editor:** Preserve expandedFolders + robust Escape on rename ([e5187c68](https://github.com/debuglebowski/slayzone/commit/e5187c68))
- **agent-panel:** Add idle TerminalState mapping ([7ca25ff0](https://github.com/debuglebowski/slayzone/commit/7ca25ff0))
- **worktrees:** Color on task mutations + tests + detect-fail cache ([c1f2adf1](https://github.com/debuglebowski/slayzone/commit/c1f2adf1))
- **terminal:** Route dropped/pasted paths via xterm paste() ([54e7425f](https://github.com/debuglebowski/slayzone/commit/54e7425f))
- **terminal:** Inline non-image file paths on drop/paste ([7a9556ba](https://github.com/debuglebowski/slayzone/commit/7a9556ba))

### 💅 Refactors

- **theme:** Sweep palette classes to theme tokens ([70f06a36](https://github.com/debuglebowski/slayzone/commit/70f06a36))
- **file-editor:** Extract renderRenameInput helper for tree entries ([91c1c4e2](https://github.com/debuglebowski/slayzone/commit/91c1c4e2))

### 📖 Documentation

- Add engineering mindset to CLAUDE.md ([65eb8ec5](https://github.com/debuglebowski/slayzone/commit/65eb8ec5))
- **skills:** Slim init doc, add Engineering Mindset ([324bd7bd](https://github.com/debuglebowski/slayzone/commit/324bd7bd))
- **file-editor:** Comment why rename Escape uses capture phase ([712cb523](https://github.com/debuglebowski/slayzone/commit/712cb523))

### 🏡 Chore

- **nix:** Update sources to 0.20.0 ([5571464e](https://github.com/debuglebowski/slayzone/commit/5571464e))
- **website:** Declare js-yaml as explicit dep ([337fcc67](https://github.com/debuglebowski/slayzone/commit/337fcc67))
- Drop broken pnpm -r lint from root lint script ([c751794c](https://github.com/debuglebowski/slayzone/commit/c751794c))

### ✅ Tests

- **e2e:** Chat-mode toggle UI ([dcabbfd7](https://github.com/debuglebowski/slayzone/commit/dcabbfd7))

### ❤️ Contributors

- Debuglebowski
- Ian Thorslund
- Nadim Morhell

## v0.20.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.19.0...v0.20.0)

### 🚀 Enhancements

- **editor:** Split notes line-spacing into Readability + Width ([fb0634b5](https://github.com/debuglebowski/slayzone/commit/fb0634b5))
- **projects:** Lock UX overhaul — full takeover, Re-lock, Apply ([d2bf7b77](https://github.com/debuglebowski/slayzone/commit/d2bf7b77))
- **projects:** Block task creation while locked + lock guard tests ([0cea642d](https://github.com/debuglebowski/slayzone/commit/0cea642d))
- **settings:** Graduate Project Lock from Labs ([8501cb60](https://github.com/debuglebowski/slayzone/commit/8501cb60))

### 🩹 Fixes

- **task:** Refresh asset UI when content changes on disk ([c2b2d875](https://github.com/debuglebowski/slayzone/commit/c2b2d875))
- **ai-config:** Stop losing instructions edits + react to disk changes ([e6428b60](https://github.com/debuglebowski/slayzone/commit/e6428b60))

### 📖 Documentation

- **skills:** Document SLAYZONE_PROJECT_ID + sync slay reference ([296a6f47](https://github.com/debuglebowski/slayzone/commit/296a6f47))

### ❤️ Contributors

- Debuglebowski

## v0.19.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.18.0...v0.19.0)

### 🚀 Enhancements

- **tabs:** Add project-scoped tabs setting & Cmd+Shift+H shortcut ([ff77d342](https://github.com/debuglebowski/slayzone/commit/ff77d342))
- **ai-config:** Force-enable default terminal mode provider ([63bdd09d](https://github.com/debuglebowski/slayzone/commit/63bdd09d))
- **settings:** Add default provider select to Providers tab ([04e550d4](https://github.com/debuglebowski/slayzone/commit/04e550d4))
- **projects:** Project lock — duration, rate limit, schedule ([d9f6071c](https://github.com/debuglebowski/slayzone/commit/d9f6071c))
- **cli:** Add $SLAYZONE_PROJECT_ID env fallback for --project ([3c9cf0be](https://github.com/debuglebowski/slayzone/commit/3c9cf0be))
- **ai-config:** Show stale skill dot in context manager nav ([5bb86899](https://github.com/debuglebowski/slayzone/commit/5bb86899))
- **settings:** Graduate Context Manager + Automations from Labs ([a311950c](https://github.com/debuglebowski/slayzone/commit/a311950c))

### 🩹 Fixes

- **floating-agent:** Disable by default, fix macOS tiling manager compat ([290cfe9b](https://github.com/debuglebowski/slayzone/commit/290cfe9b))
- **cli:** Add WAL pragma to CLI DB connection ([3b2217f2](https://github.com/debuglebowski/slayzone/commit/3b2217f2))
- **projects:** Stretch lock popover inputs to fill width ([ef3bd778](https://github.com/debuglebowski/slayzone/commit/ef3bd778))

### 💅 Refactors

- **settings:** Remove General tab, extract MCP to own tab ([7f48e154](https://github.com/debuglebowski/slayzone/commit/7f48e154))

### 📖 Documentation

- **skills:** Drop --dev flag from marketplace slay skill ([5e0ab24e](https://github.com/debuglebowski/slayzone/commit/5e0ab24e))

### 🏡 Chore

- Ignore .claude/scheduled_tasks.lock ([ce94ae44](https://github.com/debuglebowski/slayzone/commit/ce94ae44))

### ❤️ Contributors

- Debuglebowski

## v0.18.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.17.3...v0.18.0)

### 🚀 Enhancements

- Floating agent panel — auto-detach on window blur ([31a18476](https://github.com/debuglebowski/slayzone/commit/31a18476))
- **task-browser:** Default localhost/IP URLs to http:// ([a2c33f67](https://github.com/debuglebowski/slayzone/commit/a2c33f67))
- **processes:** Add loading spinner to processes panel ([0abd2e46](https://github.com/debuglebowski/slayzone/commit/0abd2e46))
- **website:** Add jellyfish click-to-play octopus video ([353535ed](https://github.com/debuglebowski/slayzone/commit/353535ed))
- **website:** Track jellyfish/logo clicks, logo 2x starts video ([11878633](https://github.com/debuglebowski/slayzone/commit/11878633))
- **palette:** Unify Cmd+K/Cmd+P into one palette ([03c9a01e](https://github.com/debuglebowski/slayzone/commit/03c9a01e))
- **perf:** Add reusable Playwright profiling harness + dev perf fixes ([b609bb10](https://github.com/debuglebowski/slayzone/commit/b609bb10))
- **shortcuts:** Add Cmd+Shift+U shortcut for Update DB button ([d0f98450](https://github.com/debuglebowski/slayzone/commit/d0f98450))
- **ai-config:** Lock bound skills with source banners, sync, unlink ([a3f2e762](https://github.com/debuglebowski/slayzone/commit/a3f2e762))
- **palette:** Fzf-based search with dual-score ranking and match highlighting ([cc952cb4](https://github.com/debuglebowski/slayzone/commit/cc952cb4))
- **ai-config:** Add group-by dropdown for skills list (source/prefix) ([0c581359](https://github.com/debuglebowski/slayzone/commit/0c581359))
- Add caveman, caveman-commit, caveman-review skills ([29871aea](https://github.com/debuglebowski/slayzone/commit/29871aea))
- **editor:** Add markdown split mode with per-file/asset view persistence ([c6b228d2](https://github.com/debuglebowski/slayzone/commit/c6b228d2))
- **cli:** Add commit-and-done skill and --close flag on tasks done ([40d9cfb4](https://github.com/debuglebowski/slayzone/commit/40d9cfb4))
- **search:** Show status and priority pills on task results ([b81b0a43](https://github.com/debuglebowski/slayzone/commit/b81b0a43))
- **shortcuts:** Swap search/terminal/processes defaults ([2185f2c2](https://github.com/debuglebowski/slayzone/commit/2185f2c2))
- **agent-panel:** Add provider dropdown + reset icon button ([fb78fa93](https://github.com/debuglebowski/slayzone/commit/fb78fa93))
- **ai-config:** Flag stale skills in context manager list ([9caffb33](https://github.com/debuglebowski/slayzone/commit/9caffb33))
- **ai-config:** Show stale indicator on skill graph cards ([d95724b4](https://github.com/debuglebowski/slayzone/commit/d95724b4))
- **kanban-card:** Move blocked indicator to bottom row as pill ([8184d33a](https://github.com/debuglebowski/slayzone/commit/8184d33a))
- **ai-config:** Stale skill diff + per-provider sync in editor ([5c0b2f86](https://github.com/debuglebowski/slayzone/commit/5c0b2f86))
- **editor:** Notion-like markdown typography via .mk-doc system ([47e245d5](https://github.com/debuglebowski/slayzone/commit/47e245d5))
- **cli:** Init prints command reference + suggest on error ([2c5c2fa2](https://github.com/debuglebowski/slayzone/commit/2c5c2fa2))
- **shortcuts:** Allow unbinding shortcuts + null-safe types ([d341533c](https://github.com/debuglebowski/slayzone/commit/d341533c))
- **ai-config:** Pull-from-file + path-shared provider grouping ([ecbb03ae](https://github.com/debuglebowski/slayzone/commit/ecbb03ae))
- **shortcuts:** Settings panel → Cmd+J, zen → Cmd+Shift+J ([70a58643](https://github.com/debuglebowski/slayzone/commit/70a58643))
- **ai-config:** Stale-skill dot on context manager tab ([17202b0f](https://github.com/debuglebowski/slayzone/commit/17202b0f))
- **projects:** Custom icon — letters or image ([884132c7](https://github.com/debuglebowski/slayzone/commit/884132c7))
- **floating-agent:** State machine, menu, manual detach, size persistence ([79bfb917](https://github.com/debuglebowski/slayzone/commit/79bfb917))
- **browser:** Hide panel on last tab close, Cmd+T new tab ([#65](https://github.com/debuglebowski/slayzone/pull/65))

### 🩹 Fixes

- **terminal:** Send injected text in single write to prevent whitespace drops ([8d2cfddb](https://github.com/debuglebowski/slayzone/commit/8d2cfddb))
- **cli:** Respect --dev flag in slay tasks open ([0f12c425](https://github.com/debuglebowski/slayzone/commit/0f12c425))
- **editor:** Fix dead prose selector breaking dark mode text colors ([997628a1](https://github.com/debuglebowski/slayzone/commit/997628a1))
- **cli:** Surface silent HTTP failures in notifyApp + tasks done --close ([8a04c760](https://github.com/debuglebowski/slayzone/commit/8a04c760))
- **ui:** Align context-menu rows via CSS subgrid ([e159a667](https://github.com/debuglebowski/slayzone/commit/e159a667))
- **website:** Restore hero-logo-wrap div ([074cb3e7](https://github.com/debuglebowski/slayzone/commit/074cb3e7))
- **website:** Anchor octopus canvas to logo wrap ([9fe4b2b2](https://github.com/debuglebowski/slayzone/commit/9fe4b2b2))
- **website:** Hide static octopus when dance video plays ([56b5700d](https://github.com/debuglebowski/slayzone/commit/56b5700d))
- **website:** Restore jellyfish click-to-play trigger ([3b573ad1](https://github.com/debuglebowski/slayzone/commit/3b573ad1))
- **website:** Bootstrap hero demo animation loop ([6ad1bd3c](https://github.com/debuglebowski/slayzone/commit/6ad1bd3c))
- **dev:** Remove broken Vite warmup block ([3eb7e180](https://github.com/debuglebowski/slayzone/commit/3eb7e180))

### 💅 Refactors

- **palette:** Unify search shortcut to Cmd+P, remove panel-quick-open ([1bde2129](https://github.com/debuglebowski/slayzone/commit/1bde2129))
- **website:** Migrate legacy HTML to native Astro components ([a2323866](https://github.com/debuglebowski/slayzone/commit/a2323866))
- **shortcuts:** Rebind terminal to Cmd+K, fix E2E selectors and search refs ([7c6c0a1c](https://github.com/debuglebowski/slayzone/commit/7c6c0a1c))
- **terminal:** Drop redundant reset button from main tab header ([17b566ff](https://github.com/debuglebowski/slayzone/commit/17b566ff))
- **ai-config:** Rename global → computer/library ([ab3cadf1](https://github.com/debuglebowski/slayzone/commit/ab3cadf1))
- **browser:** Dedicate Cmd+T to new browser tab ([090e1d0f](https://github.com/debuglebowski/slayzone/commit/090e1d0f))

### 📖 Documentation

- **claude:** Default to caveman ultra, trim stale monorepo sections ([9a5a4ddb](https://github.com/debuglebowski/slayzone/commit/9a5a4ddb))
- **comparison:** Track Vibeyard competitor ([45c8d1ec](https://github.com/debuglebowski/slayzone/commit/45c8d1ec))
- Sync AGENTS.md context + slay skill refs ([1f0a0dfb](https://github.com/debuglebowski/slayzone/commit/1f0a0dfb))

### 🏡 Chore

- **nix:** Update sources to 0.17.3 ([ca1a3c18](https://github.com/debuglebowski/slayzone/commit/ca1a3c18))
- **marketplace:** Swap default skill registries ([8f434f01](https://github.com/debuglebowski/slayzone/commit/8f434f01))
- Add perf profiling reports, gitignore cpuprofile/json artifacts ([9f214a8c](https://github.com/debuglebowski/slayzone/commit/9f214a8c))

### ❤️ Contributors

- Debuglebowski
- Ian Thorslund
- Robert Sinke

## v0.17.3

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.17.2...v0.17.3)

### 🚀 Enhancements

- **settings:** Add duplicate provider button to AI providers tab ([de6d2d01](https://github.com/debuglebowski/slayzone/commit/de6d2d01))
- **ai-config:** Add/remove library & project actions on marketplace cards ([563f2ae2](https://github.com/debuglebowski/slayzone/commit/563f2ae2))

### 🩹 Fixes

- **ai-config:** Uniform skill graph edge rendering + fix spurious back-edges ([98e4f7e1](https://github.com/debuglebowski/slayzone/commit/98e4f7e1))

### 🏡 Chore

- **nix:** Update sources to 0.17.2 ([77b9af7c](https://github.com/debuglebowski/slayzone/commit/77b9af7c))
- Reorder slay skill frontmatter ([ab2a0f30](https://github.com/debuglebowski/slayzone/commit/ab2a0f30))

### ❤️ Contributors

- Debuglebowski

## v0.17.2

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.17.1...v0.17.2)

### 🚀 Enhancements

- **cli:** Add --permanent flag to slay tasks update ([25dd1618](https://github.com/debuglebowski/slayzone/commit/25dd1618))

### 🩹 Fixes

- **ai-config:** Use single-quoted 'now' in datetime() to fix boot crash ([baace644](https://github.com/debuglebowski/slayzone/commit/baace644))
- **ai-config:** Move handleDeleteEdge above buildGraph to fix TDZ crash ([704fdc58](https://github.com/debuglebowski/slayzone/commit/704fdc58))
- **leaderboard:** Surface OAuth callback errors instead of swallowing ([9e50f00b](https://github.com/debuglebowski/slayzone/commit/9e50f00b))

### 🏡 Chore

- **nix:** Update sources to 0.17.0 ([5860113d](https://github.com/debuglebowski/slayzone/commit/5860113d))
- Add --permanent to slay-auto-title local skill ([b43edb73](https://github.com/debuglebowski/slayzone/commit/b43edb73))

### ❤️ Contributors

- Debuglebowski

## v0.17.1

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.17.0...v0.17.1)

### 🚀 Enhancements

- **cli:** Add --permanent flag to slay tasks update ([65f381f7](https://github.com/debuglebowski/slayzone/commit/65f381f7))

### 🩹 Fixes

- **ai-config:** Move handleDeleteEdge above buildGraph to fix TDZ crash ([dd738aeb](https://github.com/debuglebowski/slayzone/commit/dd738aeb))
- **leaderboard:** Surface OAuth callback errors instead of swallowing ([14c66c61](https://github.com/debuglebowski/slayzone/commit/14c66c61))

### 🏡 Chore

- Allow tag management in release-monitor-ci skill ([f229c150](https://github.com/debuglebowski/slayzone/commit/f229c150))
- Add --permanent to slay-auto-title local skill ([1a68ea55](https://github.com/debuglebowski/slayzone/commit/1a68ea55))

### ❤️ Contributors

- Debuglebowski

## v0.17.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.16.0...v0.17.0)

### 🚀 Enhancements

- **task:** Reorganize assets panel layout + add download ([d808955b](https://github.com/debuglebowski/slayzone/commit/d808955b))
- Add full bordered rounded tables to markdown preview + editor ([60b92474](https://github.com/debuglebowski/slayzone/commit/60b92474))
- **task:** Sort assets and folders alphabetically in assets panel ([c4256899](https://github.com/debuglebowski/slayzone/commit/c4256899))
- Include context manager in Ctrl+Tab cycling ([a3e1dbaf](https://github.com/debuglebowski/slayzone/commit/a3e1dbaf))
- Add persistent agent side panel with full-height layout ([086dbf49](https://github.com/debuglebowski/slayzone/commit/086dbf49))
- **task:** Add standalone blocked state with split button UI ([d30df207](https://github.com/debuglebowski/slayzone/commit/d30df207))
- Remap shortcuts — attention→Ctrl+., assets→Cmd+Shift+A ([3dd23854](https://github.com/debuglebowski/slayzone/commit/3dd23854))
- **tabs:** Double-click task tab to rename inline ([f532ed12](https://github.com/debuglebowski/slayzone/commit/f532ed12))
- **themes:** Add surface3 token and shift surface scale ([2c0b1070](https://github.com/debuglebowski/slayzone/commit/2c0b1070))
- **ui:** Add status icons to metadata sidebar dropdown ([af4fde0b](https://github.com/debuglebowski/slayzone/commit/af4fde0b))
- **tasks:** Show keyboard shortcut hints in task context menu ([e6353683](https://github.com/debuglebowski/slayzone/commit/e6353683))
- **tasks:** Add Blocked and Blocked by items to kanban context menu ([74377918](https://github.com/debuglebowski/slayzone/commit/74377918))
- **cli:** Add blocking commands to slay CLI ([d1fe6515](https://github.com/debuglebowski/slayzone/commit/d1fe6515))
- **ai-config:** Add skill preview dialog, remove tags and category filter ([b67f075c](https://github.com/debuglebowski/slayzone/commit/b67f075c))
- **ai-config:** Split builtin slay skill into 9 domain-specific skills with rich docs ([dbb06adf](https://github.com/debuglebowski/slayzone/commit/dbb06adf))
- **task:** Persist active asset selection across task switches ([db865d56](https://github.com/debuglebowski/slayzone/commit/db865d56))
- **ai-config:** Replace tags with category grouping, add slay-context skill ([23a3152a](https://github.com/debuglebowski/slayzone/commit/23a3152a))
- **task:** Add download-as-PDF for text-based assets ([598dec9c](https://github.com/debuglebowski/slayzone/commit/598dec9c))
- **tasks:** Extract BlockerDialog, add B/Shift+B keyboard shortcuts ([5baf5d20](https://github.com/debuglebowski/slayzone/commit/5baf5d20))
- **task:** Add PNG, HTML, and ZIP asset downloads ([91d383ba](https://github.com/debuglebowski/slayzone/commit/91d383ba))
- **ai-config:** Add slay-auto-title skill, auto-update installed builtins ([7aff0d6d](https://github.com/debuglebowski/slayzone/commit/7aff0d6d))
- **editor:** Add icons, focus, and no-outline to inline create inputs ([5fcd5332](https://github.com/debuglebowski/slayzone/commit/5fcd5332))
- **settings:** Apply editor appearance settings to markdown assets ([ed1c96d3](https://github.com/debuglebowski/slayzone/commit/ed1c96d3))
- **terminal:** Add slay CLI nudge banner for unconfigured projects ([948ee61f](https://github.com/debuglebowski/slayzone/commit/948ee61f))
- **editor:** Add syntax highlighting for Go, YAML, SQL, TOML, HCL ([#64](https://github.com/debuglebowski/slayzone/pull/64))
- **cli:** Add slay tasks assets download + MCP export endpoints ([38da1e8e](https://github.com/debuglebowski/slayzone/commit/38da1e8e))
- **ai-config:** Sort all context manager lists alphabetically ([5bc01d63](https://github.com/debuglebowski/slayzone/commit/5bc01d63))
- **browser:** Search Google for non-URL input in address bar ([e11afe35](https://github.com/debuglebowski/slayzone/commit/e11afe35))
- **tabs:** Add tooltips to Home and Context Manager tabs ([7dd5062c](https://github.com/debuglebowski/slayzone/commit/7dd5062c))
- **editor:** Add git status letter badges and italic ignored files in filetree ([740d9196](https://github.com/debuglebowski/slayzone/commit/740d9196))
- **usage:** Sort usage bars alphabetically in header and popup ([e71ea961](https://github.com/debuglebowski/slayzone/commit/e71ea961))
- **cli:** Project-scoped skill init with disk file writing ([f417545d](https://github.com/debuglebowski/slayzone/commit/f417545d))
- **marketplace:** Sync skill files to disk on install ([569cd5e9](https://github.com/debuglebowski/slayzone/commit/569cd5e9))
- **terminal:** Rewrite slay nudge banner copy and layout ([080b3d7c](https://github.com/debuglebowski/slayzone/commit/080b3d7c))

### 🩹 Fixes

- **terminal:** Focus new pane after split ([190cda17](https://github.com/debuglebowski/slayzone/commit/190cda17))
- **terminal:** Send Meta-b/f for Option+Arrow word nav on macOS ([7eb44dc4](https://github.com/debuglebowski/slayzone/commit/7eb44dc4))
- **usage:** Add User-Agent header to OAuth usage fetch + fix first-429 backoff ([8cd90885](https://github.com/debuglebowski/slayzone/commit/8cd90885))
- **terminal:** Restore spawn-helper execute bit and add cwd validation ([023e3966](https://github.com/debuglebowski/slayzone/commit/023e3966))
- **tabs:** Deactivate task tab highlight when context manager is open ([6827ca63](https://github.com/debuglebowski/slayzone/commit/6827ca63))
- **ai-config:** Marketplace drill-in showing all skills due to stale ensureFresh closure ([e4a5e646](https://github.com/debuglebowski/slayzone/commit/e4a5e646))
- **usage:** Invalidate cache on account switch to prevent stale cross-account data ([f62d4919](https://github.com/debuglebowski/slayzone/commit/f62d4919))
- **ai-config:** Fix syntax errors in skill-marketplace-registry template literal ([31f7538e](https://github.com/debuglebowski/slayzone/commit/31f7538e))
- Merge duplicate style attributes on explode-mode container ([612111a8](https://github.com/debuglebowski/slayzone/commit/612111a8))
- **editor:** Align text indentation across bullet, ordered, and task lists ([#61](https://github.com/debuglebowski/slayzone/pull/61))
- **task:** Use preload API for asset panel file drop ([beb95e81](https://github.com/debuglebowski/slayzone/commit/beb95e81))
- **terminal:** Support Cmd+Click file links on wrapped lines ([90a2d609](https://github.com/debuglebowski/slayzone/commit/90a2d609))
- **editor:** Clean up list CSS after indentation unification ([0ec70bb0](https://github.com/debuglebowski/slayzone/commit/0ec70bb0))
- **editor:** Fix compact line spacing not working with Milkdown ([#63](https://github.com/debuglebowski/slayzone/pull/63))
- **editor:** Clean up duplicate ProseMirror task list CSS ([5b688600](https://github.com/debuglebowski/slayzone/commit/5b688600))
- **terminal:** Recheck slay config on nudge dialog close instead of Done button ([24493aa3](https://github.com/debuglebowski/slayzone/commit/24493aa3))
- **ui:** Restore dialog max-width cap, remove leftover responsive prefixes ([3a4aff4d](https://github.com/debuglebowski/slayzone/commit/3a4aff4d))
- **terminal:** Detect bare filenames in parens as clickable links ([852a2f54](https://github.com/debuglebowski/slayzone/commit/852a2f54))
- **worktrees:** Stale PR check status badge — refresh button, parser, adaptive poll ([4208510e](https://github.com/debuglebowski/slayzone/commit/4208510e))
- **editor:** Markdown editor fills full panel height with focus support ([99186d4a](https://github.com/debuglebowski/slayzone/commit/99186d4a))
- **terminal:** Keep focus when dragging image into terminal ([a604e5b1](https://github.com/debuglebowski/slayzone/commit/a604e5b1))

### 💅 Refactors

- **ui:** Add variant prop to PanelToggle for contrast control ([db24a333](https://github.com/debuglebowski/slayzone/commit/db24a333))
- **ui:** Redesign layout with inset card panels and surface tokens ([8dbcfab0](https://github.com/debuglebowski/slayzone/commit/8dbcfab0))
- **ui:** Unify side panel resize handles with ResizeHandle component ([c6086569](https://github.com/debuglebowski/slayzone/commit/c6086569))
- **ui:** Migrate components to new surface token scale ([c44920ce](https://github.com/debuglebowski/slayzone/commit/c44920ce))
- **ui:** Tune light mode surface scale to 0.92/0.95/0.97/1.0 ([322c89bf](https://github.com/debuglebowski/slayzone/commit/322c89bf))
- **ui:** Widen skill preview dialog, remove responsive breakpoints from Dialog ([1e210112](https://github.com/debuglebowski/slayzone/commit/1e210112))
- **ai-config:** Rename Slay CLI to Slay, move to top of marketplace ([57112acb](https://github.com/debuglebowski/slayzone/commit/57112acb))
- **ai-config:** Use bg-surface-3 for consistent card/panel surfaces ([401d56a0](https://github.com/debuglebowski/slayzone/commit/401d56a0))
- **task:** Restructure download menu into Download + Download as submenu ([3e335ce9](https://github.com/debuglebowski/slayzone/commit/3e335ce9))
- Remove project color tint background from main area ([b92334eb](https://github.com/debuglebowski/slayzone/commit/b92334eb))
- **task:** Extract asset export into shared module ([6dafb49e](https://github.com/debuglebowski/slayzone/commit/6dafb49e))
- **cli:** Replace slay init skill with slay init skills bulk install ([3209e978](https://github.com/debuglebowski/slayzone/commit/3209e978))

### 📖 Documentation

- **cli:** Sync slay skill reference with source ([65a491bc](https://github.com/debuglebowski/slayzone/commit/65a491bc))
- **slay:** Expand SKILL.md command reference with descriptions ([daa4189f](https://github.com/debuglebowski/slayzone/commit/daa4189f))

### 🏡 Chore

- **nix:** Update sources to 0.16.0 ([78d3e009](https://github.com/debuglebowski/slayzone/commit/78d3e009))
- Add missing slay-projects skill file ([234229d2](https://github.com/debuglebowski/slayzone/commit/234229d2))

### ❤️ Contributors

- Debuglebowski
- Stefan Farestam

## v0.16.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.15.0...v0.16.0)

### 🚀 Enhancements

- **task:** Add asset folders with context menus, inline editing, and E2E tests ([3ee314dc](https://github.com/debuglebowski/slayzone/commit/3ee314dc))
- **task:** Add asset search — local find bar and global search panel ([74b703b3](https://github.com/debuglebowski/slayzone/commit/74b703b3))
- **task:** Restyle asset sidebar items as cards ([c5ae8afa](https://github.com/debuglebowski/slayzone/commit/c5ae8afa))
- **task:** Auto-refresh asset content on CLI updates ([84c75ac0](https://github.com/debuglebowski/slayzone/commit/84c75ac0))
- **cli:** Add `slay tasks assets mvdir` command to move folders ([59b0f966](https://github.com/debuglebowski/slayzone/commit/59b0f966))
- **ai-config:** Auto-reconcile on-disk skills to DB, remove unmanaged concept ([cf410e03](https://github.com/debuglebowski/slayzone/commit/cf410e03))
- **task:** Style asset folder rows as cards matching asset items ([241bc3c6](https://github.com/debuglebowski/slayzone/commit/241bc3c6))
- **cli:** Add sync-slay-skill to regenerate CLI reference from source ([9f490f80](https://github.com/debuglebowski/slayzone/commit/9f490f80))

### 🩹 Fixes

- **projects:** Lock sidebar project drag to vertical axis ([8d000248](https://github.com/debuglebowski/slayzone/commit/8d000248))
- **ai-config:** Load on-disk skills in context manager project view ([0c64c06e](https://github.com/debuglebowski/slayzone/commit/0c64c06e))
- **task:** Prevent create-task form reset on background data refresh ([5bf91051](https://github.com/debuglebowski/slayzone/commit/5bf91051))
- **file-editor:** Add taskListPlugin to MarkdownFileEditor for checkbox rendering ([459d488b](https://github.com/debuglebowski/slayzone/commit/459d488b))
- **ai-config:** Show dependency direction arrows on skill graph edges ([0ec6837a](https://github.com/debuglebowski/slayzone/commit/0ec6837a))

### 📖 Documentation

- **cli:** Add slay CLI skill and SlayZone environment awareness ([665fe839](https://github.com/debuglebowski/slayzone/commit/665fe839))
- **slay:** Require --dev flag in slay CLI skill ([f94b4ec5](https://github.com/debuglebowski/slayzone/commit/f94b4ec5))
- **slay:** Add asset folder commands to skill reference ([7f0155bf](https://github.com/debuglebowski/slayzone/commit/7f0155bf))
- **slay:** Sync skill reference with CLI source — add missing options and folder commands ([ed817e23](https://github.com/debuglebowski/slayzone/commit/ed817e23))
- Sync AGENTS.md with current architecture ([eee633a6](https://github.com/debuglebowski/slayzone/commit/eee633a6))

### 🏡 Chore

- Rename dev:oauth → dev:protocol ([37ef2db2](https://github.com/debuglebowski/slayzone/commit/37ef2db2))

### ❤️ Contributors

- Debuglebowski

## v0.15.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.14.0...v0.15.0)

### 🚀 Enhancements

- **projects:** Add Tasks category to project settings nav ([b7c61e77](https://github.com/debuglebowski/slayzone/commit/b7c61e77))
- **terminal:** Add --wait to pty submit for AI mode input timing ([76e3f783](https://github.com/debuglebowski/slayzone/commit/76e3f783))
- **projects:** Auto-move tasks on terminal state change ([724a4863](https://github.com/debuglebowski/slayzone/commit/724a4863))
- **task:** Add task assets system — types, handlers, file storage ([30cb9a39](https://github.com/debuglebowski/slayzone/commit/30cb9a39))
- **task:** Add assets panel UI with multi-format rendering ([c51a5ea9](https://github.com/debuglebowski/slayzone/commit/c51a5ea9))
- **editor:** Asset link chips and @-mention picker in milkdown ([db94226f](https://github.com/debuglebowski/slayzone/commit/db94226f))
- **cli:** Add asset CRUD subcommands ([c0867db8](https://github.com/debuglebowski/slayzone/commit/c0867db8))
- **cli:** Add --append-description flag and asset link hints ([b70bad8d](https://github.com/debuglebowski/slayzone/commit/b70bad8d))

### 🩹 Fixes

- **terminal:** Ignore errors when killing PTY on Windows ([2e942d11](https://github.com/debuglebowski/slayzone/commit/2e942d11))
- **usage-analytics:** Use local timezone for daily usage grouping ([bd8aa89d](https://github.com/debuglebowski/slayzone/commit/bd8aa89d))
- **ui:** Remove collapsible animation classes ([ecd7ce39](https://github.com/debuglebowski/slayzone/commit/ecd7ce39))
- **terminal:** Disable cursor blink ([9a797f32](https://github.com/debuglebowski/slayzone/commit/9a797f32))

### 🏡 Chore

- **nix:** Update sources to 0.14.0 ([487cbb2c](https://github.com/debuglebowski/slayzone/commit/487cbb2c))
- Remove stale tiptap references, replace with milkdown ([be7841bb](https://github.com/debuglebowski/slayzone/commit/be7841bb))

### ❤️ Contributors

- Debuglebowski
- Kdrapel ([@kdrapel](https://github.com/kdrapel))

## v0.14.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.13.0...v0.14.0)

### 🚀 Enhancements

- **cli:** Sync CLI version with app version at build time ([1400e237](https://github.com/debuglebowski/slayzone/commit/1400e237))
- **task:** Add blocker search and status icons ([a6a11a0b](https://github.com/debuglebowski/slayzone/commit/a6a11a0b))
- **editor:** Set caret + focus at search hit location when clicking results ([b10558d1](https://github.com/debuglebowski/slayzone/commit/b10558d1))
- **cli:** Warn when --dev flag targets different DB than running app ([87d12ace](https://github.com/debuglebowski/slayzone/commit/87d12ace))
- **task-browser:** Add Cmd+F find-in-page to browser panels ([d472c1c1](https://github.com/debuglebowski/slayzone/commit/d472c1c1))
- **cli:** Elevate install with OS-native auth on EACCES ([887758dc](https://github.com/debuglebowski/slayzone/commit/887758dc))
- **terminal:** Add copy session ID to context menu and dropdown menu ([cabe404d](https://github.com/debuglebowski/slayzone/commit/cabe404d))
- **terminal:** Add copy session ID to context menu and dropdown menu" ([825c8e33](https://github.com/debuglebowski/slayzone/commit/825c8e33))
- **terminal:** Add copy conversation ID to dropdown menu ([bc74ee6e](https://github.com/debuglebowski/slayzone/commit/bc74ee6e))
- **browser:** Create tasks from browser links ([781d11b0](https://github.com/debuglebowski/slayzone/commit/781d11b0))
- **leaderboard:** Add manual sync stats button ([caad0fcc](https://github.com/debuglebowski/slayzone/commit/caad0fcc))
- **ui:** Replace Sparkles with BookOpen icon for context manager ([83db9e35](https://github.com/debuglebowski/slayzone/commit/83db9e35))
- **shortcuts:** Add priority-based keyboard shortcut system ([2a640270](https://github.com/debuglebowski/slayzone/commit/2a640270))
- **terminal:** Add session resume and adapter improvements ([a989a27e](https://github.com/debuglebowski/slayzone/commit/a989a27e))
- **panels:** Add web panel CRUD with CLI commands ([bd976b69](https://github.com/debuglebowski/slayzone/commit/bd976b69))
- **ai-config:** Add skill dependency graph visualization ([71e539b5](https://github.com/debuglebowski/slayzone/commit/71e539b5))
- **ui:** Add context manager tab to home panel ([1c0caf3a](https://github.com/debuglebowski/slayzone/commit/1c0caf3a))
- **ai-config:** Redesign context manager with 3-level navigation ([cbe092d9](https://github.com/debuglebowski/slayzone/commit/cbe092d9))
- **e2e:** Add parallel runner, fixture helpers, globstar support ([7a01cb71](https://github.com/debuglebowski/slayzone/commit/7a01cb71))
- **task-browser:** Scope URL import to current project ([0b9349e2](https://github.com/debuglebowski/slayzone/commit/0b9349e2))
- **ai-config:** Expand provider registry with cursor, agents, mcp configs ([a86cb077](https://github.com/debuglebowski/slayzone/commit/a86cb077))
- **ai-config:** Add zustand store and global files view ([4732c30f](https://github.com/debuglebowski/slayzone/commit/4732c30f))
- **ai-config:** Rework instructions, skills, and MCP panels ([67c48070](https://github.com/debuglebowski/slayzone/commit/67c48070))

### 🩹 Fixes

- **cli:** Don't show install dialog when CLI is already installed ([b182ac9d](https://github.com/debuglebowski/slayzone/commit/b182ac9d))
- **task:** Keep blocker search in add popover only ([0deea3fe](https://github.com/debuglebowski/slayzone/commit/0deea3fe))
- **ai-config:** Sync frontmatter to all providers, not just claude ([678683ed](https://github.com/debuglebowski/slayzone/commit/678683ed))
- **app:** Keep browser views aligned during app zoom ([646f1027](https://github.com/debuglebowski/slayzone/commit/646f1027))
- **e2e:** Restore PTY handlers after mock specs, fix integration tests ([07762ad5](https://github.com/debuglebowski/slayzone/commit/07762ad5))
- **ai-config:** Restore context manager entry points in tab bar and home panel ([3c0df883](https://github.com/debuglebowski/slayzone/commit/3c0df883))
- **terminal:** Per-adapter startup timeout, increase Gemini to 20s ([c08c0c12](https://github.com/debuglebowski/slayzone/commit/c08c0c12))
- **task-browser:** Fix URL input update on history navigation ([bb33a7c9](https://github.com/debuglebowski/slayzone/commit/bb33a7c9))

### 💅 Refactors

- **ai-config:** Remove context manager from global and project settings menus ([810e5162](https://github.com/debuglebowski/slayzone/commit/810e5162))
- **ai-config:** Replace level tabs with collapsible sidebar sections ([7e401894](https://github.com/debuglebowski/slayzone/commit/7e401894))
- **e2e:** Reorganize flat test files into subdirectories ([bf975b88](https://github.com/debuglebowski/slayzone/commit/bf975b88))
- **ai-config:** Unified split-pane instructions with variant references ([8180da07](https://github.com/debuglebowski/slayzone/commit/8180da07))
- **e2e:** Rebalance groups to 4 dirs, skip GPU/CLI-contention flakes ([a4554c1f](https://github.com/debuglebowski/slayzone/commit/a4554c1f))
- **tabs:** Move context manager tab to right of home tab ([67ee0a0c](https://github.com/debuglebowski/slayzone/commit/67ee0a0c))

### 📖 Documentation

- Normalize AGENTS.md markdown formatting ([fb36ebaf](https://github.com/debuglebowski/slayzone/commit/fb36ebaf))

### 🏡 Chore

- Add frontmatter to skills, remove evaluate-competitor, update release ([151e498c](https://github.com/debuglebowski/slayzone/commit/151e498c))
- Remove Gemini skills, consolidate agent docs ([cf26cee9](https://github.com/debuglebowski/slayzone/commit/cf26cee9))
- Misc cleanups, type fixes, and perf data updates ([0cb3fc47](https://github.com/debuglebowski/slayzone/commit/0cb3fc47))
- Update perf data ([8a9d7564](https://github.com/debuglebowski/slayzone/commit/8a9d7564))
- Replace TEST_STATUS_REPORT with E2E-REPORT ([fbb24513](https://github.com/debuglebowski/slayzone/commit/fbb24513))
- Fix truncated LICENSE, add license field to package.json ([0ccb23ee](https://github.com/debuglebowski/slayzone/commit/0ccb23ee))
- Update performance profiling data ([ce74172c](https://github.com/debuglebowski/slayzone/commit/ce74172c))
- Update performance profiling data ([4aa096b9](https://github.com/debuglebowski/slayzone/commit/4aa096b9))

### ✅ Tests

- **task:** Align stale UI expectations ([e2065d8a](https://github.com/debuglebowski/slayzone/commit/e2065d8a))
- **e2e:** Add session and provider config test suites ([e590f356](https://github.com/debuglebowski/slayzone/commit/e590f356))
- **e2e:** Update existing tests and fixtures ([21a3ba6c](https://github.com/debuglebowski/slayzone/commit/21a3ba6c))
- **e2e:** Extract browser panel helpers in protocol blocking spec ([1744d7e7](https://github.com/debuglebowski/slayzone/commit/1744d7e7))
- **e2e:** Update specs and fixtures for stability ([2c487081](https://github.com/debuglebowski/slayzone/commit/2c487081))
- **e2e:** Skip codex resize test, document gray prompt box limitation ([34e920ff](https://github.com/debuglebowski/slayzone/commit/34e920ff))

### ❤️ Contributors

- Debuglebowski

## v0.13.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.12.0...v0.13.0)

### 🚀 Enhancements

- **notifications:** Add collapsible sections to notification panel ([bc120db8](https://github.com/debuglebowski/slayzone/commit/bc120db8))
- **automations:** Add Pencil icon to Edit menu item ([efb9761f](https://github.com/debuglebowski/slayzone/commit/efb9761f))
- **cli:** Add --external-id dedup to tasks create/subtask-add ([ceb92063](https://github.com/debuglebowski/slayzone/commit/ceb92063))
- **automations:** Improve cron schedule UX with syntax hint and presets ([ba566a64](https://github.com/debuglebowski/slayzone/commit/ba566a64))
- **terminal:** Add copy history to terminal menu ([9ec831d7](https://github.com/debuglebowski/slayzone/commit/9ec831d7))
- **cli:** Add tags, templates, automations, due dates, project update commands ([671a6743](https://github.com/debuglebowski/slayzone/commit/671a6743))
- **history:** Add activity_events domain and schema ([cd605d91](https://github.com/debuglebowski/slayzone/commit/cd605d91))
- **history:** Record activity events for tasks, tags, automations ([34f163ec](https://github.com/debuglebowski/slayzone/commit/34f163ec))
- **task:** Add history and settings panels ([7ec9b85e](https://github.com/debuglebowski/slayzone/commit/7ec9b85e))
- **automations:** Wire up Cmd+Y shortcut for automations panel ([e6cc1bdd](https://github.com/debuglebowski/slayzone/commit/e6cc1bdd))
- **cli:** Add `slay panels` command for creating web panel definitions ([4af2913a](https://github.com/debuglebowski/slayzone/commit/4af2913a))
- **onboarding:** Add CLI install step ([13e45247](https://github.com/debuglebowski/slayzone/commit/13e45247))
- **cli:** Add post-onboarding CLI install dialog ([1f53a455](https://github.com/debuglebowski/slayzone/commit/1f53a455))

### 🩹 Fixes

- **terminal:** Fall back to default flags when task has no per-task flags ([c7066034](https://github.com/debuglebowski/slayzone/commit/c7066034))
- **task:** Sync local state when applying template to temporary task ([aa8b8126](https://github.com/debuglebowski/slayzone/commit/aa8b8126))
- **task:** Allow resetting due date via X button ([7eb41eb5](https://github.com/debuglebowski/slayzone/commit/7eb41eb5))
- **notifications:** Add aria-expanded to collapsible group headers ([622245ef](https://github.com/debuglebowski/slayzone/commit/622245ef))
- **task:** Hide sibling sections when description is expanded to full height ([#53](https://github.com/debuglebowski/slayzone/pull/53))
- **task:** Preserve sub-tasks accordion state across description expand toggle ([13e37e55](https://github.com/debuglebowski/slayzone/commit/13e37e55))
- **automations:** Add missing deps that broke CI typecheck ([492fc168](https://github.com/debuglebowski/slayzone/commit/492fc168))
- **notifications:** Group tasks by label instead of status ID ([38b726a4](https://github.com/debuglebowski/slayzone/commit/38b726a4))
- **task:** Prevent "Task not found" flash for subtasks during race window ([9e7331e5](https://github.com/debuglebowski/slayzone/commit/9e7331e5))
- **editor:** Add checkbox rendering for Milkdown GFM task lists ([#58](https://github.com/debuglebowski/slayzone/pull/58))
- **terminal:** Skip usage fetch for disabled built-in providers ([#55](https://github.com/debuglebowski/slayzone/pull/55))
- **editor:** Improve task list checkbox plugin and heading margins ([0332fc5c](https://github.com/debuglebowski/slayzone/commit/0332fc5c))
- **editor:** Fill description card with editor and set milkdown height ([93fadc0b](https://github.com/debuglebowski/slayzone/commit/93fadc0b))

### 💅 Refactors

- **task:** Template button → icon after Turn into task ([32e6db06](https://github.com/debuglebowski/slayzone/commit/32e6db06))
- **task:** Remove automations panel from task view ([703010b1](https://github.com/debuglebowski/slayzone/commit/703010b1))
- **tasks:** Move due date to bottom-right of kanban card with ring ([61f42f19](https://github.com/debuglebowski/slayzone/commit/61f42f19))
- **automations:** Simplify automation card to single-row layout with timeline ([a519e64a](https://github.com/debuglebowski/slayzone/commit/a519e64a))
- **task:** Wrap metadata in collapsible Details section ([e5810027](https://github.com/debuglebowski/slayzone/commit/e5810027))
- **task:** Restyle Details header as card with gap ([700347f0](https://github.com/debuglebowski/slayzone/commit/700347f0))
- **task:** Only show Details card in full-height description mode ([c289abbe](https://github.com/debuglebowski/slayzone/commit/c289abbe))

### 🏡 Chore

- **nix:** Update sources to 0.12.0 ([72d87e67](https://github.com/debuglebowski/slayzone/commit/72d87e67))
- Update skill definitions ([cc6cde54](https://github.com/debuglebowski/slayzone/commit/cc6cde54))

### ✅ Tests

- **task:** Add template handler contract tests ([eb8e3031](https://github.com/debuglebowski/slayzone/commit/eb8e3031))

### ❤️ Contributors

- Debuglebowski
- Stefan Farestam
- Sfarestam

## v0.12.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.11.0...v0.12.0)

### 🚀 Enhancements

- **projects:** Enable folder creation in directory picker dialogs ([6066ff54](https://github.com/debuglebowski/slayzone/commit/6066ff54))
- **task:** Add custom working directory and sidebar layout improvements ([202e976a](https://github.com/debuglebowski/slayzone/commit/202e976a))
- **tags:** Project-scoped tags, card display, create/edit dialog, ordering ([51c6dbc5](https://github.com/debuglebowski/slayzone/commit/51c6dbc5))
- **tags:** Preset color swatches, text_color column, edit dialog fix ([5972e9a0](https://github.com/debuglebowski/slayzone/commit/5972e9a0))
- **tags:** Card layout redesign, grouped tag dots, responsive overflow ([307bd6bd](https://github.com/debuglebowski/slayzone/commit/307bd6bd))
- **file-editor:** Milkdown WYSIWYG for markdown files ([d5bdf3ee](https://github.com/debuglebowski/slayzone/commit/d5bdf3ee))
- **settings:** Appearance tab card layout, setting tooltips, tooltip width fix ([e085863e](https://github.com/debuglebowski/slayzone/commit/e085863e))
- **cards:** Linear-style priority icons, interactive card popovers, shared TagSelector ([dcb72f4e](https://github.com/debuglebowski/slayzone/commit/dcb72f4e))
- **tasks:** Tag editing in context menu, red lightning prio icon ([ba60e27f](https://github.com/debuglebowski/slayzone/commit/ba60e27f))
- **editor:** Unified content theme system for terminal + editors ([290681c4](https://github.com/debuglebowski/slayzone/commit/290681c4))
- **leaderboard:** Background stats sync every 12 hours ([95db2ca6](https://github.com/debuglebowski/slayzone/commit/95db2ca6))
- **task:** Project-scoped task templates ([1396e96f](https://github.com/debuglebowski/slayzone/commit/1396e96f))
- **terminal:** Loop command — repeat prompt until acceptance criteria met ([fe79da91](https://github.com/debuglebowski/slayzone/commit/fe79da91))
- **cli:** Resolve --status by label or slug, not just exact ID ([19159f69](https://github.com/debuglebowski/slayzone/commit/19159f69))
- **file-editor:** Add file tree power features — multi-select, copy/paste, keyboard nav, symlinks ([a127dd94](https://github.com/debuglebowski/slayzone/commit/a127dd94))
- **file-editor:** Git status colors + compact folders in file tree ([2d708190](https://github.com/debuglebowski/slayzone/commit/2d708190))
- **task:** Apply task templates to temporary tasks ([5bf7ed0f](https://github.com/debuglebowski/slayzone/commit/5bf7ed0f))
- **task:** Snooze tasks — hide from board until a future time ([815f7bdc](https://github.com/debuglebowski/slayzone/commit/815f7bdc))
- **task:** Snooze UX — icons, more presets, custom dialog ([bee12ebb](https://github.com/debuglebowski/slayzone/commit/bee12ebb))
- **tasks:** Blocked & snoozed virtual kanban columns ([6c6d5b64](https://github.com/debuglebowski/slayzone/commit/6c6d5b64))
- **task-terminals:** Right-click context menu for terminal panes ([e03afbf7](https://github.com/debuglebowski/slayzone/commit/e03afbf7))
- **editor:** Migrate task description editor from TipTap to Milkdown ([685761a0](https://github.com/debuglebowski/slayzone/commit/685761a0))
- **cli:** Add `slay init` command for agent configuration templates ([e618faa7](https://github.com/debuglebowski/slayzone/commit/e618faa7))
- **automations:** Add beta pill to panel header ([d2d4ab3b](https://github.com/debuglebowski/slayzone/commit/d2d4ab3b))
- **settings:** Unified theme system with per-section overrides ([06811dba](https://github.com/debuglebowski/slayzone/commit/06811dba))
- **automations:** Add automations domain package ([ca6befbc](https://github.com/debuglebowski/slayzone/commit/ca6befbc))
- **app:** Integrate automations domain + wire IPC ([89577b9d](https://github.com/debuglebowski/slayzone/commit/89577b9d))
- **settings:** Add unified theme definitions + clean up settings dialog ([31273061](https://github.com/debuglebowski/slayzone/commit/31273061))

### 🔥 Performance

- **renderer:** Code-split bundle 7.3MB→3.3MB, always open to kanban ([04d98b68](https://github.com/debuglebowski/slayzone/commit/04d98b68))

### 🩹 Fixes

- **terminal:** Prevent permanent loading state when PTY dies silently ([9ccffe6f](https://github.com/debuglebowski/slayzone/commit/9ccffe6f))
- **worktrees:** Handle unicode filenames and null paths in git diff ([174f6520](https://github.com/debuglebowski/slayzone/commit/174f6520))
- **task:** Notify renderer on all task mutations for cross-view sync ([9ea041ad](https://github.com/debuglebowski/slayzone/commit/9ea041ad))
- **cli:** Populate provider_config and default flags on task/subtask creation ([ca6219d5](https://github.com/debuglebowski/slayzone/commit/ca6219d5))
- **shortcuts:** Let app shortcuts fire inside contenteditable editors ([eb335692](https://github.com/debuglebowski/slayzone/commit/eb335692))
- **terminal:** Restore focus after image paste/drop ([c837c894](https://github.com/debuglebowski/slayzone/commit/c837c894))
- **automations:** Use correct task column names in template context query ([977fd8c9](https://github.com/debuglebowski/slayzone/commit/977fd8c9))
- **ui:** Remove fixed max-width from tooltips for dynamic sizing ([0ef832c9](https://github.com/debuglebowski/slayzone/commit/0ef832c9))
- **terminal:** Extend link range through soft-continuation URL lines ([319db2d2](https://github.com/debuglebowski/slayzone/commit/319db2d2))
- **task-browser:** Dropdown/context menus hidden behind WebContentsView ([21943a6f](https://github.com/debuglebowski/slayzone/commit/21943a6f))
- **file-editor:** Selection invisible on active line in code editor ([3f9bf71c](https://github.com/debuglebowski/slayzone/commit/3f9bf71c))

### 💅 Refactors

- **task:** Extract subtask/tag state into dedicated hooks with external refresh ([66ed2673](https://github.com/debuglebowski/slayzone/commit/66ed2673))
- **tags:** Move tags settings to project level, card layout ([f796b391](https://github.com/debuglebowski/slayzone/commit/f796b391))
- **terminal:** Simplify loop command — remove redundant state, fix tab linger ([514d4943](https://github.com/debuglebowski/slayzone/commit/514d4943))
- **task:** Extract process config into modal dialog ([349fecbb](https://github.com/debuglebowski/slayzone/commit/349fecbb))
- **file-editor:** Use unified theme context ([8f862cd8](https://github.com/debuglebowski/slayzone/commit/8f862cd8))

### 📖 Documentation

- **skill:** Add plain-language writing guidelines to release skill ([370109fd](https://github.com/debuglebowski/slayzone/commit/370109fd))
- **comparison:** Add Codex Monitor, Jean, Polyscope, VibeKanban canonical records ([f35dd8bf](https://github.com/debuglebowski/slayzone/commit/f35dd8bf))
- **comparison:** Add Claude Code canonical competitor record ([65bb6384](https://github.com/debuglebowski/slayzone/commit/65bb6384))
- **comparison:** Add Jean product screenshot for publish-ready ([cf0815a0](https://github.com/debuglebowski/slayzone/commit/cf0815a0))
- **comparison:** Add OpenAI Codex CLI canonical record ([a0355824](https://github.com/debuglebowski/slayzone/commit/a0355824))
- **comparison:** Migrate Superset.sh to canonical publish-ready record ([5a404213](https://github.com/debuglebowski/slayzone/commit/5a404213))
- **comparison:** Migrate AutoClaude to canonical publish-ready record ([73f04419](https://github.com/debuglebowski/slayzone/commit/73f04419))
- **comparison:** Add OpenAI Codex App analysis ([9b6d6266](https://github.com/debuglebowski/slayzone/commit/9b6d6266))

### 🏡 Chore

- **nix:** Update sources to 0.11.0 ([b492b1d1](https://github.com/debuglebowski/slayzone/commit/b492b1d1))
- Update commit-changes skill ([079cde1e](https://github.com/debuglebowski/slayzone/commit/079cde1e))
- Supporting updates for theme + automations ([13e7416f](https://github.com/debuglebowski/slayzone/commit/13e7416f))

### ✅ Tests

- **cli:** Verify provider_config populated on create and subtask-add ([911911c3](https://github.com/debuglebowski/slayzone/commit/911911c3))
- **automations:** Add missing engine and handler tests ([96483c8c](https://github.com/debuglebowski/slayzone/commit/96483c8c))

### ❤️ Contributors

- Debuglebowski

## v0.11.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.10.0...v0.11.0)

### 🚀 Enhancements

- **projects:** Add drag-and-drop reordering to sidebar project list ([#44](https://github.com/debuglebowski/slayzone/pull/44))
- **task:** Add vertical expand/collapse for description editor ([78e0b6c2](https://github.com/debuglebowski/slayzone/commit/78e0b6c2))
- **editor:** Add Alt+Up/Down shortcuts to move list items ([#47](https://github.com/debuglebowski/slayzone/pull/47))
- **terminal:** Expose PTY sessions via REST API and CLI ([0a742cea](https://github.com/debuglebowski/slayzone/commit/0a742cea))
- **providers:** Add GitHub Copilot CLI integration ([767cc008](https://github.com/debuglebowski/slayzone/commit/767cc008))
- **editor:** Add notes editor settings and formatting toolbar ([#50](https://github.com/debuglebowski/slayzone/pull/50))
- **ai-config:** Validate missing description in skill frontmatter ([2915d5d7](https://github.com/debuglebowski/slayzone/commit/2915d5d7))
- **browser:** Open Cmd+Click and middle-click links as new tabs ([71c196e2](https://github.com/debuglebowski/slayzone/commit/71c196e2))
- **integrations:** Filter Linear import and sync by assignee ([e74bb09a](https://github.com/debuglebowski/slayzone/commit/e74bb09a))

### 🩹 Fixes

- **task:** Await worktree auto-create before returning task ([e5466355](https://github.com/debuglebowski/slayzone/commit/e5466355))
- **leaderboard:** Use built-in usage analytics instead of external ccusage CLI ([d09a6bdc](https://github.com/debuglebowski/slayzone/commit/d09a6bdc))
- **usage-analytics:** Search XDG_CONFIG_HOME for Claude Code logs ([3382e214](https://github.com/debuglebowski/slayzone/commit/3382e214))
- **terminal:** Pass actual dims to PTY creation instead of hardcoded 80x24 ([6b0fbeb2](https://github.com/debuglebowski/slayzone/commit/6b0fbeb2))
- **editor:** Clean up list-item-move from PR #47 review ([#47](https://github.com/debuglebowski/slayzone/issues/47))
- Improve error detection and terminal tab distinction ([b765b1a1](https://github.com/debuglebowski/slayzone/commit/b765b1a1))
- Narrow session regex and derive supported-provider list from registry ([6dd14d8f](https://github.com/debuglebowski/slayzone/commit/6dd14d8f))
- **editor:** React import, spellcheck reactivity, rename settings label ([f88800fa](https://github.com/debuglebowski/slayzone/commit/f88800fa))
- **editor:** Align task list checkbox with text vertically ([7fad6600](https://github.com/debuglebowski/slayzone/commit/7fad6600))
- **terminal:** Write PTY data to xterm even when tab is inactive ([5110fd1f](https://github.com/debuglebowski/slayzone/commit/5110fd1f))
- **terminal:** Read Claude credentials from file on Linux/Windows ([#51](https://github.com/debuglebowski/slayzone/pull/51))
- **worktrees:** Link task to worktree before post-creation steps ([3a3065fc](https://github.com/debuglebowski/slayzone/commit/3a3065fc))
- **editor:** Tighten task list checkbox alignment and spacing ([b0cccacc](https://github.com/debuglebowski/slayzone/commit/b0cccacc))
- **editor:** Move spellcheck to wrapper div to avoid TipTap view race ([503da8e8](https://github.com/debuglebowski/slayzone/commit/503da8e8))
- **processes:** Kill entire process tree on stop, not just shell wrapper ([bd2daf91](https://github.com/debuglebowski/slayzone/commit/bd2daf91))
- **task:** Match sub-tasks header height to description header ([43967717](https://github.com/debuglebowski/slayzone/commit/43967717))
- **terminal:** Stop unnecessary detach-reattach cycles on parent re-render ([663fc253](https://github.com/debuglebowski/slayzone/commit/663fc253))

### 💅 Refactors

- **task:** Rework description/sub-tasks into collapsible card pattern ([8544ab7a](https://github.com/debuglebowski/slayzone/commit/8544ab7a))

### 📖 Documentation

- **comparison:** Establish canon structure and skills ([352cfaf2](https://github.com/debuglebowski/slayzone/commit/352cfaf2))
- **comparison:** Migrate Conductor to canonical record ([d7748f54](https://github.com/debuglebowski/slayzone/commit/d7748f54))
- **skill:** Add screenshot rules to competitor-research ([4cce3e2c](https://github.com/debuglebowski/slayzone/commit/4cce3e2c))

### 🏡 Chore

- **nix:** Update sources to 0.10.0 ([37767ee7](https://github.com/debuglebowski/slayzone/commit/37767ee7))
- **skills:** Sync comparison skills across providers ([74c8f009](https://github.com/debuglebowski/slayzone/commit/74c8f009))

### ❤️ Contributors

- Debuglebowski
- Sfarestam
- Stefan Farestam
- Kdrapel ([@kdrapel](https://github.com/kdrapel))
- Adam Scott ([@adamsco](https://github.com/adamsco))

## v0.10.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.9.0...v0.10.0)

### 🚀 Enhancements

- Add Qwen Code CLI integration - Add qwen-code terminal adapter with session detection, error handling, and validation - Register Qwen Code in AI config provider registry with MCP support - Update onboarding dialog and task detail UI to include Qwen Code option ([dda85049](https://github.com/debuglebowski/slayzone/commit/dda85049))
- **usage-analytics:** Add Qwen Code usage tracking parser - Add parseQwenFiles() to parse ~/.qwen/projects/<project>/chats/*.jsonl - Integrate Qwen parser into refreshUsageData cache refresh - Add qwen-code provider to PROVIDER_USAGE_SUPPORT - Update UI messaging to include Qwen in supported providers ([9b27735c](https://github.com/debuglebowski/slayzone/commit/9b27735c))
- **provider:** Add support for Qwen ([7493dd1f](https://github.com/debuglebowski/slayzone/commit/7493dd1f))
- **release:** Group discord notification items by category ([cb784232](https://github.com/debuglebowski/slayzone/commit/cb784232))
- **browser:** Screenshot browser view directly instead of region selection ([d6633816](https://github.com/debuglebowski/slayzone/commit/d6633816))

### 🩹 Fixes

- Add missing Qwen entry for migration ([23bd7af8](https://github.com/debuglebowski/slayzone/commit/23bd7af8))
- Improve terminal adapters and usage analytics parsers ([760d5d5d](https://github.com/debuglebowski/slayzone/commit/760d5d5d))
- **provider:** Qwen adapter error check on stripped data, parser dedup collision ([f5fd4253](https://github.com/debuglebowski/slayzone/commit/f5fd4253))
- **shortcuts:** Disable global shortcuts when modal dialogs are open ([#46](https://github.com/debuglebowski/slayzone/pull/46))
- **browser:** Let native edit shortcuts pass through to browser view ([d310f2c8](https://github.com/debuglebowski/slayzone/commit/d310f2c8))
- **browser:** Use mainFrame.executeJavaScript for browser view JS execution ([8b0ae88c](https://github.com/debuglebowski/slayzone/commit/8b0ae88c))

### 💅 Refactors

- **shortcuts:** Replace manual modal guards with useGuardedHotkeys + withModalGuard ([9f743695](https://github.com/debuglebowski/slayzone/commit/9f743695))

### 🏡 Chore

- **nix:** Update sources to 0.9.0 ([1545845c](https://github.com/debuglebowski/slayzone/commit/1545845c))

### ❤️ Contributors

- Debuglebowski
- Adam Scott ([@adamsco](https://github.com/adamsco))
- Kdrapel ([@kdrapel](https://github.com/kdrapel))

## v0.9.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.8.0...v0.9.0)

### 🚀 Enhancements

- **shortcuts:** Add Cmd+Alt+R terminal restart and Cmd+L browser URL focus ([8da253a](https://github.com/debuglebowski/slayzone/commit/8da253a))
- **shortcuts:** Show ⌘⌥R hint in terminal restart dropdown menu item ([774418f](https://github.com/debuglebowski/slayzone/commit/774418f))
- **browser:** Add loading animation before first page load ([d7ca198](https://github.com/debuglebowski/slayzone/commit/d7ca198))
- **browser:** Auto-open panel on CLI navigate, add --panel flag ([7394cd5](https://github.com/debuglebowski/slayzone/commit/7394cd5))
- **feedback:** Add GitHub/Discord banner to feedback dialog ([7677dd3](https://github.com/debuglebowski/slayzone/commit/7677dd3))
- **feedback:** Widen dialog to 1100px, reduce height to 60vh ([db7a333](https://github.com/debuglebowski/slayzone/commit/db7a333))
- **shortcuts:** Add Cmd+Shift+A shortcut for attention panel ([13a6e60](https://github.com/debuglebowski/slayzone/commit/13a6e60))
- **ai-config:** Improve skill frontmatter workflow ([c052cd3](https://github.com/debuglebowski/slayzone/commit/c052cd3))
- **skills:** Update local skill definitions ([375695a](https://github.com/debuglebowski/slayzone/commit/375695a))

### 🩹 Fixes

- **terminal:** Prevent stuck loading spinner on task reopen ([8cddb07](https://github.com/debuglebowski/slayzone/commit/8cddb07))
- **shortcuts:** Use e.code fallback for macOS Alt dead-key characters ([db9c2a3](https://github.com/debuglebowski/slayzone/commit/db9c2a3))
- **processes:** Resolve user PATH from interactive shell for spawned processes ([04cef9a](https://github.com/debuglebowski/slayzone/commit/04cef9a))
- **terminal:** Handle OSC 8 links, add hover tooltips, restore pointer cursor ([4f1cf49](https://github.com/debuglebowski/slayzone/commit/4f1cf49))
- **usage:** Enforce rate-limit backoff for all providers, show stale data on error ([b8b4110](https://github.com/debuglebowski/slayzone/commit/b8b4110))

### 💅 Refactors

- **shortcuts:** Replace hardcoded shortcut displays with useShortcutDisplay hook ([5a3814d](https://github.com/debuglebowski/slayzone/commit/5a3814d))

### ❤️ Contributors

- Debuglebowski

## v0.8.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.7.0...v0.8.0)

### 🚀 Enhancements

- **cli:** Add --description flag to create, update, subtask-add ([#43](https://github.com/debuglebowski/slayzone/pull/43))
- **task:** Set converted temporary tasks to in-progress status ([9fb165a](https://github.com/debuglebowski/slayzone/commit/9fb165a))
- **ui:** Add close button to toast notifications ([dd75c79](https://github.com/debuglebowski/slayzone/commit/dd75c79))
- Add shortcut definitions registry and display utilities ([3c67aad](https://github.com/debuglebowski/slayzone/commit/3c67aad))
- Add Zustand shortcut store with IPC wiring ([f63880b](https://github.com/debuglebowski/slayzone/commit/f63880b))
- Add KeyRecorder component for shortcut capture ([819c605](https://github.com/debuglebowski/slayzone/commit/819c605))
- Make shortcuts dialog interactive with rebinding support ([da51bb0](https://github.com/debuglebowski/slayzone/commit/da51bb0))
- Use dynamic shortcut bindings in App.tsx hotkey handlers ([fd76ad2](https://github.com/debuglebowski/slayzone/commit/fd76ad2))
- Rebuild Electron menu on shortcut changes ([49d76be](https://github.com/debuglebowski/slayzone/commit/49d76be))
- Wire Task Panels and Terminal shortcuts to shortcut store ([816d695](https://github.com/debuglebowski/slayzone/commit/816d695))
- Warn about cross-scope shortcut shadows ([951c2dd](https://github.com/debuglebowski/slayzone/commit/951c2dd))
- **worktree:** Multi-fallback branch cleanup on worktree removal ([fa9fb72](https://github.com/debuglebowski/slayzone/commit/fa9fb72))
- **shortcuts:** Register missing shortcuts, wire TaskDetailPage to store ([66b8232](https://github.com/debuglebowski/slayzone/commit/66b8232))
- **changelog:** Auto-expand all new versions in What's New dialog ([77a1876](https://github.com/debuglebowski/slayzone/commit/77a1876))

### 🩹 Fixes

- **task:** Make task/project props instead of local state to fix stale cwd ([#38](https://github.com/debuglebowski/slayzone/pull/38))
- **cli:** Use uniform === undefined guard in tasks update ([19007e2](https://github.com/debuglebowski/slayzone/commit/19007e2))
- Swap keys on conflict reassign instead of removing override ([dcac80b](https://github.com/debuglebowski/slayzone/commit/dcac80b))
- Ensure App.tsx re-renders on shortcut override changes ([c98ad72](https://github.com/debuglebowski/slayzone/commit/c98ad72))
- Address PR review feedback ([fdba31e](https://github.com/debuglebowski/slayzone/commit/fdba31e))
- **ci:** Grant contents:write to release PR dry-run workflow ([033cf6b](https://github.com/debuglebowski/slayzone/commit/033cf6b))

### 💅 Refactors

- Remove unused isCustomized and removeOverride from shortcut store ([b4e0c34](https://github.com/debuglebowski/slayzone/commit/b4e0c34))
- **shortcuts:** Extract @slayzone/shortcuts package, fix before-input-event overrides ([dd1ac20](https://github.com/debuglebowski/slayzone/commit/dd1ac20))

### 🏡 Chore

- **nix:** Update sources to 0.7.0 ([3d98c4c](https://github.com/debuglebowski/slayzone/commit/3d98c4c))
- **website:** Replace legacy build with @astrojs/sitemap ([f5f4ae0](https://github.com/debuglebowski/slayzone/commit/f5f4ae0))

### ✅ Tests

- Add unit tests for shortcut utilities and E2E for custom shortcuts ([a1abd98](https://github.com/debuglebowski/slayzone/commit/a1abd98))

### ❤️ Contributors

- Debuglebowski
- Adam Scott ([@adamsco](https://github.com/adamsco))
- TheoBerglin

## v0.7.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.6.1...v0.7.0)

### 🚀 Enhancements

- **platform:** Add @slayzone/platform package with Linux XDG compliance ([314156e](https://github.com/debuglebowski/slayzone/commit/314156e))
- **platform:** Cross-platform CLI install via @slayzone/platform ([0ef2a96](https://github.com/debuglebowski/slayzone/commit/0ef2a96))
- **terminal:** Shell fallback + session-not-found on CLI crash ([715cc64](https://github.com/debuglebowski/slayzone/commit/715cc64))
- **task:** Clickable status icon in task header ([d2e572b](https://github.com/debuglebowski/slayzone/commit/d2e572b))
- **tasks:** Add status icons to kanban column headers ([5e26ae9](https://github.com/debuglebowski/slayzone/commit/5e26ae9))
- **worktree:** Branch deletion on remove, fix listBranches regex ([d628330](https://github.com/debuglebowski/slayzone/commit/d628330))
- **backup:** Auto-backup database before schema migrations ([aefa768](https://github.com/debuglebowski/slayzone/commit/aefa768))
- **website:** Add "Developers love SlayZone" testimonials section ([51d6e80](https://github.com/debuglebowski/slayzone/commit/51d6e80))
- **website:** Add "fall in love with terminals" deep-ocean banner ([15d8905](https://github.com/debuglebowski/slayzone/commit/15d8905))
- **website:** Rename testimonials heading, add Drizzle testimonial ([f85811a](https://github.com/debuglebowski/slayzone/commit/f85811a))
- **website:** Add canonical tags to all pages ([bb0ed50](https://github.com/debuglebowski/slayzone/commit/bb0ed50))
- **task:** Add scroll support for sub-task list ([77c5c21](https://github.com/debuglebowski/slayzone/commit/77c5c21))
- **website:** Add features page with animated sections ([246a564](https://github.com/debuglebowski/slayzone/commit/246a564))
- **browser:** Add keyboard capture toggle for browser panel ([21b6974](https://github.com/debuglebowski/slayzone/commit/21b6974))
- **website:** Refine features page animations and add sections 2-4 ([531fd97](https://github.com/debuglebowski/slayzone/commit/531fd97))
- **worktree:** Copy presets for ignored files ([e5e524e](https://github.com/debuglebowski/slayzone/commit/e5e524e))
- **website:** Rebuild section 6 diff + section 7 commit graph with SVG, scroll animation ([4176e3f](https://github.com/debuglebowski/slayzone/commit/4176e3f))
- **website:** Unhide section 8 PR with terminal split layout ([85edaed](https://github.com/debuglebowski/slayzone/commit/85edaed))
- **website:** Unhide section 9 editor with filetree toggle, file tabs ([e4d7524](https://github.com/debuglebowski/slayzone/commit/e4d7524))
- **website:** Unhide sections 10 processes + 9 editor title, process card layout ([3208b8f](https://github.com/debuglebowski/slayzone/commit/3208b8f))
- **website:** Unhide section 11 usage popover with cursor animation, blurred terminal bg ([7c73fdb](https://github.com/debuglebowski/slayzone/commit/7c73fdb))
- **website:** Rebuild section 12 usage stats with dashboard layout, area chart, stat cards ([39bc76b](https://github.com/debuglebowski/slayzone/commit/39bc76b))
- **website:** Unhide sections 11-13, integrations hub animation, logo asset ([c6ee488](https://github.com/debuglebowski/slayzone/commit/c6ee488))
- **website:** Unhide sections 14-16, app shell for all, explode grid, attention cursor animation ([e68a9ea](https://github.com/debuglebowski/slayzone/commit/e68a9ea))
- **browser:** Migrate browser panel from webview to WebContentsView ([fb652ef](https://github.com/debuglebowski/slayzone/commit/fb652ef))
- **website:** Migrate site to astro ([d395833](https://github.com/debuglebowski/slayzone/commit/d395833))
- **browser:** Show pause overlay when popover overlaps WebContentsView ([4ee5b9d](https://github.com/debuglebowski/slayzone/commit/4ee5b9d))

### 🩹 Fixes

- **file-editor:** Hide scrollbar on editor tab bar ([853e076](https://github.com/debuglebowski/slayzone/commit/853e076))
- **platform:** Validate CLI source exists before creating symlink ([499886a](https://github.com/debuglebowski/slayzone/commit/499886a))
- **platform:** Validate CLI source on Windows, add cleanup TODOs ([97f21da](https://github.com/debuglebowski/slayzone/commit/97f21da))
- **platform:** Guard Windows shim write, add migration tests ([9c8b5e3](https://github.com/debuglebowski/slayzone/commit/9c8b5e3))
- **platform:** Port tests to vitest, show-once migration dialog, cleanup ([d7a403d](https://github.com/debuglebowski/slayzone/commit/d7a403d))
- **file-editor:** Load persisted expanded folders on mount ([a5c3351](https://github.com/debuglebowski/slayzone/commit/a5c3351))
- **website:** Add www→apex 301 redirect for Cloudflare Pages ([f6efd62](https://github.com/debuglebowski/slayzone/commit/f6efd62))
- **worktree:** Normalize relative paths, reset sessions on worktree change ([2a1f781](https://github.com/debuglebowski/slayzone/commit/2a1f781))
- **app:** Recover from renderer crashes by reloading on render-process-gone ([d346d45](https://github.com/debuglebowski/slayzone/commit/d346d45))
- **integrations:** Backoff discovery polling when offline ([0cc736f](https://github.com/debuglebowski/slayzone/commit/0cc736f))
- **integrations:** Sanitize Jira domain input, improve fetch error message ([0340089](https://github.com/debuglebowski/slayzone/commit/0340089))
- **processes:** Spawn via user shell instead of /bin/sh ([5043dad](https://github.com/debuglebowski/slayzone/commit/5043dad))
- **app:** Recover from renderer crash, enrich crash diagnostics ([c00f489](https://github.com/debuglebowski/slayzone/commit/c00f489))
- **backup:** Clean up old migration backups, keep last 3 ([1909517](https://github.com/debuglebowski/slayzone/commit/1909517))
- **browser:** Handle webview load failures to prevent renderer crash ([3bba164](https://github.com/debuglebowski/slayzone/commit/3bba164))
- **terminal:** Support Shift+Enter for newline in AI mode prompts ([#37](https://github.com/debuglebowski/slayzone/pull/37))
- **terminal:** Remove unused toast import and variables ([266f415](https://github.com/debuglebowski/slayzone/commit/266f415))
- **cwd:** Fall back to project root when no repo selected ([#41](https://github.com/debuglebowski/slayzone/pull/41))
- **task:** Clear worktree fields + conversation IDs only on actual project change ([57baf8e](https://github.com/debuglebowski/slayzone/commit/57baf8e))

### 💅 Refactors

- **settings:** Decouple leaderboard/usage-analytics from tab system ([bd76d7a](https://github.com/debuglebowski/slayzone/commit/bd76d7a))
- **worktree:** Remove "remember for project" from copy dialog ([3d8b073](https://github.com/debuglebowski/slayzone/commit/3d8b073))
- **website:** Rebuild section 5 git panel with SVG graph, card layout, diff ([6e4a820](https://github.com/debuglebowski/slayzone/commit/6e4a820))
- **website:** Unify section 5/6 layout, move diff to dedicated section ([f101b97](https://github.com/debuglebowski/slayzone/commit/f101b97))
- **terminal:** Require Cmd+Click for links, remove pointer cursor ([1a514ff](https://github.com/debuglebowski/slayzone/commit/1a514ff))
- **task:** Remove pid and timer from process items ([c11da43](https://github.com/debuglebowski/slayzone/commit/c11da43))
- **website:** Section 16 terminal→kanban animation, faster timing, fix reset flash ([0668dcf](https://github.com/debuglebowski/slayzone/commit/0668dcf))

### 📖 Documentation

- **website:** Update features page section titles and descriptions ([41992b9](https://github.com/debuglebowski/slayzone/commit/41992b9))
- **browser:** Working note for WebContentsView migration ([29de01a](https://github.com/debuglebowski/slayzone/commit/29de01a))
- **browser:** Platform options research note ([e77d1e1](https://github.com/debuglebowski/slayzone/commit/e77d1e1))

### 🏡 Chore

- **nix:** Update sources to 0.6.1 ([7d8b5ac](https://github.com/debuglebowski/slayzone/commit/7d8b5ac))
- **website:** Tweak testimonials title, remove subtitle, nerf VS Code dopamine ([7d3bb00](https://github.com/debuglebowski/slayzone/commit/7d3bb00))
- Upgrade electron 39→41, electron-builder 25→26 ([f7e90ac](https://github.com/debuglebowski/slayzone/commit/f7e90ac))
- **website:** Increase worktree animation size, tighten spacing ([73b1b99](https://github.com/debuglebowski/slayzone/commit/73b1b99))
- **website:** Swap diff/commits order, increase git panel display time ([55ccabd](https://github.com/debuglebowski/slayzone/commit/55ccabd))
- Relicense from Apache 2.0 to GPL v3 ([afddd80](https://github.com/debuglebowski/slayzone/commit/afddd80))
- Add website to pnpm workspace, update build scripts ([14ffe7f](https://github.com/debuglebowski/slayzone/commit/14ffe7f))

### ✅ Tests

- **browser:** E2E tests for WebContentsView browser panel ([a565ac0](https://github.com/debuglebowski/slayzone/commit/a565ac0))

### ❤️ Contributors

- Debuglebowski
- Shivansh Singh ([@wise-toddler](https://github.com/wise-toddler))
- Adam Scott ([@adamsco](https://github.com/adamsco))

## v0.6.1

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.5.0...v0.6.1)

### 🚀 Enhancements

- Show process titles on terminal tabs and process rows ([c837e8f](https://github.com/debuglebowski/slayzone/commit/c837e8f))
- **file-editor:** Add refresh button to file tree sidebar ([74ce25f](https://github.com/debuglebowski/slayzone/commit/74ce25f))
- **usage:** Add 2x boost pill indicator for Anthropic Spring Break promo ([4b2364f](https://github.com/debuglebowski/slayzone/commit/4b2364f))
- **projects:** Add multi-repo support with auto-detection ([37860ba](https://github.com/debuglebowski/slayzone/commit/37860ba))
- **telemetry:** Inline dev PostHog key for local usage tracking ([cb95631](https://github.com/debuglebowski/slayzone/commit/cb95631))
- **integrations:** Add Jira Cloud integration behind labs flag ([4f5b13a](https://github.com/debuglebowski/slayzone/commit/4f5b13a))
- Make processes panel, integrations, and jira generally available ([27b5a83](https://github.com/debuglebowski/slayzone/commit/27b5a83))
- **terminal:** Show process names on terminal tabs with duplicate numbering ([682ee5b](https://github.com/debuglebowski/slayzone/commit/682ee5b))
- **integrations:** Put Jira integration behind labs flag ([5b76228](https://github.com/debuglebowski/slayzone/commit/5b76228))

### 🩹 Fixes

- **file-editor:** Clear collapsed folder cache on fs change ([643d0c2](https://github.com/debuglebowski/slayzone/commit/643d0c2))
- **usage:** Normalize spacers around boost pill and usage bars to w-4 ([8ce4f5f](https://github.com/debuglebowski/slayzone/commit/8ce4f5f))
- **usage:** Improve boost pill popover layout and fix promo link ([19622f6](https://github.com/debuglebowski/slayzone/commit/19622f6))

### 💅 Refactors

- **integrations:** Extract ProviderAdapter interface for Linear/GitHub ([b33cfb6](https://github.com/debuglebowski/slayzone/commit/b33cfb6))
- **integrations:** Add generic provider-dispatched IPC + useProviderData hook ([d20a527](https://github.com/debuglebowski/slayzone/commit/d20a527))

### 🏡 Chore

- **nix:** Update sources to 0.5.0 ([861a9c4](https://github.com/debuglebowski/slayzone/commit/861a9c4))

### ❤️ Contributors

- Debuglebowski

## v0.5.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- **task:** Add fullscreen description dialog, remove AI generation ([4c0f3a4](https://github.com/debuglebowski/slayzone/commit/4c0f3a4))
- **processes:** Add per-process stats (duration, CPU, memory, restart count) ([aa84716](https://github.com/debuglebowski/slayzone/commit/aa84716))
- **telemetry:** Add 87 feature usage analytics events via hybrid IPC+inline approach ([508bc43](https://github.com/debuglebowski/slayzone/commit/508bc43))
- **terminal:** Add CPU/memory/duration stats to Active Terminals popover ([c84e895](https://github.com/debuglebowski/slayzone/commit/c84e895))
- **terminal:** Add pulse grid loading animation ([5342e75](https://github.com/debuglebowski/slayzone/commit/5342e75))
- **task:** Replace manual loading state with React Suspense ([9989bdb](https://github.com/debuglebowski/slayzone/commit/9989bdb))
- **usage-analytics:** Add usage analytics domain with token tracking ([c41948b](https://github.com/debuglebowski/slayzone/commit/c41948b))
- **worktrees:** Handle diverged local/remote branches in commit graph ([354aabd](https://github.com/debuglebowski/slayzone/commit/354aabd))
- **sidebar:** Move leaderboard + usage buttons to sidebar footer ([b77b1a7](https://github.com/debuglebowski/slayzone/commit/b77b1a7))
- **telemetry:** Add exception autocapture for opted-in users ([63b24ef](https://github.com/debuglebowski/slayzone/commit/63b24ef))
- **tasks:** Support dropping tasks into empty list-view groups ([b5ca241](https://github.com/debuglebowski/slayzone/commit/b5ca241))
- **terminal:** Add clickable URLs via inline link provider ([d46b794](https://github.com/debuglebowski/slayzone/commit/d46b794))
- **terminal:** Add clickable file paths + modifier key routing ([87b6061](https://github.com/debuglebowski/slayzone/commit/87b6061))
- **terminal:** Add one-time toast hints for Cmd+Shift+Click ([48d4c0a](https://github.com/debuglebowski/slayzone/commit/48d4c0a))
- **usage:** Add keychain auth type for custom usage providers ([7e224cf](https://github.com/debuglebowski/slayzone/commit/7e224cf))
- **terminal:** Detect soft-wrapped URLs across non-wrapped lines ([9d6209f](https://github.com/debuglebowski/slayzone/commit/9d6209f))
- **website:** Add cookieless PostHog analytics via managed proxy ([7516e93](https://github.com/debuglebowski/slayzone/commit/7516e93))
- **worktrees:** Replace rebase/merge buttons with sync dropdown and merge-to-parent ([2a47f80](https://github.com/debuglebowski/slayzone/commit/2a47f80))
- **perf:** Startup performance marks, suspense cache prefetch, drop PostHogProvider ([7cf9444](https://github.com/debuglebowski/slayzone/commit/7cf9444))
- **website:** Track download and GitHub button clicks ([3b2d91f](https://github.com/debuglebowski/slayzone/commit/3b2d91f))
- **worktrees:** Add "Use existing branch" option to worktree creation dropdown ([b232ceb](https://github.com/debuglebowski/slayzone/commit/b232ceb))
- **terminal:** Add Cmd+Up/Down shortcuts to scroll to top/bottom ([ef238a1](https://github.com/debuglebowski/slayzone/commit/ef238a1))

### 🩹 Fixes

- **worktrees:** Return empty array when repo has no git remotes ([72e6db6](https://github.com/debuglebowski/slayzone/commit/72e6db6))
- Guard webContents.send() against disposed render frames ([3619c26](https://github.com/debuglebowski/slayzone/commit/3619c26))
- **worktrees:** Exclude OS/editor artifacts from worktree file copy ([70aaba4](https://github.com/debuglebowski/slayzone/commit/70aaba4))
- **task:** Equalize task detail padding ([3e0bf79](https://github.com/debuglebowski/slayzone/commit/3e0bf79))
- **terminal:** Show loading state during buffer replay on tab activation ([1951314](https://github.com/debuglebowski/slayzone/commit/1951314))
- **mcp:** Use dynamic port allocation to prevent EADDRINUSE on restart ([1015e2a](https://github.com/debuglebowski/slayzone/commit/1015e2a))
- **nix:** Glob .desktop file in AppImage extraction ([eba2127](https://github.com/debuglebowski/slayzone/commit/eba2127))
- **browser:** Improve CAPTCHA compatibility in webview ([bd160ab](https://github.com/debuglebowski/slayzone/commit/bd160ab))
- **browser:** Guard disposed frames, allow OAuth popups, remove stale chrome API fakes ([0406b34](https://github.com/debuglebowski/slayzone/commit/0406b34))
- **browser:** Skip tab creation for new-window popup disposition ([d729325](https://github.com/debuglebowski/slayzone/commit/d729325))
- **browser:** Spoof navigator.userAgentData, skip hardening in OAuth popups ([f5e8cad](https://github.com/debuglebowski/slayzone/commit/f5e8cad))
- **browser:** Drop webPreferences override from OAuth popup options ([4c342e8](https://github.com/debuglebowski/slayzone/commit/4c342e8))
- **worktrees:** Use async fs ops in copyIgnoredFiles to prevent UI freeze ([4b89c04](https://github.com/debuglebowski/slayzone/commit/4b89c04))
- **tutorial:** Scale scene animation to fit smaller viewports ([3ef15bd](https://github.com/debuglebowski/slayzone/commit/3ef15bd))
- **worktrees:** Correct graph layout for diverged branches ([470099c](https://github.com/debuglebowski/slayzone/commit/470099c))

### 💅 Refactors

- **worktrees:** Redesign copy-files dialog with card-based mode picker ([cdf496c](https://github.com/debuglebowski/slayzone/commit/cdf496c))
- **task-terminals:** Remove redundant loading state from TerminalContainer ([cfd3181](https://github.com/debuglebowski/slayzone/commit/cfd3181))
- **terminal:** Remove unused useCallback import ([f95c1ee](https://github.com/debuglebowski/slayzone/commit/f95c1ee))
- **app:** Extract 5 self-contained hooks from App.tsx ([a5f8876](https://github.com/debuglebowski/slayzone/commit/a5f8876))
- **app:** Extract dialog state from App.tsx into zustand store ([de13d6e](https://github.com/debuglebowski/slayzone/commit/de13d6e))

### 📖 Documentation

- Add webauthn-passkeys research notes ([051c982](https://github.com/debuglebowski/slayzone/commit/051c982))

### 🏡 Chore

- **nix:** Update sources to 0.4.0 ([4327416](https://github.com/debuglebowski/slayzone/commit/4327416))
- **integrations:** Remove noisy discovery log ([b642d8b](https://github.com/debuglebowski/slayzone/commit/b642d8b))
- Add graph-visual-report.html to gitignore ([2236803](https://github.com/debuglebowski/slayzone/commit/2236803))

### ✅ Tests

- **worktrees:** Add diverged-branch layout tests and visual test runner ([962dbe4](https://github.com/debuglebowski/slayzone/commit/962dbe4))

### ❤️ Contributors

- Debuglebowski

## v0.4.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.3.1...v0.4.0)

### 🚀 Enhancements

- Enable React Compiler for auto-memoization ([28408af](https://github.com/debuglebowski/slayzone/commit/28408af))
- Unify sync UI for Linear/GitHub + surface unlinked tasks ([5a8793e](https://github.com/debuglebowski/slayzone/commit/5a8793e))
- **worktrees:** Persist commit graph display config per instance ([8651d88](https://github.com/debuglebowski/slayzone/commit/8651d88))
- **settings:** Add Git panel settings with commit graph defaults ([f1e8406](https://github.com/debuglebowski/slayzone/commit/f1e8406))

### 🔥 Performance

- Batch 5 IPC calls into single loadBoardData handler ([a26c52a](https://github.com/debuglebowski/slayzone/commit/a26c52a))
- **worktrees:** Virtualize commit graph — 56% DOM reduction ([920a2ce](https://github.com/debuglebowski/slayzone/commit/920a2ce))
- Code splitting — main bundle 8.5MB → 5.7MB (-33%) ([60394ae](https://github.com/debuglebowski/slayzone/commit/60394ae))
- **db:** Add SQLite pragma tuning for WAL mode ([ee594c3](https://github.com/debuglebowski/slayzone/commit/ee594c3))
- **terminal:** Disable cursor blink on hidden terminals ([93e2055](https://github.com/debuglebowski/slayzone/commit/93e2055))
- **terminal:** Batch PTY writes with requestAnimationFrame ([f183710](https://github.com/debuglebowski/slayzone/commit/f183710))
- **terminal:** Enable WebGL renderer + harden underline filtering ([f0fc088](https://github.com/debuglebowski/slayzone/commit/f0fc088))
- Auto-discover domain entries for Vite dep pre-bundling ([ba4036b](https://github.com/debuglebowski/slayzone/commit/ba4036b))
- **diagnostics:** Defer retention sweep on startup ([004427c](https://github.com/debuglebowski/slayzone/commit/004427c))

### 🩹 Fixes

- **nix:** Correct AppImage artifact name in update-nix-sources ([90cec76](https://github.com/debuglebowski/slayzone/commit/90cec76))
- **ui:** Prevent xterm scrollbar punch-through on hidden tabs ([d76f161](https://github.com/debuglebowski/slayzone/commit/d76f161))
- **worktrees:** Rewrite commit graph column layout + fix slash branch parsing ([e5d619a](https://github.com/debuglebowski/slayzone/commit/e5d619a))
- Use separate MCP ports for dev/prod to prevent notification collision ([1473fe3](https://github.com/debuglebowski/slayzone/commit/1473fe3))
- Always use mode-based port, don't read stale value from DB ([3db9215](https://github.com/debuglebowski/slayzone/commit/3db9215))
- **worktrees:** Always show first/last base commit in collapsed mode + card padding ([5ddef98](https://github.com/debuglebowski/slayzone/commit/5ddef98))
- Sync-now dispatches to both Linear and GitHub, extend push/pull to support Linear ([a8f643e](https://github.com/debuglebowski/slayzone/commit/a8f643e))
- Notify renderer after sync/discovery changes ([88f2119](https://github.com/debuglebowski/slayzone/commit/88f2119))
- **terminal:** Prevent full buffer replay on cached terminal reattach ([2bcf218](https://github.com/debuglebowski/slayzone/commit/2bcf218))
- Archive local task when remote issue is gone ([772f81f](https://github.com/debuglebowski/slayzone/commit/772f81f))
- Batch sync status fetch, clean project connections, guard notify ([8ed09cd](https://github.com/debuglebowski/slayzone/commit/8ed09cd))
- Archive local task when Linear issue is archived (not just completed) ([12ab94d](https://github.com/debuglebowski/slayzone/commit/12ab94d))
- **worktrees:** Rewrite collapsed graph, fix phantom edges and merge-into reparenting ([fb038d2](https://github.com/debuglebowski/slayzone/commit/fb038d2))
- **worktrees:** Polish graph indicators and display popover layout ([1979015](https://github.com/debuglebowski/slayzone/commit/1979015))
- **worktrees:** Match commit graph header spacing with home tab ([7f7bbd5](https://github.com/debuglebowski/slayzone/commit/7f7bbd5))
- **worktrees:** Add missing entries to graph legend popover ([d3a3d8c](https://github.com/debuglebowski/slayzone/commit/d3a3d8c))
- **worktrees:** Skip non-origin remotes in commit graph ([9640281](https://github.com/debuglebowski/slayzone/commit/9640281))
- **worktrees:** Refresh commit graph on push/pull ([001a00c](https://github.com/debuglebowski/slayzone/commit/001a00c))

### 💅 Refactors

- **worktrees:** Merge Branches tab into General, remove bottom shadow ([cb0bbef](https://github.com/debuglebowski/slayzone/commit/cb0bbef))
- **worktrees:** Simplify commit graph settings ([abe50fb](https://github.com/debuglebowski/slayzone/commit/abe50fb))
- **tasks:** Clean up kanban display popover layout ([60d9c07](https://github.com/debuglebowski/slayzone/commit/60d9c07))

### 🏡 Chore

- Update perf status, clean up stale working notes ([aadf213](https://github.com/debuglebowski/slayzone/commit/aadf213))
- Remove performance working notes, gitignore bundle-report ([8c91d71](https://github.com/debuglebowski/slayzone/commit/8c91d71))

### ✅ Tests

- Real-API integration tests for Linear and GitHub ([4428d30](https://github.com/debuglebowski/slayzone/commit/4428d30))
- Harden integration tests — push/pull, unlinked, pagination, errors ([9f159fc](https://github.com/debuglebowski/slayzone/commit/9f159fc))
- Fill remaining coverage gaps — guards, resync, status mapping, batch ([0081cb5](https://github.com/debuglebowski/slayzone/commit/0081cb5))
- Complete handler coverage — connect, list, connection mgmt, disconnect ([7e7c9b8](https://github.com/debuglebowski/slayzone/commit/7e7c9b8))

### ❤️ Contributors

- Debuglebowski

## v0.3.1

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.3.0...v0.3.1)

### 🚀 Enhancements

- **worktrees:** Redesign git general tab — merge sections, add PR actions ([e188380](https://github.com/debuglebowski/slayzone/commit/e188380))
- **worktrees:** Always show visual fork in branch tab, parent as main track ([e4370a7](https://github.com/debuglebowski/slayzone/commit/e4370a7))
- **ui:** Make active task tab more visually prominent ([73dec5e](https://github.com/debuglebowski/slayzone/commit/73dec5e))
- **worktrees:** Copy git-ignored files when creating worktrees ([4a1c252](https://github.com/debuglebowski/slayzone/commit/4a1c252))
- **worktrees:** Per-project copy behavior for git-ignored files ([77db895](https://github.com/debuglebowski/slayzone/commit/77db895))
- **release:** Discord notification on publish ([c90b451](https://github.com/debuglebowski/slayzone/commit/c90b451))
- Persist home panel visibility + git tab per project ([77d97e4](https://github.com/debuglebowski/slayzone/commit/77d97e4))
- **worktrees:** Configurable branch-focused commit graph ([f806641](https://github.com/debuglebowski/slayzone/commit/f806641))
- Add leaderboard item to getting started checklist ([796b478](https://github.com/debuglebowski/slayzone/commit/796b478))
- Make leaderboard tab generally available ([45b82bb](https://github.com/debuglebowski/slayzone/commit/45b82bb))
- Move context manager, integrations, tests panel to Labs settings ([3754986](https://github.com/debuglebowski/slayzone/commit/3754986))
- **settings:** Add leaderboard toggle in General settings ([18eae8b](https://github.com/debuglebowski/slayzone/commit/18eae8b))
- **processes:** Add stop action to process panel ([cf91b04](https://github.com/debuglebowski/slayzone/commit/cf91b04))
- **processes:** Wire stop action through preload and types ([f85b92a](https://github.com/debuglebowski/slayzone/commit/f85b92a))
- **website:** Add WCAG 2.1 AA accessibility support ([018d828](https://github.com/debuglebowski/slayzone/commit/018d828))
- Add inline feedback dialog with Discord forum integration ([ffa77e2](https://github.com/debuglebowski/slayzone/commit/ffa77e2))
- **feedback:** Add delete thread with Discord notification ([83faa11](https://github.com/debuglebowski/slayzone/commit/83faa11))
- **feedback:** Move delete to sidebar items, add privacy warning ([b8f4591](https://github.com/debuglebowski/slayzone/commit/b8f4591))
- **website:** Add sitemap.xml and robots.txt ([b4d47b8](https://github.com/debuglebowski/slayzone/commit/b4d47b8))
- **worktrees:** Add graph legend popover, synthetic branch tooltips ([4b04410](https://github.com/debuglebowski/slayzone/commit/4b04410))
- **worktrees:** Add full-file toggle to diff viewer ([fe9dd4d](https://github.com/debuglebowski/slayzone/commit/fe9dd4d))

### 🩹 Fixes

- **release:** Regenerate changelog with post-rebase commit hashes ([bc186af](https://github.com/debuglebowski/slayzone/commit/bc186af))
- **release:** Generate changelog after push to avoid stale hashes ([f972762](https://github.com/debuglebowski/slayzone/commit/f972762))
- **website:** Update head title to "Desktop Kanban for AI Coding Agents" ([7ee4f70](https://github.com/debuglebowski/slayzone/commit/7ee4f70))
- **e2e:** Prevent worktree tests from leaking branches into main repo ([b80a3b4](https://github.com/debuglebowski/slayzone/commit/b80a3b4))
- **website:** Download button URLs match actual release asset names ([cb66a8d](https://github.com/debuglebowski/slayzone/commit/cb66a8d))
- **ui:** Make sidebar project list scrollable when overflowing ([35a41a3](https://github.com/debuglebowski/slayzone/commit/35a41a3))
- **worktrees:** Lazy-resolve gh path in spawnGh to avoid "gh CLI not found" ([ffd0fc9](https://github.com/debuglebowski/slayzone/commit/ffd0fc9))
- **worktrees:** Use FolderTree icon for worktree button ([f056081](https://github.com/debuglebowski/slayzone/commit/f056081))
- **worktrees:** Move View diff button inline with Pull/Push ([7897516](https://github.com/debuglebowski/slayzone/commit/7897516))
- **worktrees:** Remove fake "Up to date" nodes from commit graph + increase row spacing ([00a0d16](https://github.com/debuglebowski/slayzone/commit/00a0d16))
- Hardcode Discord invite + X URLs, remove unused env vars ([e15ef21](https://github.com/debuglebowski/slayzone/commit/e15ef21))
- **release:** Duplicate releaseDate key in latest-mac.yml ([a4d326a](https://github.com/debuglebowski/slayzone/commit/a4d326a))
- **terminal:** Bottom content clipped by FitAddon padding mismatch ([89b1e2f](https://github.com/debuglebowski/slayzone/commit/89b1e2f))
- **browser:** Use auto width w/ max-w-[50vw] for import URL dropdown ([62eac72](https://github.com/debuglebowski/slayzone/commit/62eac72))
- **website:** Match FAQ content width to docs page ([25fa944](https://github.com/debuglebowski/slayzone/commit/25fa944))
- **terminal:** Remove persisted shell override, fix bare name startup flags ([43396b9](https://github.com/debuglebowski/slayzone/commit/43396b9))
- **cli:** Use node:http for app notification, fix resetApp MCP port wipe ([33c6e59](https://github.com/debuglebowski/slayzone/commit/33c6e59))
- **worktrees:** Synthetic branches as dead-end dots, show origin/ refs, dashed local edges ([bb8e9fd](https://github.com/debuglebowski/slayzone/commit/bb8e9fd))
- **worktrees:** Synthetic branches as inline indicators on main track ([436a653](https://github.com/debuglebowski/slayzone/commit/436a653))
- **worktrees:** Header refactor, hooks ordering, dedup keys, infinity borderRadius ([df1c03b](https://github.com/debuglebowski/slayzone/commit/df1c03b))
- **task-browser:** Fix webview surface clipping under CSS transform ([4bd79d8](https://github.com/debuglebowski/slayzone/commit/4bd79d8))
- **task-browser:** Add dark background to multi-device grid ([6bc9a73](https://github.com/debuglebowski/slayzone/commit/6bc9a73))

### 💅 Refactors

- **worktrees:** Move status section above actions in general tab ([88d2ec7](https://github.com/debuglebowski/slayzone/commit/88d2ec7))
- **worktrees:** Simplify general tab — replace worktree card with "View worktree" button ([66b59cd](https://github.com/debuglebowski/slayzone/commit/66b59cd))
- **worktrees:** Consolidate General + Branch tabs into unified General tab ([0e3abde](https://github.com/debuglebowski/slayzone/commit/0e3abde))
- **worktrees:** Clean up General tab shared components ([c310608](https://github.com/debuglebowski/slayzone/commit/c310608))
- **worktrees:** Unify commit graph rendering + add local vs remote divergence ([1a84bdc](https://github.com/debuglebowski/slayzone/commit/1a84bdc))
- **settings:** Extract tab state from App.tsx into zustand store ([0e8958a](https://github.com/debuglebowski/slayzone/commit/0e8958a))
- **worktrees:** Convert PR create/link from tab views to dialogs ([c486d20](https://github.com/debuglebowski/slayzone/commit/c486d20))
- **settings:** Extract worktree settings into dedicated tab ([13b101d](https://github.com/debuglebowski/slayzone/commit/13b101d))
- **worktrees:** Move git-ref resolution to main process, fix branch column layout ([8480fb4](https://github.com/debuglebowski/slayzone/commit/8480fb4))
- **worktrees:** Rewrite collapsed view to preserve DAG topology, remove branch tips ([0a84cbb](https://github.com/debuglebowski/slayzone/commit/0a84cbb))
- **worktrees:** Extract useBranchGraph hook, move toolbar to title row ([f8f8e64](https://github.com/debuglebowski/slayzone/commit/f8f8e64))
- **worktrees:** Remove CommitTimeline component and rebase progress tracking ([f5fbb6f](https://github.com/debuglebowski/slayzone/commit/f5fbb6f))
- **worktrees:** Remove graph fetching from useConsolidatedGeneralData ([2bd7c5c](https://github.com/debuglebowski/slayzone/commit/2bd7c5c))
- **worktrees:** Simplify CommitGraphConfig, add includeTags prop ([7fefc98](https://github.com/debuglebowski/slayzone/commit/7fefc98))

### 🏡 Chore

- **task-browser:** Remove unused executeJavaScript from WebviewElement ([95b64d9](https://github.com/debuglebowski/slayzone/commit/95b64d9))

### ✅ Tests

- Update test fixtures for db param + new project fields ([799350f](https://github.com/debuglebowski/slayzone/commit/799350f))

### ❤️ Contributors

- Debuglebowski

## v0.3.0

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.2.6...v0.3.0)

### 🚀 Enhancements

- **worktrees:** Double git panel commit count from 20 to 40 ([512265a](https://github.com/debuglebowski/slayzone/commit/512265a))
- **worktrees:** Add git push/pull controls + remote URL to git panel ([7089b71](https://github.com/debuglebowski/slayzone/commit/7089b71))
- **usage:** Configurable rate-limit bars with custom provider support ([7ca8095](https://github.com/debuglebowski/slayzone/commit/7ca8095))
- **worktrees:** Commit list fills remaining space with min-height + internal scroll ([60af187](https://github.com/debuglebowski/slayzone/commit/60af187))
- **settings:** Per-view panel toggle config (home vs task) ([ee1fe5e](https://github.com/debuglebowski/slayzone/commit/ee1fe5e))
- **worktrees:** PR tab with create/link, comments timeline, markdown rendering ([8e0e1d4](https://github.com/debuglebowski/slayzone/commit/8e0e1d4))
- **worktrees:** Show PR number in pull request tab label ([89fb3c8](https://github.com/debuglebowski/slayzone/commit/89fb3c8))
- **worktrees:** PR tab overhaul — merge, diff, mermaid, comments, filters ([6fa4dc6](https://github.com/debuglebowski/slayzone/commit/6fa4dc6))
- **worktrees:** Enrich PR activity with commits, avatars, review files + pagination ([2dc7d2d](https://github.com/debuglebowski/slayzone/commit/2dc7d2d))
- **tabs:** Group task tabs by worktree with colored borders ([f02b604](https://github.com/debuglebowski/slayzone/commit/f02b604))
- **worktrees:** Add branch/worktree tabs with graph, actions, PR status ([ea5575b](https://github.com/debuglebowski/slayzone/commit/ea5575b))

### 🩹 Fixes

- **worktrees:** Handle already-deleted worktree path in removeWorktree ([935968d](https://github.com/debuglebowski/slayzone/commit/935968d))
- **e2e:** Stabilize test suite — renumber, isolate, fix race conditions ([faf8c94](https://github.com/debuglebowski/slayzone/commit/faf8c94))
- **worktrees:** Use opaque bg on sticky Staged/Unstaged headers ([9ce3d9c](https://github.com/debuglebowski/slayzone/commit/9ce3d9c))
- **projects:** Use app API for integrations flag instead of import.meta.env ([697faf6](https://github.com/debuglebowski/slayzone/commit/697faf6))
- **e2e:** Retry dialog dismiss in project settings test ([944baf9](https://github.com/debuglebowski/slayzone/commit/944baf9))
- **e2e:** Re-create integration tables after resetApp ([b648612](https://github.com/debuglebowski/slayzone/commit/b648612))
- **e2e:** Update test 46 for renamed Git panel and Editor dual-switch ([75fe3a4](https://github.com/debuglebowski/slayzone/commit/75fe3a4))
- **e2e:** Use dispatchEvent instead of click in Radix dialogs ([7c53ca2](https://github.com/debuglebowski/slayzone/commit/7c53ca2))
- **ui:** Prevent Radix Dialog outside-click dismiss in Playwright ([ad86cfb](https://github.com/debuglebowski/slayzone/commit/ad86cfb))
- **e2e:** Tighten timeouts, skip flaky MCP test, fix 51+55 ([f3159ae](https://github.com/debuglebowski/slayzone/commit/f3159ae))
- **e2e:** Optimize test speed — reduce retry loops and unnecessary waits (~100s saved) ([1c6df7b](https://github.com/debuglebowski/slayzone/commit/1c6df7b))
- **terminal:** Eliminate main-thread freezes from sync git operations ([aa3a0e9](https://github.com/debuglebowski/slayzone/commit/aa3a0e9))
- **e2e:** Bump timeouts for slow CLI tests after global timeout reduction ([c5abf53](https://github.com/debuglebowski/slayzone/commit/c5abf53))
- **ui:** Layout shift + xterm scrollbar leak on tab switch ([3d786cd](https://github.com/debuglebowski/slayzone/commit/3d786cd))
- **worktrees:** Collapse/expand all includes PR description in activity ([a6a8e62](https://github.com/debuglebowski/slayzone/commit/a6a8e62))
- **e2e:** Call resetApp in every test suite's beforeAll ([a789994](https://github.com/debuglebowski/slayzone/commit/a789994))
- **e2e:** Resolve 22 failing tests across tab isolation, toast overlay, and CLI connectivity ([f77783d](https://github.com/debuglebowski/slayzone/commit/f77783d))
- **worktrees:** Async gh-cli to stop blocking main thread ([e0866ff](https://github.com/debuglebowski/slayzone/commit/e0866ff))

### 💅 Refactors

- **settings:** Shorten AI Providers label to Providers ([5c55a44](https://github.com/debuglebowski/slayzone/commit/5c55a44))

### ❤️ Contributors

- Debuglebowski
- Jimmy Stridh ([@jimmystridh](https://github.com/jimmystridh))

## v0.2.6

[compare changes](https://github.com/debuglebowski/slayzone/compare/v0.2.5...v0.2.6)

### 🚀 Enhancements

- **ci:** Add Intel Mac build and Homebrew tap automation ([8035c14](https://github.com/debuglebowski/slayzone/commit/8035c14))
- **nix:** Add flake with pre-built binary wrapping ([3d22d44](https://github.com/debuglebowski/slayzone/commit/3d22d44))
- **test-panel:** Add test file discovery domain package ([70686d2](https://github.com/debuglebowski/slayzone/commit/70686d2))
- Add SQLite database backup system ([573dc08](https://github.com/debuglebowski/slayzone/commit/573dc08))
- **terminal:** Add terminal theme picker with 16 curated themes ([977c091](https://github.com/debuglebowski/slayzone/commit/977c091))
- **test-panel:** Add multi-label support, label/path grouping, deterministic sort ([04fa80d](https://github.com/debuglebowski/slayzone/commit/04fa80d))
- **test-panel:** Add file notes, move settings to project settings dialog ([5c141ab](https://github.com/debuglebowski/slayzone/commit/5c141ab))
- **integrations:** Bidirectional sync w/ external link in sync settings ([8078e51](https://github.com/debuglebowski/slayzone/commit/8078e51))
- **integrations:** Add repo selector to GitHub sync, run discovery on startup ([b448b61](https://github.com/debuglebowski/slayzone/commit/b448b61))

### 🩹 Fixes

- Use scoped electron-rebuild in postinstall ([81eefa1](https://github.com/debuglebowski/slayzone/commit/81eefa1))
- **ci:** Harden release asset dedup and exe filtering ([63498d7](https://github.com/debuglebowski/slayzone/commit/63498d7))
- **ci:** Exclude OpenConsole.exe from release assets ([be9221e](https://github.com/debuglebowski/slayzone/commit/be9221e))
- **ci:** Only include installer exe files in release assets ([f971f0e](https://github.com/debuglebowski/slayzone/commit/f971f0e))
- **ci:** Merge multi-arch auto-update manifests in bundle ([363d1ea](https://github.com/debuglebowski/slayzone/commit/363d1ea))
- **terminal:** Sync query responses + filter OSC to fix interactive CLI prompts ([972131e](https://github.com/debuglebowski/slayzone/commit/972131e))
- **terminal:** Add Ctrl+Shift+C/V for copy/paste on Linux/Windows ([7d1ff27](https://github.com/debuglebowski/slayzone/commit/7d1ff27))
- **usage:** Add caching + 429 backoff to prevent rate limiting ([1eefed1](https://github.com/debuglebowski/slayzone/commit/1eefed1))

### 💅 Refactors

- **test-panel:** Merge label mgmt into settings dialog w/ tabs ([847ffc2](https://github.com/debuglebowski/slayzone/commit/847ffc2))
- **test-panel:** Stacked card layout, fix save profile, add tooltips ([783008c](https://github.com/debuglebowski/slayzone/commit/783008c))

### 📖 Documentation

- Update install instructions and download links ([51bb2e1](https://github.com/debuglebowski/slayzone/commit/51bb2e1))
- Add e2e test isolation working notes ([d7eab12](https://github.com/debuglebowski/slayzone/commit/d7eab12))

### 🏡 Chore

- **settings:** Rename theme labels from Experimental to Beta ([28ac5b8](https://github.com/debuglebowski/slayzone/commit/28ac5b8))

### ❤️ Contributors

- Debuglebowski
- Mjacniacki
- Jimmy Stridh

## v0.2.5

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.2.4...v0.2.5)

### 🚀 Enhancements

- **terminal:** Make CCS its own terminal mode instead of global wrapper ([8092f10](https://github.com/debuglebowski/SlayZone/commit/8092f10))
- **onboarding:** Add getting started checklist popover ([519e826](https://github.com/debuglebowski/SlayZone/commit/519e826))
- **worktrees:** Add worktrees management sub-panel to kanban git panel ([be13b3d](https://github.com/debuglebowski/SlayZone/commit/be13b3d))
- **integrations:** Add project-scoped setup and GitHub sync workflows ([59a0a4e](https://github.com/debuglebowski/SlayZone/commit/59a0a4e))
- **ui:** Brighter border on modals ([bbdcbd0](https://github.com/debuglebowski/SlayZone/commit/bbdcbd0))
- **ai-config:** Make context manager sync state explicit and manual ([af40784](https://github.com/debuglebowski/SlayZone/commit/af40784))
- **terminal:** Implement custom AI providers and modular settings UI ([e049fd4](https://github.com/debuglebowski/SlayZone/commit/e049fd4))
- **integrations:** Refine project sync UX and move working notes ([edb7fa9](https://github.com/debuglebowski/SlayZone/commit/edb7fa9))
- **terminal:** Focus terminal on tab switch ([5a3bde2](https://github.com/debuglebowski/SlayZone/commit/5a3bde2))
- **ai-config:** Add skill validation and global section deep-linking ([f107cbb](https://github.com/debuglebowski/SlayZone/commit/f107cbb))
- **terminal:** Imperative ref focus arch + visibility-hidden tabs + isActive gating ([b236943](https://github.com/debuglebowski/SlayZone/commit/b236943))
- **terminal:** Unified template commands, detection engine dropdown, remove codeMode ([651d765](https://github.com/debuglebowski/SlayZone/commit/651d765))
- **integrations:** Github/linear integration setup ([f68c584](https://github.com/debuglebowski/SlayZone/commit/f68c584))
- **task:** Task type changes + handler updates ([3d63f5d](https://github.com/debuglebowski/SlayZone/commit/3d63f5d))
- **integrations:** Add status-sync module ([0adbebb](https://github.com/debuglebowski/SlayZone/commit/0adbebb))
- **sidebar:** Add attention badges on project blobs ([ae45fc8](https://github.com/debuglebowski/SlayZone/commit/ae45fc8))

### 🩹 Fixes

- **task-terminals:** Focus terminal after creating a task ([653aa6f](https://github.com/debuglebowski/SlayZone/commit/653aa6f))
- **leaderboard:** Harden github oauth redirect flow ([2758ff3](https://github.com/debuglebowski/SlayZone/commit/2758ff3))
- **ai-config:** Enforce frontmatter validation status semantics ([996d4ee](https://github.com/debuglebowski/SlayZone/commit/996d4ee))
- **ai-config:** Require explicit frontmatter for skill sync ([c1d8202](https://github.com/debuglebowski/SlayZone/commit/c1d8202))
- **e2e:** Stabilize flaky settings and terminal mode flows ([1bc04f6](https://github.com/debuglebowski/SlayZone/commit/1bc04f6))
- **ai-config:** Correct skill frontmatter validation and repair stale metadata ([642d2e5](https://github.com/debuglebowski/SlayZone/commit/642d2e5))
- **file-editor:** Handle missing subdirectories in readDir ([ad043c6](https://github.com/debuglebowski/SlayZone/commit/ad043c6))
- **tutorial:** Update settings sidebar tabs to match current UI ([1488bc8](https://github.com/debuglebowski/SlayZone/commit/1488bc8))
- **task-terminals:** Handle unknown terminal modes gracefully ([1882d2a](https://github.com/debuglebowski/SlayZone/commit/1882d2a))
- **ci:** Gate publish releases on convex deploy ([38c4554](https://github.com/debuglebowski/SlayZone/commit/38c4554))
- **terminal:** Add missing enabled placeholder in terminalModes:create INSERT ([e84340c](https://github.com/debuglebowski/SlayZone/commit/e84340c))
- **worktrees:** Conflict view + worktrees tab fixes ([e15737a](https://github.com/debuglebowski/SlayZone/commit/e15737a))
- **task:** Revert terminal_mode to non-nullable, remove unused vars ([8f03673](https://github.com/debuglebowski/SlayZone/commit/8f03673))
- **tabs:** Use transparent border on inactive tabs to prevent layout shift ([10de737](https://github.com/debuglebowski/SlayZone/commit/10de737))
- **task:** Stop terminal reinit when conversation ID is saved back ([34320bb](https://github.com/debuglebowski/SlayZone/commit/34320bb))
- **release:** Harden prod transition before release ([dada5da](https://github.com/debuglebowski/SlayZone/commit/dada5da))
- **app:** Remove dev guard from integration onboarding flow ([bf19278](https://github.com/debuglebowski/SlayZone/commit/bf19278))

### 💅 Refactors

- **onboarding:** Centralize checklist state ([87194e4](https://github.com/debuglebowski/SlayZone/commit/87194e4))
- **ai-config:** Unify context sync view model and e2e helpers ([fd05813](https://github.com/debuglebowski/SlayZone/commit/fd05813))
- **terminal:** Remove terminal from BuiltinTerminalMode, clean up utils ([330c03f](https://github.com/debuglebowski/SlayZone/commit/330c03f))

### 📖 Documentation

- Distribution rollout notes ([845228a](https://github.com/debuglebowski/SlayZone/commit/845228a))

### 🏡 Chore

- **terminal:** Rename CCS display to "CCS - Claude Code", reorder in selector ([c391e62](https://github.com/debuglebowski/SlayZone/commit/c391e62))
- **agent-config:** Sync assistant skill metadata ([cc1830c](https://github.com/debuglebowski/SlayZone/commit/cc1830c))
- **app:** Migrations, mcp-server, preload updates ([ec11103](https://github.com/debuglebowski/SlayZone/commit/ec11103))
- **diagnostics:** Remove unused code ([92aa242](https://github.com/debuglebowski/SlayZone/commit/92aa242))

### ✅ Tests

- **e2e:** Stabilize execution context settings flow ([f72a44c](https://github.com/debuglebowski/SlayZone/commit/f72a44c))
- **e2e:** Await async PTY buffer in readFullBuffer ([8f27350](https://github.com/debuglebowski/SlayZone/commit/8f27350))
- **integrations:** Update connection and provider-clearing coverage ([22a6061](https://github.com/debuglebowski/SlayZone/commit/22a6061))
- **e2e:** Stabilize core navigation and keyboard panel flows ([fcab339](https://github.com/debuglebowski/SlayZone/commit/fcab339))
- **e2e:** Stabilize git browser editor and worktree flows ([fa531b7](https://github.com/debuglebowski/SlayZone/commit/fa531b7))
- **e2e:** Stabilize terminal session and cli coverage ([b77b4fe](https://github.com/debuglebowski/SlayZone/commit/b77b4fe))
- **task:** Add testid to region selector overlay ([618306f](https://github.com/debuglebowski/SlayZone/commit/618306f))
- Update e2e specs + attention tasks test ([140b33e](https://github.com/debuglebowski/SlayZone/commit/140b33e))
- **app:** Stabilize e2e flakes in settings and terminal flows ([cc1faf5](https://github.com/debuglebowski/SlayZone/commit/cc1faf5))
- **app:** Document skip and fixme rationale in e2e specs ([85ec458](https://github.com/debuglebowski/SlayZone/commit/85ec458))
- **app:** Re-enable and stabilize projects and branch-switch e2e ([547786d](https://github.com/debuglebowski/SlayZone/commit/547786d))

### ❤️ Contributors

- Debuglebowski

## v0.2.4

[compare changes](https://github.com/debuglebowski/SlayZone/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- **ccs:** Use -c flag for shell spawn, style settings section ([d4a0ea5](https://github.com/debuglebowski/SlayZone/commit/d4a0ea5))
- **settings:** Drill-down navigation for panel config ([0ba8aad](https://github.com/debuglebowski/SlayZone/commit/0ba8aad))
- **telemetry:** Track onboarding funnel, page views, panel usage ([7532fd0](https://github.com/debuglebowski/SlayZone/commit/7532fd0))
- **settings:** Panel config for editor, diff, terminal, browser ([2564119](https://github.com/debuglebowski/SlayZone/commit/2564119))

### 🩹 Fixes

- Text selection invisible in dark mode ([ef60f85](https://github.com/debuglebowski/SlayZone/commit/ef60f85))

### ❤️ Contributors

- Debuglebowski

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
