# SlayZone Spatial (visionOS POC)

Each SlayZone panel opens as its own visionOS window that you can place anywhere.

- **Launcher window:** the hub address and your project list.
- **Board window:** one per project, opened from the launcher.
- **Task window:** one per task, opened from a board or a linked task.

Every window is a `WKWebView` of the hub's web shell with `?spatial=<panel>`
(`packages/apps/renderer-app/src/spatial/`). The page asks for new windows via
`window.webkit.messageHandlers.slayzoneSpatial` (`spatial-bridge.ts`). In a
normal browser, the same routes open browser windows, so you can test without
the headset.

## Run on the Mac (simulator)

1. Build the web shell and start a hub that serves it. Not verified yet: the
   commands, port and auth setup may need adjusting.
   ```sh
   pnpm install
   pnpm --filter @slayzone/web-shell build
   pnpm --filter @slayzone/hub build
   node packages/apps/hub/dist/bin.cjs   # SLAYZONE_HUB_LISTEN_ADDRESS=127.0.0.1:<port> to pick a port
   ```
   Check it in Safari first: `http://localhost:<port>/?spatial=launcher` should
   list your projects.
2. Generate and open the Xcode project:
   ```sh
   cd packages/apps/visionos
   brew install xcodegen   # once
   xcodegen generate
   open SlayZoneSpatial.xcodeproj
   ```
3. Run the `SlayZoneSpatial` scheme on the Apple Vision Pro simulator. Enter
   `http://localhost:<port>` as the hub address.
4. Unit tests: `xcodebuild test -scheme SlayZoneSpatial -destination 'platform=visionOS Simulator,name=Apple Vision Pro'`.
   Per CLAUDE.md, run builds through the repo's build lock.

Debug a panel from Safari > Develop > (simulator) > the page.

## Known POC limits

- A real headset needs the hub reachable on the network, and over https
  outside loopback (see the env var rules in CLAUDE.md).
- Window placement is saved by visionOS itself, not on the hub.
- Quest and Android XR are not covered yet. The web side is platform-neutral;
  only this native shell is visionOS-specific.
