# Mobile push notifications

Status: plan. Nothing built yet.

## Outcome

The iOS app gets a push when an agent finishes a turn the user started (task
becomes "Ready for review") or fails. Tapping it opens that task. Works with
several hubs, with self-hosted hubs, and while the app is closed.

## The trigger already exists

The hub sets `tasks.needs_attention` in `handleAttentionTransition`
(`packages/domains/task/src/server/attention.ts`), called from
`onGlobalStateChange` in `packages/apps/hub/src/composition.ts:845`. A push
fires on the same edge: `changed && needs_attention` became true. One source
of truth; the 🔔 sheet, desktop dots and the push never disagree.

Error vs ready: `newState` (`idle` / `error`) picks the wording.

## Delivery: Expo Push Service

```
hub ──POST exp.host/--/api/v2/push/send──▶ Expo ──▶ APNs ──▶ iPhone
```

- Self-hosted hubs can't hold SlayZone's APNs key; Expo holds it (uploaded
  once to the EAS project). Hubs only need the device's Expo push token.
- No relay of our own to build or run. Expo gives tickets + receipts and
  reports `DeviceNotRegistered`.
- Accepted trade-off: the token is bearer-like (no enhanced security — we
  can't put an Expo access token on every hub). A hub the user removed, or a
  shared hub's admin, could keep pushing to the phone. Impact: unwanted
  notifications only; no data leaves the phone. Mitigation: the app can
  rotate its token (re-register with remaining hubs) from Settings.

## Pieces

1. **One-time setup**
   - Create the EAS project; put `extra.eas.projectId` in `app.json`
     (required by `getExpoPushTokenAsync`). Builds stay local
     (`scripts/ios-build.mjs`); EAS is only used for push credentials.
   - Upload the APNs `.p8` key (team `DRAYKWYC94`, bundle `zone.slay.app`).
2. **Mobile**
   - Add `expo-notifications` (config plugin adds the `aps-environment`
     entitlement). Ask for permission after the first successful sign-in, not
     at launch.
   - Get the Expo push token, register it with each signed-in hub; re-register
     when the token changes (`addPushTokenListener`).
   - On sign-out / hub removal (`hubs/hub-removal`): unregister at that hub.
   - Tap → `slayzone://task/<hub>/<id>` via the existing `deep-links.ts`.
   - Settings: per-hub toggle; "ready for review" and "errors" toggles;
     "Reset notification token"; **Style: Each agent / Summary**.
   - Notification Service Extension (Swift target via config plugin, shares
     an App Group with the app). Every push passes through it:
     - *Each agent*: shows the push as sent (one per task, grouped by
       `threadIdentifier` = hub).
     - *Summary*: merges it with the waiting tasks it already knows (App
       Group state, all hubs) into "3 agents waiting: A, B, C", and removes
       the earlier summary so only one remains.
     The hub sends the same payload either way; the style is a phone-only
     choice.
   - Foreground: no banner if that task is on screen.
3. **Hub**
   - Table `push_devices (user_id, device_id, expo_token, prefs, created_at,
     last_ok_at)` in the auth DB. tRPC `push.register / unregister /
     updatePrefs`, bearer auth as today.
   - Recipients: users who can see the task (`user-access.ts`), not every user.
   - Sender module beside the attention consumer: build payload, POST to Expo
     (batches of ≤ 100), check receipts later, delete the device on
     `DeviceNotRegistered`. Debounce per task (≥ 30 s).
   - Diagnostics event per send (`push.sent` / `push.failed`), like
     `task.attention_transition`.
   - Hub switch `SLAYZONE_HUB_ENABLE_PUSH` (0/1, `hub.config.json` key,
     default 1). Expo endpoint as `SLAYZONE_PUSH_SERVICE_ADDRESS` (authority
     only, env rules 3/5; default `exp.host`) so tests point at a fake.
4. **Clearing**
   - When `needs_attention` clears (opened anywhere, or agent resumes), send a
     data-only push; the app removes the delivered notification for that task
     (`dismissNotificationAsync`, keyed by task id). Badge = attention tasks
     across hubs.

## Privacy

Payload passes Expo and Apple. Default: project name + task title + state.
Hub switch `SLAYZONE_HUB_REQUIRE_PUSH_REDACTED=1` sends only "An agent is ready
for review" + ids; the app fills in details after opening.

## Tests

- Hub unit: attention edge → exactly one send; no send on spawn settle, on
  clear, or within debounce; recipients respect access; receipt
  `DeviceNotRegistered` → device removed.
- Mobile jest: permission flow, register/unregister per hub, token rotation,
  tap → route.
- E2E: hub + fake Expo endpoint asserts payload on a scripted turn end
  (fake-claude, chat group).
- Manual on device: TestFlight build, sandbox vs production APNs.

## Order

1. EAS project + APNs key; hub sender behind the switch, fake Expo in tests.
2. Mobile registration + tap routing.
3. Settings toggles, clearing, badge.
4. Service extension + Style setting (Each agent / Summary).
5. Redaction switch.

## Open questions

- Android later: Expo covers FCM with the same token API.
- Skip the push while the user is on that task in desktop? Needs desktop
  presence; v1 sends anyway.
