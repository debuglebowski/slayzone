# Settings by scope

Design: task artifact `settings-design.html` (v20). Settings becomes a full-window view
whose nav mirrors where each setting lives.

```
← Back to app (Esc)        [search]
PREFERENCES   Appearance, Layout, Terminal, Editor, Chat, Notes, Git & diff,
              Browser, Keyboard, Notifications, Panels, Board & views,
              Privacy & telemetry, Profile (signed in only)
APP           Updates & diagnostics, slay CLI, Labs, About
HUBS      ＋  <hub>            → tabs: Overview, Agents & providers, Worktrees, MCP,
                                 Automations, Tests, Org policy*, Members*,
                                 Integrations, Backups, Import & export, Projects
                <computer>     → tabs: General, Folders, Agents, Environment,
                                 Chat backups, Projects
                <project>      → tabs: General, Computers, Agents, Worktrees, Tasks,
                                 Repositories, Tests, AI instructions, Automations,
                                 Lock & limits, Environment, Integrations, Members*
              All projects     → cross-hub table, bulk edit
```

Rule: a hub, computer or project page renders inside `<HubScope hubId>` of the hub
that owns it, so every read and write goes to that hub.

## Phases

Each phase ships on its own and preserves every existing setting.

1. **Full-window view (UI only).** One `openSettings(route)` API for both shells
   (desktop local state, fork dialog store, menu, `open-settings` /
   `open-project-settings` events, chat slash builtins). Legacy tab keys map to
   routes. Existing tab components move into the new pages unchanged;
   `UserSettingsDialog` and `ProjectSettingsDialog` are replaced by routes.
   No storage changes. E2E moves to shared `openSettings(page, route)` fixtures.
2. **Settings registry.** `defineSettings({ key, scope, overridableBy, type,
   default, legacyKeys })` next to each feature; `resolve(def, { projectId })`
   on the hub and `useSetting(def, { projectId })` in React returning
   `{ value, source, locked, canEdit }`. Replaces the key list in
   `settings-core/scope.ts`. `slay settings get/set` reads the same registry.
3. **Project overrides.** `project_settings(project_id, key, value)`; migrate the
   nullable `projects.*` worktree columns and `ai_providers:*` /
   `ai_instruction_variant:*` keys into it. Default agent, startup, idle close
   and chat defaults become overridable. Inheritance UI ("From hub · Override",
   "Where does this come from?").
4. **Device storage.** Device-scoped keys (fonts, theme, layout, terminal
   rendering) move from the default hub to a local file, copied once on first
   boot; hub rows kept one release for older apps. "Synced / This device only"
   tags when signed in to a hub.
5. **All projects + search.** Cross-hub table with bulk set/reset/copy (each
   write to the owning hub); search across every scope.
6. **Org policy.** `setting_policies` on hubs with sign-in: lock or limit a
   value, enforced on the hub; shown read-only to members.

## Phase 1 status

Done (first slice):
- `SettingsRoute` + legacy tab mapping, one store (`openSettings`/`closeSettings`), the
  `open-settings` bridge installed by both shells; menu/shortcut open the view.
- `SettingsView` (full window, Back/Esc) in both shells; nav: Preferences, App, Hubs
  (each hub → its computers + projects). `UserSettingsDialog` and the hub picker are gone.
- Hub page tabs: Agents & providers (incl. default agent, startup, idle close),
  Worktrees, and on the default hub MCP, Backups, Import & export.
- Project page renders `ProjectSettingsPanel` in the project's hub scope.

- Computer page: name, machine, platform, faults, the same actions as its Hubs-page
  row (shared `useHubComputers` / `ComputerActionButtons`), chat backups.
- Every project-settings entry point opens the view; `ProjectSettingsDialog` is gone
  (`ProjectSettingsPanel`, tests ported). Saving keeps the page open with a toast.

- Hub Overview tab (the Hubs page's own card for that hub) and the fork's settings
  shortcuts. Phase 1 done.

## Phases 3–6 status

- **3, project overrides:** `project_settings` (v225); `readEffectiveSetting` in
  settings-core is the one resolver, used by task create (UI, import, REST subtasks, MCP
  create-subtask), ai-config / skills provider lists, boot restore (`tab-flags`), the
  warm pool, and chat defaults (hub-local spawn and the computer bootstrap).
  Overridable: default agent, agent startup, chat mode/model/effort per provider.
  `settings.effective / projectOverrides / overridesOfKey / setProjectOverride /
  clearProjectOverride`; project page Agents tab; "N projects use their own value" on
  hub rows. Overrides travel with a project moved between hubs. Not in the project
  export file (that format already omits automations, templates …).
- **4, device storage:** `deviceSettingsLink` (transport) on each shell's own hub
  connection keeps `isDeviceSetting` keys (settings-core `device-keys`) in local
  storage; first read copies the hub's value, writes still go to the hub too (older
  apps, change events). Note on Appearance with 2+ hubs.
- **5, all projects + search:** All projects page (per hub, own vs hub values, filter,
  bulk set default agent / reset); search box over every page, hub tab, computer and
  project.
- **6, policy:** hub admins lock an overridable setting for projects
  (`policy_lock:<key>`, a `hub` key so admin-only); locked = project values ignored and
  refused, shown as "Locked by hub". Implemented at hub level (hub admins), not as a
  separate org layer.
