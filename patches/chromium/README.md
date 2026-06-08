# patches/chromium/

`git am`-formatted patches applied to `chromium/src/` in lexicographic order
by `scripts/chromium/apply-patches.sh`.

| # | Name | Phase | Purpose |
|---|------|-------|---------|
| 0001 | `slayzone-rebrand-Chromium-SlayZone` | 2.1 | Placeholder text-only rebrand: `chrome/app/theme/chromium/BRANDING` + `chromium_strings.grd` → "SlayZone". Icon art stays upstream until Phase 19. |
| 0002 | `slayzone-chrome-scheme-handler-factory` | 2.2 | `chrome/browser/ui/webui/slayzone/slayzone_webui_registry.{h,cc}` — single `RegisterSlayzoneWebUIConfigs()` entrypoint called from `RegisterChromeWebUIConfigs()`. Registers `chrome://slayzone-shell/` as the first tenant (empty placeholder body). Every Phase 5+ region lands a `WebUIConfig` here. |
| 0003 | `slayzone-sidecar-client` | 2.3 | `chrome/browser/slayzone/sidecar_client.{h,cc}` — browser-process client for the Bun sidecar. LSP-framed JSON-RPC 2.0 over UDS at `$SLAYZONE_RUNTIME_DIR/sidecar.sock` (platform default `~/Library/Application Support/SlayZone/run/` on mac, `$XDG_RUNTIME_DIR/slayzone/` on linux). Keepalive 30 s, reconnect w/ exp backoff 500 ms → 30 s cap, id-correlated pending map. Started from `BrowserProcessImpl::Init()`, stopped in `StartTearDown()`. |
| 0004 | `slayzone-telemetry-strip` | 2.4 | Surgical hard-offs: `ChromeMetricsServiceAccessor::IsMetricsAndCrashReportingEnabled` → `false`; `MetricsService::EnableRecording` early-return; `VariationsService::IsFetchingEnabled()` → `false` (kills `variations.googlezip.net` phone-home). Pairs with `safe_browsing_mode=0`, `disable_fieldtrial_testing_config=true`, `use_official_google_api_keys=false` in `scripts/chromium/args/release.gn`. |
| 0005 | `slayzone-NTP-chrome-slayzone-shell-rewrite` | 2.5 | `chrome/browser/chrome_content_browser_client.cc` — `HandleSlayzoneNewTabRewrite` registered first in `BrowserURLHandlerCreated`; every new-tab path (address bar, new-tab button, window.open, session restore, extensions) redirects `chrome://newtab/` → `chrome://slayzone-shell/`. |
| 0006 | `slayzone-pin-kCGImageByteOrder32Little` | 1.3 / SDK | Replaces `kCGImageByteOrder32Host` with its little-endian form at 9 call sites. Apple removed the Host alias from Xcode 16.x CGImage.h; it exists only in Xcode 26+ SDKs. Safe because Chromium already asserts `SK_CPU_LENDIAN` around the mac site. Drop once toolchain baseline is Xcode 26+ (requires macOS 15+ host). |
| 0007 | `slayzone-avoid-macOS-26-NSScreen-CGDirectDisplayID` | 1.3 / SDK | `ui/display/mac/screen_utils_mac.mm` references `screen.CGDirectDisplayID` inside an `@available(macOS 26, *)` block — runtime gate is fine, but Xcode 16.x SDKs don't declare the property so it won't compile. Use the `deviceDescription[@"NSScreenNumber"]` fallback unconditionally (works on every macOS version). Drop once toolchain baseline is Xcode 26+. |
| 0014 | `slayzone-Phase-6.1-tabs.mojom-SlayzoneTabsHost` | 6.1 | `chrome/browser/slayzone/mojom/tabs.mojom` (mirror of outer `packages/shared/mojo-bindings/mojom/tabs.mojom`) + `chrome/browser/slayzone/slayzone_tabs_host.{h,cc}`. One `SlayzoneTabsHost` per `SlayzoneBrowserView`; observes `TabStripModel` + per-tab title/URL/load; fans out full `TabSnapshot` lists to every subscribed `TabObserver`. Stable ids via `tabs::TabHandle::raw_value()`. Nav methods (Load/Back/Fwd/Reload/Stop) act on active tab; Create via `chrome::AddAndReturnTabAt`; Close via `TabInterface::Close`. Build-only; binder registration lands in 6.3. |
| 0015 | `slayzone-Phase-6.2-inline_tab_webview_-slot-TabStripModel-wiring` | 6.2 | `SlayzoneRegionContainer` splits `mid`'s right pane vertically: `browserchrome` placeholder (40px URL-bar strip) over a native `views::WebView` (`inline_tab_webview_`) with no chrome:// slot of its own. `SlayzoneBrowserView` inherits `TabStripModelObserver`, syncs `SetWebContents(active)` at wire-up + on every non-selection-only change. Removes Phase 5.3 spike: `MaybeSpikeTerminalSlot`, `--slayzone-spike-url`, and the PostTask dance. Terminal slot is back to placeholder. |
| 0016 | `slayzone-Phase-6.3-C-binder-scaffold-Option-C-handof` | 6.3 | C++ binder only (Option C handoff). Two new WebUIControllers — `SlayzoneBrowserchromeUI` at `chrome://slayzone-browserchrome/` and `SlayzoneTabbarUI` at `chrome://slayzone-tabbar/` — both expose `BindInterface(slayzone::tabs::mojom::TabsHost)` that forwards to the owning `SlayzoneBrowserView`'s `SlayzoneTabsHost`. Back-pointer lookup via a `WebContentsUserData` installed on every region WebView's `WebContents` in `AddedToWidget` (`SlayzoneBrowserView::FromRegionWebContents`). Binder entries added to `chrome_browser_interface_binders_webui_parts_desktop.cc`. JS URL-bar + tab strip UIs are deferred to Phases 7.8 + 7.2 respectively; Phase 6 exit criteria are verified via CDP/programmatic drives in 6.4 + 6.5. |
| 0017 | `slayzone-Phase-7.1-statusbar-webui` | 7.1 | First real SlayZone surface in the fork. `chrome/browser/slayzone/mojom/statusbar.mojom` + `slayzone_statusbar_host.{h,cc}` — `StatusbarHost::GetSnapshot` forwards to the `SidecarClient` (`statusbar:get-snapshot` RPC). `chrome/browser/ui/webui/slayzone/slayzone_statusbar_ui.{h,cc}` — `chrome://slayzone-statusbar/` WebUIController that serves the `@slayzone/webui-statusbar` Vite bundle from `--slayzone-webui-bundle-dir/<region>/dist/` (fallback inline HTML when unset). `SlayzoneRegionContainer::RegionUrl` routes the `statusbar` region to the dedicated host. Binder + `ChromeURLHosts()` + WebUIConfig registrations follow the 0016 pattern. Outer repo: new `packages/webui/statusbar/` package, `packages/sidecar/src/handlers/statusbar.ts`, `scripts/chromium/run.sh` auto-launches the sidecar. |

Patches not yet authored against real source are tracked in `files/<name>/`
— raw assets + a README describing the context-sensitive edits still owed.

## Authoring

```sh
# in chromium/src/ after source fetch
git checkout -b slayzone/<patch-name>
# ...make edits...
git add -A && git commit
git format-patch -1 --output-directory ../../patches/chromium/ \
  --start-number <N> --subject-prefix=""
```

Patches are rebased onto each Chromium version bump by the merge bot (C1,
activated in Phase 2).
