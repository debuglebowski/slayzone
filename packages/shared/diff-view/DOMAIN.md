# Shared diff view

Renders parsed unified patches in unified or side-by-side mode. Callers may put
several `DiffView`s in one vertical viewport (artifact and stash previews), or a
single view in the Git panel's split pane. Public component/parser APIs remain
unchanged.

## Virtual list coordinates (FU1 S16)

Each list measures its own origin in its chosen ancestor's scroll coordinates:
list top minus viewport top/border plus viewport scrollTop. That origin becomes
TanStack's `scrollMargin`. Item starts include the margin; DOM transforms subtract
it, while `getTotalSize()` already excludes it. Headers and preceding file sizes
are never assumed constant. This keeps first/middle/end rows of later files
reachable without rendering the whole patch.

`DiffView.scroll.ts` retains bounded vertical viewport discovery, nearest-declared
fallback when nothing overflows, and absolute outer-virtualizer ownership. A list
nested inside an absolute outer row continues plain rendering under that owner's
file-level virtualization. The expanding horizontal wrapper is not restored as
a vertical viewport.

`DiffView.layout.ts` shares one layout observer per viewport. Structural ancestor
and sibling boxes are observed, including preceding files/headers that can move a
list without resizing it. Resize, structural mutation, scroll, window resize and
font completion coalesce into an animation-frame pass. Absolute virtual-row
mount/position/highlight mutations do not trigger redundant scans; TanStack's
row ResizeObserver measures real variable/wrapped row heights, whose changed
list sizer updates the shared layout. Structural observation itself is batched
across file mounts/unmounts, avoiding per-file rescans during Activity cleanup.

Callback refs acquire each DOM list. Layout-effect setup measures immediately;
cleanup releases membership and fences queued callbacks. Last-member cleanup
disconnects observers/listeners and cancels its pending frame. Activity/StrictMode
setup reacquires current geometry. Neither shared observer state nor a disposed
layout resource is retained as an active generation.

Permanent component tests use production React/Compiler/DiffPreview/DiffView and
TanStack with explicitly supplied jsdom geometry/ResizeObserver delivery. They
are not browser-layout evidence. E2E232 provides actual Chromium multi-file
artifact scrolling; E2E231 retains large-preview Activity and Load rest coverage.

## Ancestor invalidation across fallback migration (FU1 S17)

The selected viewport can temporarily become an expanding fallback wrapper when
an outer viewport fits all content. Layout observation retains that wrapper's
ancestor boxes and direct scroll/style/child-list signals, so local resize or
reflow can select a bounded ancestor again without a window resize or React
rerender. Ancestor mutation observation is on each ancestor itself, never its
unrelated page subtree. Synthetic bubbling scroll from unrelated siblings is
ignored.

Structural sibling boxes remain observed through ancestor scroll candidates:
preceding Load rest can create overflow by changing content extent while the
viewport's own box size stays fixed. Virtual-row children are not enumerated.
All invalidation and membership work still coalesces per selected viewport;
root replacement rebinds the ancestor targets/listeners and final cleanup
releases them. Initial non-overflow and bounded/fallback/bounded transitions
retain the same coordinate, nearest-fallback and outer-virtualizer rules.

When binding TanStack's offset observer to a newly selected scroll element, the
adapter seeds it from that element's actual scrollTop. Carrying the previous
wrapper's cached offset would reset or misread an ancestor scroll that caused
the migration. Row measurement and scroll-margin transforms remain unchanged.

Permanent controls include changed-ancestor-only native-delivery models,
style/scroll-only recovery, ancestor replacement, sibling growth, Activity and
shared120-member cleanup/coalescing. Electron232 also waits for completed fallback
migration before shrinking only its local viewport with a stable scrollbar
gutter; all original multi-file content assertions stay in place.
