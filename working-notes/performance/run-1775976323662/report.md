# SlayZone perf run

- run dir: `/Users/Kalle/dev/projects/slayzone/working-notes/performance/run-1775976323662`
- scenarios: 3
- generated: 2026-04-12T06:46:04.123Z

---

## create-task

> Open Create Task dialog, fill title, submit, wait for new task in DB.

- iterations: 5 (warmup dropped: 1)
- wall time: p50=**3298ms** p95=**3750ms** max=3750ms
- profiler actual duration p95: 276.9ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 3298ms | 0ms | 186.1ms | 0 | 5 |
| 1 | 2506ms | 0ms | 200.5ms | 0 | 15 |
| 2 | 3256ms | 0ms | 226.9ms | 0 | 13 |
| 3 | 3327ms | 0ms | 247.6ms | 0 | 1 |
| 4 | 3750ms | 0ms | 276.9ms | 0 | 16 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 101 | 705.9ms | 27.0ms |
| app | nested-update | 140 | 432.1ms | 37.8ms |

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
- wall time: p50=**114ms** p95=**118ms** max=118ms
- profiler actual duration p95: 10.4ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 116ms | 0ms | 9.5ms | 0 | 4 |
| 1 | 114ms | 0ms | 10.4ms | 0 | 3 |
| 2 | 118ms | 0ms | 10.4ms | 0 | 4 |
| 3 | 108ms | 0ms | 8.0ms | 0 | 4 |
| 4 | 106ms | 0ms | 8.4ms | 0 | -44 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 10 | 27.2ms | 5.0ms |
| app | nested-update | 40 | 19.5ms | 2.3ms |

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
- wall time: p50=**179ms** p95=**584ms** max=584ms
- profiler actual duration p95: 13.1ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 264ms | 0ms | 12.6ms | 0 | 12 |
| 1 | 584ms | 0ms | 13.1ms | 0 | -23 |
| 2 | 179ms | 0ms | 11.8ms | 0 | 7 |
| 3 | 162ms | 0ms | 11.9ms | 0 | -18 |
| 4 | 173ms | 0ms | 11.7ms | 0 | 8 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 16 | 35.0ms | 7.2ms |
| app | nested-update | 11 | 26.1ms | 5.7ms |

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
