---
name: competitor-discovery
description: "Find new competitors worth adding to the comparison program."
trigger: auto
---

Find new competitors worth adding to the comparison program.

Use this skill when the task is to discover, shortlist, or prioritize emerging products, not to fully research one specific competitor.

## Load First

- Read [`comparison/TRACKING.md`](/Users/Kalle/dev/projects/slayzone/comparison/TRACKING.md) to avoid duplicate discovery work.
- Read [`comparison/COMPETITOR_GUIDE.md`](/Users/Kalle/dev/projects/slayzone/comparison/COMPETITOR_GUIDE.md) if you need the current relevance tiers or schema vocabulary.

## What This Skill Does

- finds new competitors
- classifies them into the existing comparison landscape
- assigns an initial relevance tier
- recommends whether to add them to the tracker now, watch them, or ignore them

This skill does not produce a full canonical competitor profile. Hand off to `competitor-research` for that.

## Discovery Workflow

1. Start from the current tracker and existing corpus.
2. Look for missing products in the most relevant clusters first:
   - agent orchestrators
   - first-party coding agents
   - desktop agent environments
   - PM tools that overlap with execution workflows
3. De-duplicate against:
   - `comparison/<slug>/`
   - `comparison/_legacy/`
   - aliases already noted in the tracker
4. For each candidate, decide:
   - category
   - what job it does
   - whether it is direct, adjacent, or monitor-only
5. Recommend one of:
   - add now
   - watch
   - ignore

## Output Format

For each candidate, provide:

- name
- segment
- why it matters
- initial relevance tier: `core`, `high`, or `monitor`
- recommendation: `add now`, `watch`, or `ignore`

Keep discovery output concise. The point is triage, not full research.

## Discovery Rules

- optimize for relevance, not exhaustiveness
- prefer active products over abandoned repos
- distinguish direct competitors from adjacent substitutes
- do not write a canonical profile here
- if a candidate looks important but facts are thin, still add it to the tracker with `missing`

