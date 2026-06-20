# Plan: Fork first-run & info dialogs

Wire remaining first-run / informational dialogs into the chromium fork
(`packages/apps/renderer-app` + `@slayzone/chromium-shell`):
OnboardingDialog (+ real checklist + KeyRecorder), Changelog, Tutorial, CLI-install.

Principle: **extract → migrate, never reimplement**. Every app-renderer-only piece
MOVES into a package; the Electron app updates its imports + deletes its copy, so
both shells share ONE source. Sidebar precedent.

---

## Extraction homes (cohesive)

| Piece | From | To |
|---|---|---|
| `KeyRecorder.tsx` | `app/.../components/KeyRecorder.tsx` | `@slayzone/ui` (ui already deps `@slayzone/shortcuts` + hosts `useShortcutStore`) |
| `useOnboardingChecklist.ts` | `app/.../hooks/` | `@slayzone/onboarding` |
| `ChangelogDialog` + `useChangelogAutoOpen` + `changelog-data.ts/.json` | `app/.../components/changelog/` | `@slayzone/onboarding/.../changelog/` |
| `TutorialAnimationModal` + `scenes/` | `app/.../components/tutorial/` | `@slayzone/onboarding/.../tutorial/` (keep dir names → lint-theme exclude still matches) |
| `CliInstallDialog` | `app/.../components/dialogs/` | `@slayzone/settings` |
| `COMMUNITY_DISCORD_URL` / `COMMUNITY_X_URL` | `app/.../app-shell/constants.ts` | `@slayzone/onboarding` (single source; app re-exports) |

No new namedTxns → `txn-registry.d.ts` untouched. ui+settings already `@source`'d in
both main.css; only **onboarding** needs adding to `chromium-shell/src/main.css`.

---

## Phase 1 — KeyRecorder → @slayzone/ui
1. Move `KeyRecorder.tsx` → `packages/shared/ui/src/KeyRecorder.tsx`. Export from ui barrel.
   (sole import `normalizeHotkeyString` from `@slayzone/shortcuts` — ui already deps it.)
2. App: import `KeyRecorder` from `@slayzone/ui` (App.tsx); delete app copy.
3. Fork `HomeView.tsx`: `keyRecorder={KeyRecorder}` (drop `NOOP_KEY_RECORDER`). Add `@slayzone/ui` KeyRecorder import.
4. No @source change (ui in both).

## Phase 2 — useOnboardingChecklist + community URLs → @slayzone/onboarding
1. Move hook → `onboarding/src/client/useOnboardingChecklist.ts`. Export hook + its
   `OnboardingChecklistState`/`Step` types from onboarding barrel.
2. Add `COMMUNITY_DISCORD_URL`/`COMMUNITY_X_URL` consts to onboarding; export. App
   `app-shell/constants.ts` re-exports from onboarding (single source).
3. App: `App.tsx` imports hook from `@slayzone/onboarding`; delete app copy.
4. Fork `HomeView.tsx`: replace `FORK_CHECKLIST` with
   `useOnboardingChecklist({ projectCount: projects.length, hasCreatedTask: data.tasks.some(t=>!t.is_temporary), onCheckLeaderboard: ()=>useTabStore.getState().setActiveView('leaderboard'), onJoinCommunity: ()=>trpcClient.app.shell.openExternal.mutate({url:COMMUNITY_DISCORD_URL}), onFollowOnX: ()=>...X })`.
   Feed `checklist` → `AppSidebar onboardingChecklist`. Hold `startTour`/`markSetupGuideCompleted` for Phase 3.
5. Add `@slayzone/onboarding` dep to `renderer-app/package.json`.

## Phase 3 — Wire OnboardingDialog in fork
1. Fork `AppDialogs.tsx`: accept 2 props `{ startTour, markSetupGuideCompleted }`
   (matches canonical; everything else stays store-driven). `HomeView` passes them.
2. Register onboarding block: local `shouldMountOnboarding` (useState+useEffect reading
   `onboarding_completed !== 'true'` via trpcClient, OR `onboardingOpen` store flag).
   `<OnboardingDialog externalOpen={onboardingOpen} onExternalClose={…}>` — close flow
   = `closeOnboarding()` + if completed `markSetupGuideCompleted()` + if `!tutorial_prompted`
   set it + toast "Want a tour?" → `startTour`. (verbatim canonical AppDialogs onboarding block.)
3. Add `@source ".../domains/onboarding/src"` to `chromium-shell/src/main.css`.

## Phase 4 — Changelog → @slayzone/onboarding
1. Move `ChangelogDialog.tsx` + `useChangelogAutoOpen.ts` + `changelog-data.ts` + `.json`
   → `onboarding/src/client/changelog/`. Export `ChangelogDialog`, `useChangelogAutoOpen` from barrel.
2. Add `@radix-ui/react-collapsible` dep to onboarding `package.json` (changelog accordion).
3. App: update `app-shell/lazy.ts` + any direct importers → `@slayzone/onboarding`; delete app copies.
4. Fork `AppDialogs.tsx`: register `ChangelogDialog` — call `useChangelogAutoOpen()` locally +
   read `changelogOpen` from store; mount on `changelogOpen||autoChangelogOpen`.

## Phase 5 — Tutorial → @slayzone/onboarding
1. Move whole `tutorial/` dir (`TutorialAnimationModal.tsx` + `scenes/*`) →
   `onboarding/src/client/tutorial/` (KEEP `tutorial/` + `scenes/` names → lint-theme exclude `/tutorial/(scenes/|TutorialAnimationModal\.tsx)` still matches). Export `TutorialAnimationModal` from barrel.
2. App: update `lazy.ts` + importers; delete app copies.
3. Fork `AppDialogs.tsx`: register `TutorialAnimationModal` (store `showAnimatedTour`).

## Phase 6 — CliInstall → @slayzone/settings
1. Move `CliInstallDialog.tsx` → `settings/src/client/CliInstallDialog.tsx`. Export from settings barrel.
2. App: update `lazy.ts`; delete app copy.
3. Fork `AppDialogs.tsx`: always-mount `<Suspense><CliInstallDialog/></Suspense>` (self-managed open; settings already @source'd both).

## Phase 7 — Verify
- `pnpm typecheck` (both shells).
- `pnpm dev:chromium` REAL window: fresh-state onboarding auto-shows; key recorder captures a
  shortcut; changelog / tutorial / CLI-install dialogs open + render. (reuse SLAYZONE_NO_SIDECAR=1 live-verify pattern; fresh DB for fresh onboarding state.)
- Electron app: run, confirm all 5 still work after extractions (parity, unbroken).
- `pnpm lint` (theme exclude matches new tutorial path).

---

## Unresolved questions
1. KeyRecorder home = `@slayzone/ui` (vs onboarding)? ui = best fit (deps shortcuts, hosts shortcut store).
2. Changelog+Tutorial→onboarding, CliInstall→settings, community URLs→onboarding — homes OK?
3. Fork `AppDialogs` gains 2 props (startTour, markSetupGuideCompleted) — break strict store-driven purity OK? (alt: render OnboardingDialog in HomeView.)
4. Migrate-and-delete app copies (move, not copy) for all 6 pieces — confirm (single source, mandated by "never reimplement").
