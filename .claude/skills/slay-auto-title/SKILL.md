---
name: slay-auto-title
description: "Automatically title tasks based on conversation context"
trigger: auto
---

Once you have enough context to understand what the task is about, update its title to reflect the actual work being done. Always update — even if the task already has a title.

## Rules

- Prepend a unique emoji to the title that captures the task's essence (e.g. 🐛 for bug fix, ✨ for feature, 🔧 for refactor, 📝 for docs). Pick an emoji distinct from other recent tasks so the title stands out at a glance.
- Derive a short, action-oriented title from the conversation (under 60 characters, including emoji)
- Good titles start with a verb after the emoji: "🐛 Fix …", "✨ Add …", "🔧 Refactor …", "🔍 Investigate …"
- Update regardless of whether the task already has a title — overwrite freely
- Update again if the scope shifts significantly during the conversation
- Use: `slay tasks update --permanent --title "<emoji> <title>"`
