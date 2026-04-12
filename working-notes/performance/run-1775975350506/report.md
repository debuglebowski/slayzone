# SlayZone perf run

- run dir: `/Users/Kalle/dev/projects/slayzone/working-notes/performance/run-1775975350506`
- scenarios: 3
- generated: 2026-04-12T06:29:47.886Z

---

## create-task

> Open Create Task dialog, fill title, submit, wait for new task in DB.

- iterations: 5 (warmup dropped: 1)
- wall time: p50=**3234ms** p95=**3671ms** max=3671ms
- profiler actual duration p95: 271.1ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 3058ms | 0ms | 154.9ms | 0 | 9 |
| 1 | 2433ms | 0ms | 191.9ms | 0 | 20 |
| 2 | 3308ms | 0ms | 212.2ms | 0 | 14 |
| 3 | 3234ms | 0ms | 247.0ms | 0 | -7 |
| 4 | 3671ms | 0ms | 271.1ms | 0 | 17 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 105 | 690.1ms | 24.9ms |
| app | nested-update | 145 | 387.0ms | 37.8ms |

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
- wall time: p50=**104ms** p95=**112ms** max=112ms
- profiler actual duration p95: 10.8ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 112ms | 0ms | 10.8ms | 0 | 5 |
| 1 | 104ms | 0ms | 8.4ms | 0 | 4 |
| 2 | 102ms | 0ms | 8.5ms | 0 | 4 |
| 3 | 100ms | 0ms | 9.0ms | 0 | 4 |
| 4 | 105ms | 0ms | 9.2ms | 0 | -17 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 10 | 26.6ms | 4.3ms |
| app | nested-update | 40 | 19.3ms | 2.0ms |

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
- wall time: p50=**172ms** p95=**788ms** max=788ms
- profiler actual duration p95: 12.6ms
- long task total p95: 0ms
- IPC calls per iteration p50: 0

| iter | wall | longTask | profiler.actual Σ | IPC count | heap Δ MB |
|------|------|---------:|-----------------:|---------:|---------:|
| 0 | 171ms | 0ms | 12.3ms | 0 | 6 |
| 1 | 166ms | 0ms | 11.3ms | 0 | 7 |
| 2 | 172ms | 0ms | 12.3ms | 0 | 7 |
| 3 | 788ms | 0ms | 12.4ms | 0 | -10 |
| 4 | 210ms | 0ms | 12.6ms | 0 | 7 |

### Top React commits (by Σ actualDuration)

| component (id) | phase | commits | Σ actual | max |
|---|---|---:|---:|---:|
| app | update | 13 | 35.1ms | 7.3ms |
| app | nested-update | 11 | 25.8ms | 5.5ms |

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
