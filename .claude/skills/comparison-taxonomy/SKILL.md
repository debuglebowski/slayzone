---
name: comparison-taxonomy
trigger: auto
---

Maintain the comparison schema across the canon.

Use this skill when the task is to define or refine axes, tags, categories, relevance tiers, or normalization rules.

## Load First

- Read [`comparison/COMPETITOR_GUIDE.md`](/Users/Kalle/dev/projects/slayzone/comparison/COMPETITOR_GUIDE.md).
- Read [`comparison/TRACKING.md`](/Users/Kalle/dev/projects/slayzone/comparison/TRACKING.md).
- Read [`comparison/_template/index.md`](/Users/Kalle/dev/projects/slayzone/comparison/_template/index.md).

Inspect a few real competitor records before changing the schema.

## What This Skill Owns

- comparison axes
- tag vocabulary
- category and segment naming
- relevance tiers
- stable field naming
- normalization rules across competitor records

## Taxonomy Workflow

1. Identify the schema pressure:
   - new website filter need
   - repeated inconsistency across competitors
   - missing dimension that keeps showing up in research
2. Prefer the smallest change that resolves the pressure.
3. Decide whether the concept belongs in:
   - a stable field
   - a comparison axis
   - a tag
   - editorial prose only
4. Update all schema authorities together:
   - guide
   - template
   - tracker if statuses or priorities are affected
5. Note migration implications for existing records.

## Taxonomy Rules

- protect schema stability
- prefer explicit fields over overloaded tags
- do not add tags that duplicate stable fields
- do not create new axes unless they will matter across multiple competitors
- do not solve a publishing problem by polluting canonical schema without clear long-term value

## Output Expectations

When making taxonomy changes, always state:

- what changed
- why it was necessary
- which existing records will need normalization later

