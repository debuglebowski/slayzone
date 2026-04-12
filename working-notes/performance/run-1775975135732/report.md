# SlayZone perf run

- run dir: `/Users/Kalle/dev/projects/slayzone/working-notes/performance/run-1775975135732`
- scenarios: 3
- generated: 2026-04-12T06:25:54.366Z

---

## create-task

> Open Create Task dialog, fill title, submit, wait for new task in DB.

- iterations: 5 (warmup dropped: 1)
- wall time: p50=**309ms** p95=**398ms** max=398ms
- profiler actual duration p95: 0.0ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 257ms | 0ms | 0.0ms | 0 | -3 |
| 1 | 291ms | 0ms | 0.0ms | 0 | 0 |
| 2 | 309ms | 0ms | 0.0ms | 0 | 3 |
| 3 | 346ms | 0ms | 0.0ms | 0 | 10 |
| 4 | 398ms | 0ms | 0.0ms | 0 | -3 |

_No React Profiler commits captured. Was the app built with `SLAYZONE_PROFILE=1`?_

### Long tasks

- count: 0
- total: 0ms
- max single: 0ms

### CPU profiles

Open in Chrome DevTools → Performance → Load profile:
- `create-task-iter0.cpuprofile`
- `create-task-iter1.cpuprofile`
- `create-task-iter2.cpuprofile`
- `create-task-iter3.cpuprofile`
- `create-task-iter4.cpuprofile`

---

## open-create-task-dialog

> Open the Create Task dialog from the kanban view, wait for content interactive.

- iterations: 5 (warmup dropped: 1)
- wall time: p50=**35ms** p95=**42ms** max=42ms
- profiler actual duration p95: 0.0ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 33ms | 0ms | 0.0ms | 0 | 4 |
| 1 | 31ms | 0ms | 0.0ms | 0 | 3 |
| 2 | 35ms | 0ms | 0.0ms | 0 | 3 |
| 3 | 38ms | 0ms | 0.0ms | 0 | 4 |
| 4 | 42ms | 0ms | 0.0ms | 0 | -16 |

_No React Profiler commits captured. Was the app built with `SLAYZONE_PROFILE=1`?_

### Long tasks

- count: 0
- total: 0ms
- max single: 0ms

### CPU profiles

Open in Chrome DevTools → Performance → Load profile:
- `open-create-task-dialog-iter0.cpuprofile`
- `open-create-task-dialog-iter1.cpuprofile`
- `open-create-task-dialog-iter2.cpuprofile`
- `open-create-task-dialog-iter3.cpuprofile`
- `open-create-task-dialog-iter4.cpuprofile`

---

## switch-task

> Switch between two already-open task tabs.

- iterations: 5 (warmup dropped: 1)
- wall time: p50=**66ms** p95=**69ms** max=69ms
- profiler actual duration p95: 0.0ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 54ms | 0ms | 0.0ms | 0 | 6 |
| 1 | 66ms | 0ms | 0.0ms | 0 | 6 |
| 2 | 69ms | 0ms | 0.0ms | 0 | 6 |
| 3 | 67ms | 0ms | 0.0ms | 0 | -17 |
| 4 | 61ms | 0ms | 0.0ms | 0 | 6 |

_No React Profiler commits captured. Was the app built with `SLAYZONE_PROFILE=1`?_

### Long tasks

- count: 0
- total: 0ms
- max single: 0ms

### CPU profiles

Open in Chrome DevTools → Performance → Load profile:
- `switch-task-iter0.cpuprofile`
- `switch-task-iter1.cpuprofile`
- `switch-task-iter2.cpuprofile`
- `switch-task-iter3.cpuprofile`
- `switch-task-iter4.cpuprofile`

---
