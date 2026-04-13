---
name: slay-auto-title
description: "Automatically title tasks based on conversation context"
trigger: auto
---

Once you have enough context to understand what the task is about, update its title to reflect the actual work being done.

## Rules

- Derive a short, action-oriented title from the conversation (under 60 characters)
- Good titles start with a verb: "Fix …", "Add …", "Refactor …", "Investigate …"
- Only update when meaningful context exists — don't rename on trivial exchanges
- Update again if the scope shifts significantly during the conversation
- Use: `slay tasks update --permanent --title "<title>"`
