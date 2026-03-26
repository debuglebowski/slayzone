# Legacy Comparison Records

This directory contains the pre-canonical flat markdown competitor files.

These files are kept as migration inputs while the comparison program moves toward the folder-based canonical format:

```text
comparison/
  <competitor-slug>/
    index.md
    assets/
```

Rules:

- Do not treat `_legacy/` as the long-term source of truth.
- Do not add new competitors here.
- New competitors should be created from [`../_template/index.md`](../_template/index.md).
- When a competitor is migrated, avoid leaving two active canonical versions behind.

