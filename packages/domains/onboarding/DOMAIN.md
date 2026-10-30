# Onboarding Domain

First-run tutorial flow. Client-only domain (shared/ and main/ are placeholders).

## Client (client/)

- `OnboardingDialog` - Multi-step tutorial dialog

## Dependencies

None.

## Hosts

Desktop only. The web shell mounts renderer-app with `mountApp({ onboarding: false })`: no
`OnboardingDialog`, no follow-up `CliInstallDialog`, and `useOnboardingChecklist({ enabled: false })`
returns no checklist, so the sidebar has no Getting Started entry (and nothing opens the tour).

## Decision Log

**2026-10-30: No onboarding in the web shell**
Product call. Covers the whole first-run surface: dialog, CLI-install prompt, Getting Started
checklist (its community/X links also open on the hub's machine, not the viewer's browser).
