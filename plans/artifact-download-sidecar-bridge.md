# Artifact downloads: bridge to the Electron host

## Problem

All 6 artifact download procedures are dead. They have been since the slice-9 cutover
moved the renderer's tRPC backend into the plain-node sidecar.

`packages/shared/transport/src/server/routers/artifacts.ts:58` resolves the Electron-only
download module through a catch-guarded dynamic import:

```ts
async function loadDownloads() {
  try { return await import('@slayzone/task/electron/artifact-downloads') }
  catch { return null }
}
```

The module is bundled *into* the sidecar, so the intended "absent → PRECONDITION_FAILED"
path never describes reality. What actually happens:

1. esbuild wraps the module in a lazy `__esm` init (`hub/dist/bin.cjs:130925`) whose first
   statement is `import_electron2 = __toESM(require_electron(), 1)`.
2. `require_electron()` is npm `electron/index.js` — the **path-resolver stub**, inlined by
   the bundler. It reads `path.txt` relative to `__dirname`; there is no `path.txt` in
   `packages/apps/hub/dist/`, so it throws `Electron failed to install correctly`.
3. esbuild's `__esm` helper zeroes its `fn` *before* invoking the body:
   ```js
   var __esm = (fn2, res) => function __init() {
     return fn2 && (res = (0, fn2[__getOwnPropNames(fn2)[0]])(fn2 = 0)), res
   }
   ```
   A throwing body therefore poisons the init permanently — later calls return `undefined`
   without re-running, leaving `import_fs11` / `import_path12` / `import_electron2` forever
   undefined.

Net effect per sidecar boot:

| Attempt | Result | User sees |
|---|---|---|
| 1st | init throws → caught → `PRECONDITION_FAILED "Artifact download is Electron-only"` | nothing |
| 2nd+ | init no-ops → module returned with undefined bindings → `TypeError: Cannot read properties of undefined (reading 'existsSync')` | nothing |

Verified live against the running sidecar (`ws://127.0.0.1:53749/trpc`):

```
artifacts.downloadFile → TypeError: Cannot read properties of undefined (reading 'existsSync')
  at downloadArtifactFile (packages/apps/hub/dist/bin.cjs:130754)
```

Both failures are silent because `useArtifacts.ts:299-337` calls `mutateAsync` with no
`.catch` and no toast.

Fixing only the bundling would not help: the sidecar runs under `ELECTRON_RUN_AS_NODE`,
where `require('electron')` returns the binary path as a **string** (confirmed —
`e.dialog === undefined`).

Affected: `downloadFile`, `downloadFolder`, `downloadAllAsZip`, `downloadAsPdf`,
`downloadAsPng`, `downloadAsHtml`. Present in shipped builds, not just dev.

## Approach

Route the Electron-only steps through `AppDeps`, the existing capability bridge — the same
fix applied to theme / `revealInFinder` / `showInFinder` during slice 9
(`reference_electron_coupled_procs_break_on_sidecar`).

`AppDeps` is a TypeScript interface with three wiring sites:

| Site | File | Enforcement |
|---|---|---|
| Host impl | `apps/app/src/main/index.ts:2097` | object literal → compile error if a member is missing |
| Sidecar (supervised) | `bridge.appDeps`, a JS Proxy | forwards every method automatically, no per-method work |
| Standalone (no host) | `apps/hub/src/composition.ts:649` | object literal of fail-loud `stub()`s → compile error if missing |

Adding a capability therefore **breaks the build** until the host and the standalone stub
both wire it. That is the property the dynamic import structurally cannot have, and the
reason this class of bug shipped twice.

### Split of responsibility

Sidecar keeps everything it can already do — it has `fs`, the artifact store, `archiver`,
and the pure HTML builders. Only genuinely-Electron work crosses the bridge:

| Step | Runs in | Why |
|---|---|---|
| DB reads, `getArtifactFilePath`, `existsSync` | sidecar | plain node |
| `copyFileSync`, folder tree walk, zip via `archiver` | sidecar | plain node |
| `buildPdfHtml` / `buildMermaidPdfHtml` / `buildPngHtml` | sidecar | pure string work |
| Save dialog | host | `dialog.showSaveDialog` |
| Directory picker | host | `dialogShowOpenDialog` — **already in `AppDeps`** |
| Reveal in Finder | host | `shellShowItemInFolder` — **already in `AppDeps`** |
| PDF/PNG render | host | offscreen `BrowserWindow` (`artifact-export.ts:146,178`) |
| Downloads dir default path | host | `app.getPath('downloads')` |

## Changes

### 1. New `AppDeps` capabilities

`packages/shared/transport/src/server/app-deps.ts`:

```ts
// dialog
dialogShowSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>

// app metadata
appGetDownloadsDir: () => string

// artifact export — offscreen BrowserWindow rendering. Writes straight to destPath
// so multi-MB buffers never cross the superjson/WS bridge.
artifactRenderPdfToFile: (html: string, isMermaid: boolean, destPath: string) => Promise<void>
artifactRenderPngToFile: (html: string, destPath: string) => Promise<void>
```

Host impl parents the save dialog to `BrowserWindow.getFocusedWindow()` when one exists,
preserving today's behavior and keeping window concepts out of the sidecar.
Standalone composition adds four `stub(...)` entries (throwing, per `composition.ts:168`).

### 2. Make the download module electron-free

Move `packages/domains/task/src/electron/artifact-downloads.ts` →
`packages/domains/task/src/server/artifact-downloads.ts`, taking the four capabilities as
injected parameters instead of importing `electron`. Delete the `electron/artifact-downloads`
subpath export from `domains/task/package.json:14`.

The move is deliberate, not cosmetic: `src/electron/` is the one directory the boundary
guard exempts, so a file left there is unprotected against someone re-adding an electron
import later. Under `src/server/` the guard (`check-server-electron-free.sh:28-37`) covers
it automatically. Delete stale `.tsbuildinfo` after the move or tsgo throws phantom errors.

`artifact-export.ts` splits: the pure builders (`escapeHtml`, `buildPdfHtml`,
`buildMermaidPdfHtml`, `buildPngHtml`) move to `server/`; `renderToPdf` / `renderToPng`
stay in `electron/` and become the host's `artifactRender*ToFile` impls.

### 3. Delete `loadDownloads()`

`routers/artifacts.ts`: drop `loadDownloads`, the `electronOnly()` helper, and the
`typeof import(...)` type reference. The 6 procedures call the electron-free module
directly, passing `getAppDeps()`. No `try`/`catch`, no `null` branch — in a hostless hub
the fail-loud stub throws with the capability name, which is the honest error.

### 4. Close the class in the boundary guard

`scripts/check-server-electron-free.sh` guard (2b) currently strips dynamic imports before
searching (line 60), and its own comment describes this exact crash:

> …crashes on the `electron` npm shim at module load (this exact bug shipped via
> `integrations/sync.ts`). `import type` (erased) and dynamic `import('…')` (lazy + caught)
> are allowed…

"Lazy + caught" is false safety twice over: the catch converts a hard failure into a silent
`null`, and `__esm` poisoning means it only covers the first call. Stop stripping dynamic
imports; keep the `import type` carve-out.

Blast radius is zero — `artifacts.ts` is the **only** dynamic `/electron` import remaining
across `apps/hub/src`, `shared/transport/src`, `shared/platform/src`, and every
`domains/*/src/server`. After change 3 the guard has nothing left to flag.

### 5. Surface failures in the UI

`packages/domains/task-artifacts/src/client/useArtifacts.ts`: wrap the 6 download callbacks
so a rejection raises an error toast and resolves `false`. A `false` return keeps meaning
"user cancelled"; a thrown capability error becomes visible instead of vanishing.

## Verification

1. `pnpm lint:server-boundary` — passes with the tightened guard.
2. `pnpm typecheck` — proves all three `AppDeps` sites are wired.
3. `pnpm build` + relaunch the dev app; exercise each of the 6 downloads by hand.
4. Re-run the WS probe against the live sidecar — `artifacts.downloadFile` must open a save
   dialog rather than throw.
5. New e2e `packages/apps/app/e2e/core/105-artifact-downloads.spec.ts`. **This is the piece
   that keeps the fix fixed** — `93-artifacts-panel` and `94-artifact-html-preview` exist
   today but nothing exercises a download, which is why this shipped. TDD: write it first
   against current `main` and watch it fail.

   Stub `dialog.showSaveDialog` in the main process via `electronApp.evaluate()` (available
   in the fixture, used by ~10 specs) rather than adding test-only bypass ops in the
   `53-export-import` style. The defect was the *bridge wiring*, and a bypass op routes
   around exactly that — for file/folder/zip it would run a sidecar-native path, never touch
   `dialogShowSaveDialog`/`appGetDownloadsDir`, and pass just as happily against today's
   broken build. The monkeypatch drives the whole chain: renderer → sidecar tRPC →
   capability bridge → host dialog → sidecar writes the file.

   Own file rather than extending `93-artifacts-panel.spec.ts` (already 25.7K, panel UI):
   downloads need their own fixture setup, and the suite runs one process per `e2e/`
   subdirectory, so a separate file keeps failures attributable. Write the destination under
   `$HOME`, not `/tmp` — tmpdir fixtures have tripped the `slz-file://` home guard before.

## Out of scope

A genuinely remote hub has no Electron host, so downloads there hit the fail-loud stub.
Making them work means streaming bytes to the renderer instead of driving a host-side
dialog — a separate feature. The stub makes the gap explicit rather than silent, which is
the correct interim state.

## Decisions

1. **Move** `artifact-downloads.ts` to `src/server/` — puts it under boundary-guard coverage.
2. **Toast** on download failure (not silent-but-logged).
3. **New spec file** `core/105-artifact-downloads.spec.ts`, dialog stubbed via
   `electronApp.evaluate()` — not test-only bypass ops.

## Found during implementation

**`artifact-export.ts` did not need splitting.** `buildMermaidPdfHtml` resolves mermaid
through `require.resolve('mermaid/dist/mermaid.min.js')` and silently falls back to
plain-code rendering on a miss — from the side-car bundle it would miss every time and
quietly downgrade mermaid exports. So HTML building became a host capability too
(`artifactBuildExportHtml`), the export module stays entirely under `src/electron/`, and
five capabilities were added rather than four. Only `artifact-downloads.ts` moved.

**Sync signatures on bridged capabilities are a live trap.** `host-bridge.ts:159` forwards
every unlisted member through `invoke()`, which always returns a Promise, and line 163
casts the proxy `as unknown as AppDeps`. A capability declared `() => string` therefore
type-checks at all three sites and hands callers a Promise at runtime — this surfaced as
`The "path" argument must be of type string. Received an instance of Promise` on 5 of the
6 procedures. `appGetDownloadsDir` and `artifactBuildExportHtml` are declared
`Promise<…>` for that reason. Note the limit on the compile-enforcement claim above: the
host and standalone-stub sites are genuinely enforced, the bridge site is a cast.

The existing interface still carries sync-declared members (`appGetVersion`,
`appGetZoomFactor`, …) that have the same latent mismatch when bridged. Not touched here.

## Result

- `pnpm typecheck` green; `pnpm lint:server-boundary` green under the tightened guard.
- `core/105-artifact-downloads.spec.ts` 6/6 green (was 6/6 red before the fix, all
  reporting `Artifact download is Electron-only`).
- `93-artifacts-panel` + `94-artifact-html-preview` 32/32 green — no regression.
- Rebuilt side-car bundle no longer contains the electron shim or the lazy-init wrapper
  for the download module.
- Pre-existing, unrelated: `pnpm lint` fails at `lint:trpc-deps` on
  `domains/tasks/src/client/useTasksData.ts` (`runGroupMutation` is a `useCallback`, not a
  mutation object — the known textual false-positive), which short-circuits biome/eslint.
  Both were run scoped to the changed files: 0 errors.
