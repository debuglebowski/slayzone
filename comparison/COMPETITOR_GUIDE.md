# Competitor Authoring Guide

This guide defines how to create and update competitor records in the comparison canon.

The canon should be usable long after the first implementation pass. That means every new record should be easy to:

- compare against other competitors
- render into public website views
- revisit later when the product changes
- understand without redoing the original research

## Core Principles

### Neutral canon, opinionated outputs

`comparison/` is the neutral research layer.

The website can be opinionated. The canon should not be shaped around one website view. Every public page should be a projection of the canon, not a separate source of facts.

### Facts, evaluations, and opinion must stay separate

Every record should clearly separate:

- verified facts
- structured evaluations
- editorial interpretation

This is the most important rule in the system.

### Structure drives the site

Any data needed for:

- comparison table cells
- filters
- related competitor links
- summary cards

must exist in frontmatter or another explicit structured field. Do not rely on parsing prose.

### The corpus must be maintainable

This program will grow over time. The shape of the records should make future additions routine, not bespoke.

## Storage Format

Use one folder per competitor.

Target structure:

```text
comparison/
  README.md
  COMPETITOR_GUIDE.md
  TRACKING.md
  _legacy/
  _research/
  _template/
  <slug>/
    index.md
    assets/
```

### `index.md`

The canonical record. Contains:

- standardized frontmatter
- longform markdown body

### `assets/`

Store screenshots and other supporting visual material here.

Use assets as evidence, not decoration.

## Legacy Format

Existing flat files in `comparison/_legacy/` are legacy records.

Migration policy:

- do not delete legacy research until the folder-based record is complete
- migrate highest-priority competitors first
- once migrated, replace, archive, or remove the legacy file in a way that avoids split truth

## Narrative Research Notes

`comparison/_research/` is for non-canonical market synthesis only.

Allowed there:

- category-level market analysis
- positioning narratives
- competitive trend notes

Not allowed there:

- source-of-truth product tables
- structured facts that should live in competitor canon
- filter-driving data for the website

If a table or matrix in `_research/` starts acting like source of truth, move that data into canonical competitor records or remove it.

## Revalidation Workflow

When updating an existing competitor, treat the stored record as a baseline, not as unquestioned truth.

The purpose of the existing record is to accelerate research, not to bypass validation.

Rules:

- read the current record first before doing new research
- treat stored facts, verdicts, and editorial conclusions as provisional
- re-check the highest-impact claims against current primary sources
- assume some claims may have changed since the last review
- update facts and structured verdicts before rewriting narrative prose
- if a previously strong claim is no longer clearly supported, lower confidence or mark it `unknown`
- only refresh `last_checked` after the revalidation pass is complete

Recommended revalidation order:

1. Product identity and links
2. Pricing and packaging
3. Core comparison axes
4. Deployment and provider model
5. Editorial interpretation
6. Screenshots and visual evidence

If the product has materially changed, prefer revising the structured data first and then rewriting any sections of prose that depended on the old assumptions.

## Required Record Layers

Each competitor record must include these three layers.

### 1. Verified facts

These are sourced, concrete statements.

Required fields:

- `name`
- `slug`
- `status`
- `last_checked`
- `primary_category`
- `secondary_categories`
- `platforms`
- `workflow_shape`
- `deployment_model`
- `provider_model`
- `license`
- `pricing`
- `relevance`
- `links`
- `comparison_axes`
- `sources`
- `tags`

Recommended extra fields when known:

- company name
- company stage
- launch year
- GitHub stars
- funding context
- install/distribution model

Suggested `status` values:

- `active`
- `watch`
- `archived`
- `dead`

### 2. Structured evaluations

These power the comparison table and filters.

Each axis should be an object with:

- `verdict`
- `confidence`
- `note`
- `source_ids`
- `last_checked`

Allowed verdicts:

- `yes`
- `partial`
- `no`
- `unknown`

Allowed confidence values:

- `high`
- `medium`
- `low`

Core comparison axes:

- `kanban_board`
- `real_terminal`
- `embedded_browser`
- `code_editor`
- `git_worktree_isolation`
- `mcp_client`
- `mcp_server`
- `multi_provider_agents`
- `local_first`
- `native_desktop`
- `cli_companion`
- `issue_sync`
- `pr_review_workflow`
- `team_collaboration`
- `mobile_remote`
- `oss_posture`

If we add new comparison axes later, add them intentionally and update the template and tracker.

### 3. Editorial interpretation

This layer is allowed to be subjective, but it must be explicit.

Required editorial fields:

- short product thesis
- why it matters to SlayZone
- strengths
- weaknesses
- best-fit user/team
- relevance tier

This layer must be grounded in the facts and evaluations above it.

## Stable Fields vs Tags

Use explicit fields for stable dimensions. Use tags only for softer clustering.

Stable fields:

- category
- platform
- workflow shape
- deployment model
- provider model
- license
- pricing
- relevance tier

Tags:

- should be short and reusable
- should help discovery and filtering
- should not replace explicit schema fields

Good tags:

- `agent-orchestrator`
- `desktop-first`
- `browser-preview`
- `codex-wrapper`
- `claude-centric`
- `enterprise-friendly`
- `watch-closely`

Bad tags:

- tags that duplicate an existing stable field
- one-off sentence tags
- opinionated tags that are not explained in the body

## Source Rules

Every major claim should be backed by sources.

Preferred source order:

1. Official website
2. Official docs
3. Official changelog
4. Official repository
5. Official pricing page
6. Credible third-party reporting
7. Community discussion

Rules:

- cite the strongest source available
- record `last_checked`
- use community posts for sentiment or complaints, not core product facts when a primary source exists
- if a claim is not confidently verifiable, mark the verdict `unknown` or lower the confidence

## Screenshot Rules

Screenshots should live in the competitor's `assets/` directory.

For each screenshot, capture:

- file path
- caption
- what it proves
- source URL
- capture date

Good screenshot use cases:

- board or workspace layout
- terminal or browser proof
- diff/review flow
- worktree or branch UI
- pricing or packaging evidence when needed

## Markdown Body Template

Every competitor body should use the same broad shape:

1. Summary
2. Positioning
3. Best-fit user or team
4. Structured feature analysis
5. Strengths
6. Weaknesses
7. Pricing and packaging
8. Community or market signal
9. Why it matters to SlayZone
10. Sources

The body should explain the structured data, not duplicate it mechanically.

## Writing Rules

- Be concrete before being clever.
- Do not hide opinions inside fact statements.
- Prefer dated claims over timeless phrasing.
- Keep the summary short and decisive.
- Use the same feature names as the structured axes where possible.
- When a feature is partial, explain the boundary.

## Publish-Ready Checklist

A competitor record is publish-ready when:

- the record is in a folder, not only a flat legacy file
- required frontmatter exists
- every core axis has a verdict
- all major verdicts have notes and source ids
- `last_checked` is set
- strengths and weaknesses are filled in
- the body follows the standard section order
- at least one relevant visual asset exists for UI-heavy competitors, or the absence is intentional

## Maintenance Rules

When a competitor changes materially:

- start from the existing record, but revalidate it instead of assuming it is still correct
- update the affected frontmatter fields first
- update the feature verdicts second
- update the prose third
- refresh `last_checked`
- note the update in [TRACKING.md](./TRACKING.md) if the status changes

Use the canonical template in [`_template/index.md`](./_template/index.md) for all new competitors.
