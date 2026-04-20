---
name: comparison-page
description: "Create or update objective website comparison pages and head-to-head pages from the comparison canon. Use for SlayZone vs competitor pages with quick verdict, last-checked freshness, top-of-page side-by-side screenshots, pick-X-if blocks, balanced strengths/weaknesses for both products, an at-a-glance feature table, and a full matrix below."
trigger: auto
---

Create or update objective public comparison pages.

Use this skill when task is to build, revise, or refresh a website comparison page or head-to-head page such as `SlayZone vs Superset.sh`.

## Load First

- Read [`comparison/COMPETITOR_GUIDE.md`](/Users/Kalle/dev/projects/slayzone/comparison/COMPETITOR_GUIDE.md).
- Read relevant canonical competitor folder in `comparison/<slug>/`.
- Read current website comparison implementation in `website/src/pages/` and `website/src/components/comparison/`.
- Read existing SlayZone website copy for claims that need to be stated about SlayZone.

Only use `comparison/_legacy/` if canonical record does not exist and user explicitly accepts stopgap output.

## Non-Negotiables

- page is comparison, not sales page
- treat both products as capable tools with real tradeoffs
- always name strengths and weaknesses of both sides
- never assume SlayZone wins every axis
- if competitor is stronger on an axis, say so plainly
- if SlayZone is weaker or unclear, say so plainly
- use structured canon fields for table truth
- do not invent facts from prose vibes
- if evidence is weak, say `unknown`, lower confidence, or surface gap

## Required Page Structure

Build page in this order unless user explicitly overrides:

1. Title card with:
   - page title
   - side-by-side screenshots at top: one SlayZone, one competitor
   - `Last checked` freshness near top
   - quick verdict
2. `Pick SlayZone if...` and `Pick <competitor> if...`
3. One section per product:
   - what it is
   - core strengths
   - core weaknesses
4. At-a-glance table:
   - short, high-signal subset of rows
   - include jump link to full matrix if page supports anchor links
5. Full matrix table:
   - broader axis coverage
   - same truth source as at-a-glance table

Do not create separate mid-page "visual proof" section. Visual comparison belongs at top.

## Writing Rules

- quick verdict must be balanced, short, evidence-backed
- avoid loaded winner language like "obliterates", "crushes", "obviously better"
- prefer "best if", "stronger when", "weaker on", "better fit for"
- keep product descriptions symmetrical in ambition and scrutiny
- do not hide ugly facts for either side
- call out architectural differences, not only feature checklist differences
- distinguish:
  - verified facts
  - structured axis verdicts
  - editorial recommendation

## Visual Rules

- top visuals must compare like-with-like as much as possible
- give both screenshots similar weight and framing
- captions should clarify what each screenshot demonstrates
- visuals support orientation; they do not carry factual burden alone
- if one side lacks a good screenshot, say so and avoid fake symmetry

## Freshness Rules

- always show `Last checked`
- if page depends on multiple freshness dates, do not collapse them into misleading single date
- prefer:
  - one date if both sides were checked together
  - two explicit dates if freshness differs materially
- if canon is stale, surface that before publishing confident claims

## Table Rules

- at-a-glance table = decisive subset of full matrix, not separate truth
- full matrix rows must map to explicit structured axes or equally explicit website-side constants
- use consistent verdict vocabulary across page
- row labels should be concrete and comparable
- notes should explain why row matters, not repeat product marketing
- if two products are both strong on row, show that; do not force artificial differentiation

## Workflow

1. Read competitor canon and current website implementation.
2. Build fact baseline for both products.
3. Pick 5-8 decisive rows for at-a-glance table.
4. Build full matrix from structured axes.
5. Draft balanced quick verdict.
6. Draft `Pick X if...` blocks from fit, not hype.
7. Write one neutral strengths/weaknesses section per product.
8. Place screenshots in hero/title card.
9. Verify tables, freshness labels, and verdict language stay consistent.
10. Build/test page on desktop and mobile.

## Stop Conditions

Pause and call out gap when:

- competitor canon is stale or missing key axes
- SlayZone claim is not grounded in current site/product truth
- screenshots are missing for one side and user has not approved asymmetric fallback
- quick verdict starts sounding like ad copy
- at-a-glance rows disagree with full matrix truth

## Output Goal

Ship page that helps reader decide which product fits them.

Reader should leave understanding:

- what each product is for
- where each product is stronger
- where each product is weaker
- which one fits their workflow better
