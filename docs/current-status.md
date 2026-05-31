# Current MVP Status

Last updated: 2026-05-31 America/Vancouver.

## Cloudflare

- Worker: `dm-broadcast-api`
- URL: `https://dm-broadcast-api.magicxiaomin.workers.dev`
- D1: `dm_broadcast_mvp`
- KV: `dm-broadcast-mvp-kv`
- Queue: not enabled

Verified:

- `/health` returns `ok: true`.
- `/v1/dashboard` returns devices, campaigns, task status counts, events, and ledger rows.
- `npm run worker:smoke` proves campaign creation, task claim, `message_sent`, ack-only `message_ack` correlation by `server_msg_id`, `read`, and `read_reward` ledger insertion.
- `apps/worker/migrations/0001_initial.sql` contains the full MVP D1 schema, including the device safety columns used by the Worker pull gate.

## Web

- Local URL: `http://localhost:3000/`
- Can create campaigns/tasks.
- Shows devices, contacts, tasks, events, and ledger.
- Build command verified: `npm run web:build`.

## Android

- Package: `com.magicxiaomin.dmbroadcast.device`
- Device: `N0WR2G0009`
- Linked sender account: `8618205924392:8@s.whatsapp.net`
- Device ID registered to Worker: `android-wa-8618205924392-8`

Verified logs:

- `session_restored`
- `connected`
- `DEVICE scoped id=android-wa-8618205924392-8`
- `CLOUD registered android-wa-8618205924392-8`
- `CLOUD contacts 27 / 27`
- `POLL started`
- Dry-run cloud task was claimed by Android and entered SDK `message_send_start`.

The Android UI now includes a resolver input:

- Enter a phone number or JID.
- Tap `解析并同步`.
- After `getSelfIdentity()` returns `self_jid`, the app derives an account-scoped cloud device ID with the `android-wa-` prefix. `android-prototype` is now only a pre-login fallback, so a second scanned account registers as a separate cloud device instead of sharing the old account queue/safety state.
- The app calls `WaBridgeClient.resolveJID(...)` and only syncs a contact when the SDK returns a registered JID, avoiding fake `phone@s.whatsapp.net` fallbacks.
- The app calls `getUserInfo(...)` before sync/send and prefers a returned LID when available.
- The app shows SDK safety status. It checks `getSafetyStatus()` before pulling tasks from Worker and before sending; risk stop or cooldown pauses polling so cloud tasks are not claimed while the device cannot send.
- The app can report SDK safety status to `/v1/devices/register`, including when `connectBridge()` is blocked by risk stop or emits a bridge `error` event before a normal connection.

The repository also includes a guarded real-recipient E2E runner:

```sh
DM_REAL_CONTACT_JID="..." npm run e2e:real
```

It refuses to create a task unless the recipient JID is explicit.

The repository also includes a read-only real-device readiness check:

```sh
npm run readiness:check
```

It checks Worker health, the cloud device safety row, the real contact JID, Cloudflare API token availability, ADB connectivity, Android app installation, and local `risk-stop.json` before a real IM task is created.

## Real-Recipient Evidence

The MVP real-recipient target has changed to the user's small test account:

- Phone: `+85255804693`
- Default full JID candidate: `85255804693@s.whatsapp.net`
- Contact name in scripts/Web/Android resolver: `小号 +85255804693`

Current sender-device state after switching accounts:

- The Android prototype app data was cleared and another account was scanned.
- The current logged-in sender is `8618205924392:8@s.whatsapp.net`, registered as `android-wa-8618205924392-8`.
- The SDK/UI reached `安全状态：可发送`; the read-only readiness preflight passed with `state: connected` and `retryAfterSeconds: 0`.
- Before intentionally creating another real task, run `npm run readiness:check -- --strict` and confirm the current account-scoped device is not `risk_stopped`, cooling down, or stuck in a non-`connected` bridge state.

Latest real small-account send:

- Task: `task_caee6635-8a76-4751-bc2e-f0591653b68b`.
- Recipient configured as `85255804693@s.whatsapp.net`; SDK `getUserInfo` resolved and sent via LID `125001483219165@lid`.
- Worker recorded `message_send_start` and `message_sent`; server message id `3EB0B7DCFFA3B1ED0E7715`.
- After the user read the message, SDK automatically emitted `message_ack` with `server_msg_id: 3EB0B7DCFFA3B1ED0E7715` and `ack_level: 2`; the `wa` SDK tests define `ack_level: 2` as read receipt.
- The deployed Worker version at that moment did not correlate ack-only events back to the task because the event carried `server_msg_id` but no `clientMsgId`; those ack events were therefore stored with `task_id: null`.
- Worker code now correlates `message_ack` by `server_msg_id`, sets `acked_at`, treats `ack_level >= 2` as read, and writes the idempotent `read_reward` ledger. `npm run worker:safety-smoke` covers this with `ackReadTaskId`.
- The ack-correlation Worker was deployed through `npm run worker:deploy:api`; replaying the real `server_msg_id` online returned `taskId: task_caee6635-8a76-4751-bc2e-f0591653b68b`, wrote `acked_at: 1780211506677`, kept status `read`, and did not duplicate the existing ledger row.
- A manual acceptance `read` event was injected before the ack-correlation fix; Worker updated the task to `read` and inserted `read_reward` ledger `ledger_bfca0bb6-4fdd-4f09-901d-a97f563470fd` with `+5` points for `android-wa-8618205924392-8`.

Previous `萝卜胡` checks are no longer the active MVP send target:

- `resolveJID("18205924392")` failed as not registered.
- `resolveJID("8618205924392")` succeeded as `8618205924392@s.whatsapp.net`.
- A previous real task to that target reached SDK `message_send_start`, then failed with `server returned error 463`.

## Cloudflare Deploy Status

The deployed Worker supports device safety persistence and pull gating:

- `devices` rows are self-migrated with `safety_status`, `safety_retry_after_seconds`, `safety_json`, and `safety_updated_at`.
- `/v1/devices/register` accepts a `safety` payload from Android.
- `/v1/tasks/pull` returns no tasks with `paused: true` when a device reports risk stop/cooldown.
- The Web device table shows `发送安全`.

The currently deployed safety-gate version was completed through the Cloudflare API plugin:

- `npm run worker:deploy` via non-interactive wrangler still requires `CLOUDFLARE_API_TOKEN`.
- `npm run worker:deploy:api` uses the Cloudflare Scripts API directly and can deploy the same Worker without wrangler login once `CLOUDFLARE_API_TOKEN` is present. Without a token it exits safely before upload.
- The latest `npm run worker:deploy:api` completed successfully with reported deployment id/name `dm-broadcast-api`.

The deployed Worker includes the retry-after refinement: risk/cooldown safety remains blocking until `safety_updated_at + safety_retry_after_seconds`, rather than only for a short recent window. This is proven locally by `npm run worker:safety-smoke` and online by manually aging a synthetic device safety timestamp in D1, then confirming deployed pull still returns `paused: true`.

The deployed Worker and local Web include an operations retry enhancement:

- `POST /v1/tasks/requeue` resets `failed` / `claimed` tasks to `pending` and records a `task_requeued` event.
- Web task table shows `重新排队` for `failed` / `claimed` tasks.
- Stale `claimed` tasks older than 10 minutes are automatically released to `pending` before pull and record `task_claim_expired`.
- `npm run worker:safety-smoke` verifies a failed task can be requeued and claimed again, and a stale claimed task can be automatically released and claimed again.

Latest regression:

- `npm run acceptance:check`: safe by default; it does not create another real IM task unless `DM_ACCEPTANCE_RUN_REAL_E2E=1` is set.
- Android `:app:assembleDebug`: passed.
- Android APK installed on `N0WR2G0009`: passed.
- `npm run account-isolation:check`: passed; Android, Web, readiness, and real E2E now support account-scoped `android-wa-*` device IDs.
- `npm run web:build`: passed.
- `npm run worker:check`: passed.
- `npm run worker:safety-smoke`: passed; unexpired retry-after paused, expired retry-after claimed, ready device claimed, failed task requeued and claimed again, stale claimed task released and claimed again, and `message_ack ack_level=2` correlated by `server_msg_id` marks a task read with ledger入账.
- `npm run worker:online-safety-smoke`: passed; deployed Worker paused a synthetic risk-stopped device, verified the task stayed pending, then marked it `failed` for cleanup.
- `npm run worker:smoke`: passed with ack-only `message_ack` correlated by `server_msg_id`, task status `read`, and one `read_reward` ledger row.
- `npm run readiness:check -- --strict`: passed for `android-wa-8618205924392-8`; it reports Worker/D1/KV, contact JID, ADB, app install, and SDK bridge readiness as healthy.
- Online long retry safety check: passed; after manually aging `safety_updated_at` by 10 minutes in D1, deployed Worker still returned `paused: true` because retry-after was still open.
- Online safety pending cleanup: passed; no `online-safety-*` pending tasks remain.
- Real E2E to `+85255804693`: created a real task, Android claimed it, SDK sent it, Worker recorded `message_sent`, SDK later emitted read receipt as `message_ack ack_level=2`, and the deployed Worker now correlates that ack back to the task by `server_msg_id`.

Cloudflare deploy note:

- `CLOUDFLARE_API_TOKEN` was created through the Cloudflare dashboard and verified active.
- `npm run worker:deploy:api` deployed the Worker successfully; reported deployment id/name: `dm-broadcast-api`.
