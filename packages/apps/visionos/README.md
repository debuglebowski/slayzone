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

1. From the `poc/spatial` worktree root, build and start a loopback hub with
   its own data directory. Use the Node and pnpm versions in `package.json`.
   ```sh
   pnpm install
   pnpm --filter @slayzone/web-shell build
   pnpm --filter @slayzone/hub build
   SLAYZONE_ROOT="$(mktemp -d)" \
     SLAYZONE_NONINTERACTIVE=1 \
     SLAYZONE_HUB_LISTEN_ADDRESS=127.0.0.1:3000 \
     node packages/apps/hub/dist/bin.cjs
   ```
   In a second terminal, add a demo project and task through the local hub API.
   ```sh
   curl -fsS -H 'Content-Type: application/json' \
     -d '{"name":"Spatial Demo"}' http://127.0.0.1:3000/api/projects
   curl -fsS -H 'Content-Type: application/json' \
     -d '{"project":"Spatial Demo","title":"Try the task window"}' \
     http://127.0.0.1:3000/api/tasks
   ```
   Open `http://127.0.0.1:3000/?spatial=launcher` in Safari, then select
   **Spatial Demo** and **Try the task window**. For a live terminal, the
   project also needs a connected computer.
2. Generate and open the Xcode project:
   ```sh
   cd packages/apps/visionos
   brew install xcodegen   # once
   xcodegen generate
   open SlayZoneSpatial.xcodeproj
   ```
3. Run the `SlayZoneSpatial` scheme on the Apple Vision Pro simulator. Open
   **Hub** in the launcher toolbar and enter `http://127.0.0.1:3000`.
4. From `packages/apps/visionos`, run the Swift tests through the repo’s build lock.
   ```sh
   node ../../../scripts/ios-build.mjs exec -- xcodebuild test \
     -scheme SlayZoneSpatial \
     -destination 'platform=visionOS Simulator,name=Apple Vision Pro'
   ```

Debug a panel from Safari > Develop > (simulator) > the page.

## Known POC limits

- A real headset needs the hub reachable on the network, and over https
  outside loopback (see the env var rules in CLAUDE.md).
- Window placement is saved by visionOS itself, not on the hub.
- Quest and Android XR are not covered yet. The web side is platform-neutral;
  only this native shell is visionOS-specific.
