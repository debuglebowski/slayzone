// Runs before every other module script (no imports, first in index.html):
// raise the Resource Timing buffer from its default 250 entries so the boot
// telemetry (lib/bootTimings.ts) can count every module request — a dev boot
// loads ~1000 modules, and entries past a full buffer are dropped.
performance.setResourceTimingBufferSize(5000)
