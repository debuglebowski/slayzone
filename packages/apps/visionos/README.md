# SlayZone Spatial

The visionOS prototype uses the hub's real project board, task views, terminals,
and task details. The launcher opens the project's default board or creates a
named window group for that project. Tasks and detached panels opened from that
board inherit its group. You can open several tasks at once.

## Run on the Mac

1. Build the web shell, hub, and computer from the `poc/spatial` worktree. Use the
   Node and pnpm versions in the root `package.json`.

   ```sh
   pnpm install
   pnpm --filter @slayzone/web-shell build
   pnpm --filter @slayzone/hub --filter @slayzone/computer build
   node packages/apps/visionos/demo-hub.mjs
   ```

   The last command starts a loopback hub and computer with isolated demo data
   and two tasks backed by live shells. Leave it running. Alternatively, use a
   hub serving this branch's web shell with a connected computer and a project
   assigned to it. Panel handoff needs a secure context, such as loopback on the
   simulator or HTTPS on a headset.

2. Generate and open the project in Xcode with the visionOS simulator installed.

   ```sh
   cd packages/apps/visionos
   brew install xcodegen
   xcodegen generate
   open SlayZoneSpatial.xcodeproj
   ```

3. Run the `SlayZoneSpatial` scheme on the Apple Vision Pro simulator. The default
   hub is `http://127.0.0.1:3000`. Use **Hub** in the launcher toolbar to change it.

## Try the workflow

1. Use **New group** on **Spatial Demo**, name it, and open both tasks from its board.
2. Move the two windows apart with the visionOS window controls. Start the shell
   if prompted, and run `export SPATIAL_CHECK=ready` in the first task.
3. Pull **Terminal** by its detach handle until **Release to detach** appears, or
   press the handle. Resize the resulting window with its system resize control.
   Run `echo "$SPATIAL_CHECK"` and check that it still prints `ready`.
4. Detach **Task details** to open the live notes and settings in a separate
   window. Use **Return panel to task** on the terminal and check the shell
   variable again in the original task.

visionOS chooses the initial placement of each window. The tear-out gesture
opens a window on release; use the system window controls for placement in the
room. Group names are saved on this client. Window geometry is managed by
visionOS. To exercise the web flow first, open
`http://127.0.0.1:3000/?spatial=launcher` in a browser.

Run the Swift tests from this directory with the repo's build lock.

```sh
node ../../../scripts/ios-build.mjs exec -- xcodebuild test \
  -scheme SlayZoneSpatial \
  -destination 'platform=visionOS Simulator,name=Apple Vision Pro'
```
