# Comparison Program

This directory is the long-term source of truth for SlayZone competitor research.

The goal is not only to publish a comparison table. The goal is to maintain a reusable research canon that can keep expanding over time and can drive:

- the public comparison table
- filterable competitor views
- SEO competitor subpages
- future head-to-head comparison pages

## Operating Model

The comparison program has three layers:

- Canonical competitor records
  - One competitor per folder.
  - Structured frontmatter for machine-readable facts and verdicts.
  - Markdown body for longform explanation, rationale, and sources.
- Authoring rules
  - See [COMPETITOR_GUIDE.md](./COMPETITOR_GUIDE.md).
- Program tracking
  - See [TRACKING.md](./TRACKING.md).

## Current State

The current corpus is a mix of:

- canonical program docs at the root of `comparison/`
- legacy flat competitor files in [`_legacy/`](./_legacy/README.md)
- non-canonical narrative synthesis in [`_research/`](./_research/README.md)

The target format is:

```text
comparison/
  README.md
  COMPETITOR_GUIDE.md
  TRACKING.md
  _legacy/
  _research/
  _template/
  <competitor-slug>/
    index.md
    assets/
```

The migration should happen incrementally. We do not need to convert the entire corpus at once.

## Canonical Record Rules

- Facts belong in structured frontmatter.
- Longform argumentation belongs in the markdown body.
- Public pages may compress or reframe the canon, but may not invent facts that are not present in the canon.
- Filters and table cells must come from structured fields, never from parsed prose.
- Subjective opinions are allowed, but they must be clearly separated from verified facts.

## Documents

- [COMPETITOR_GUIDE.md](./COMPETITOR_GUIDE.md)
  - How to research, write, structure, cite, and update competitor records.
- [TRACKING.md](./TRACKING.md)
  - Which competitors exist, which are missing, and what status each one is in.
- [_legacy/README.md](./_legacy/README.md)
  - Legacy flat-file corpus kept as migration input.
- [_research/README.md](./_research/README.md)
  - Narrative market synthesis that is useful context, but not canonical source-of-truth data.
- [_template/index.md](./_template/index.md)
  - Canonical competitor record template.
