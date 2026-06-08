# chrome://hello/ smoke test assets

Plain HTML + JS for the Phase 1 smoke test. Assembled into a real Chromium
patch (`patches/chromium/0001-slayzone-hello-page.patch`) once the source
tree is available at `chromium/src/` — the patch also edits:

- `chrome/common/webui_url_constants.{h,cc}` — add `kChromeUISlayzoneHelloHost = "hello"`
- `chrome/browser/ui/webui/chrome_web_ui_controller_factory.cc` — register handler
- a new `chrome/browser/ui/webui/slayzone_hello/slayzone_hello_ui.{h,cc}` WebUIController
- `chrome/browser/ui/webui/slayzone_hello/BUILD.gn` + resource grdp
- `chrome/browser/BUILD.gn` (or nearest GN leaf) — wire into the build graph

Those edits are context-sensitive so they are authored after `scripts/chromium/fetch.sh`
completes. The resource content here is the source of truth and is copied
verbatim into the patch.

Phase 2.2 replaces the manual factory registration with a generic
`chrome://` scheme handler factory — at that point this patch merges into
the factory patch.
