---
name: comparison-publishing
description: "Turn canonical competitor data into website-ready outputs."
trigger: auto
---

Turn canonical competitor data into website-ready outputs.

Use this skill when the task is to create comparison table rows, filters, summaries, or SEO page inputs from the canon.

## Load First

- Read [`comparison/COMPETITOR_GUIDE.md`](/Users/Kalle/dev/projects/slayzone/comparison/COMPETITOR_GUIDE.md) for the fact/evaluation/opinion boundary.
- Read [`comparison/TRACKING.md`](/Users/Kalle/dev/projects/slayzone/comparison/TRACKING.md) if freshness or readiness matters.
- Read the relevant canonical competitor folders in `comparison/<slug>/`.

Only fall back to `comparison/_legacy/` if the user explicitly wants a stopgap or the canonical record does not exist yet.

## What This Skill Produces

- comparison table rows
- filter group suggestions
- short competitor summaries
- SEO page briefs
- head-to-head output inputs

## Publishing Rules

- the canon is the only source of truth
- do not invent new facts in publishing output
- compress and reframe; do not silently re-research
- if a required field is missing from canon, surface the gap instead of making it up
- keep opinionated website language traceable to the editorial layer in canon

## Publishing Workflow

1. Read the relevant canonical records.
2. Extract structured fields first:
   - categories
   - tags
   - comparison axes
   - relevance
3. Use prose only for:
   - summary compression
   - strengths and weaknesses
   - positioning angle
4. Produce the target format.
5. If output requirements expose schema gaps, hand off to `comparison-taxonomy` rather than patching around them.

## Stop Conditions

Pause and call out a gap when:

- the needed competitor is only in `_legacy/`
- a table/filter value is only implied in prose
- the record is stale and the output claims would be risky

