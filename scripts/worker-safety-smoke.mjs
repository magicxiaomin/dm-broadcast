import { unlink } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { applyMigrationsToD1 } from "./lib/d1-migrations.mjs";

const scriptPath = new URL("../apps/worker/src/index.ts", import.meta.url).pathname;
const migrationsDir = new URL("../apps/worker/migrations/", import.meta.url).pathname;
const bundledScriptPath = new URL("../outputs/worker-safety-smoke.mjs", import.meta.url).pathname;
const ADMIN_TOKEN = "worker-safety-admin-token";
const DEVICE_TOKEN = "worker-safety-device-token";

function authHeaders(role) {
  if (role === "admin") return { authorization: `Bearer ${ADMIN_TOKEN}` };
  if (role === "device") return { authorization: `Bearer ${DEVICE_TOKEN}` };
  if (role === "wrong") return { authorization: "Bearer wrong-worker-safety-token" };
  return {};
}

async function api(mf, path, options = {}, role = "admin") {
  const res = await mf.dispatchFetch(`http://worker.test${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(role),
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function expectStatus(mf, label, path, options, role, expectedStatuses) {
  const res = await mf.dispatchFetch(`http://worker.test${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(role),
      ...(options?.headers || {}),
    },
  });
  if (!expectedStatuses.includes(res.status)) {
    const body = await res.text();
    throw new Error(`${label}: expected ${expectedStatuses.join("/")} for ${path}, got ${res.status}: ${body}`);
  }
}

await build({
  entryPoints: [scriptPath],
  outfile: bundledScriptPath,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "silent",
});

const mf = new Miniflare({
  modules: true,
  scriptPath: bundledScriptPath,
  compatibilityDate: "2026-05-30",
  d1Databases: { DB: "DB" },
  kvNamespaces: { STATE: "STATE" },
  bindings: { ADMIN_TOKEN, DEVICE_TOKEN },
});

try {
  const db = await mf.getD1Database("DB");
  const firstMigrations = await applyMigrationsToD1(db, migrationsDir);
  if (
    !firstMigrations.applied.includes("0001_initial.sql") ||
    !firstMigrations.applied.includes("0002_users.sql") ||
    !firstMigrations.applied.includes("0003_device_contacts.sql")
  ) {
    throw new Error(`expected all migrations to apply on fresh DB: ${JSON.stringify(firstMigrations)}`);
  }
  const secondMigrations = await applyMigrationsToD1(db, migrationsDir);
  if (secondMigrations.applied.length !== 0) {
    throw new Error(`migrations should be idempotent on second run: ${JSON.stringify(secondMigrations)}`);
  }

  await expectStatus(mf, "health public", "/health", { method: "GET" }, null, [200]);
  await expectStatus(mf, "campaign requires token", "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({ title: "blocked", message: "blocked", contacts: [] }),
  }, null, [401]);
  await expectStatus(mf, "events require token", "/v1/events", {
    method: "POST",
    body: JSON.stringify({ eventType: "read", taskId: "missing" }),
  }, null, [401]);
  await expectStatus(mf, "pull requires token", "/v1/tasks/pull?deviceId=missing&limit=1", { method: "GET" }, null, [401]);
  await expectStatus(mf, "wrong token rejected", "/v1/tasks/pull?deviceId=missing&limit=1", { method: "GET" }, "wrong", [401]);
  await expectStatus(mf, "users requires admin token", "/v1/users", { method: "GET" }, null, [401]);
  await expectStatus(mf, "device token cannot call users route", "/v1/users", { method: "GET" }, "device", [401, 403]);
  await expectStatus(mf, "device token cannot call admin route", "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({ title: "blocked", message: "blocked", contacts: [] }),
  }, "device", [401, 403]);
  await expectStatus(mf, "campaign requires deviceId", "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Missing device smoke",
      message: "must be rejected",
      points: 1,
      contacts: [{ name: "missing-device", jid: "missing-device@s.whatsapp.net" }],
    }),
  }, "admin", [400]);
  await expectStatus(mf, "pull requires deviceId", "/v1/tasks/pull?limit=1", { method: "GET" }, "device", [400]);
  await expectStatus(mf, "contacts sync requires deviceId", "/v1/contacts/sync", {
    method: "POST",
    body: JSON.stringify({
      contacts: [{ name: "missing owner", jid: "shared-contact@s.whatsapp.net" }],
    }),
  }, "device", [400]);

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "isolation-device-a",
      deviceName: "isolation-device-a",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "isolation-device-b",
      deviceName: "isolation-device-b",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Isolation smoke",
      message: "only device b can claim this",
      deviceId: "isolation-device-b",
      points: 1,
      contacts: [{ name: "isolated", jid: "isolated@s.whatsapp.net" }],
    }),
  }, "admin");
  const isolationPullA = await api(mf, "/v1/tasks/pull?deviceId=isolation-device-a&limit=1", {}, "device");
  if (isolationPullA.tasks.length !== 0) {
    throw new Error(`device A claimed a task assigned to device B: ${JSON.stringify(isolationPullA)}`);
  }
  const isolationPullB = await api(mf, "/v1/tasks/pull?deviceId=isolation-device-b&limit=1", {}, "device");
  if (isolationPullB.tasks.length !== 1 || isolationPullB.tasks[0].deviceId !== "isolation-device-b") {
    throw new Error(`device B did not claim its assigned task: ${JSON.stringify(isolationPullB)}`);
  }

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "safety-paused-device",
      deviceName: "safety-paused-device",
      status: "online",
      safety: {
        risk_stopped: true,
        risk_retry_after_seconds: 3600,
        risk_reason: "smoke",
      },
    }),
  }, "device");

  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Safety smoke",
      message: "must not be claimed",
      deviceId: "safety-paused-device",
      points: 1,
      contacts: [{ name: "paused", jid: "paused@s.whatsapp.net" }],
    }),
  }, "admin");

  const pausedPull = await api(mf, "/v1/tasks/pull?deviceId=safety-paused-device&limit=1", {}, "device");
  if (!pausedPull.paused || pausedPull.tasks.length !== 0) {
    throw new Error(`risk-stopped device should not receive tasks: ${JSON.stringify(pausedPull)}`);
  }

  const pending = await api(mf, "/v1/tasks?status=pending&limit=10", {}, "admin");
  if (!pending.tasks.some((task) => task.device_id === "safety-paused-device")) {
    throw new Error("paused device task was unexpectedly claimed or missing");
  }

  const dashboard = await api(mf, "/v1/dashboard", {}, "admin");
  const device = dashboard.devices.find((item) => item.id === "safety-paused-device");
  if (!device || device.safety_status !== "risk_stopped") {
    throw new Error(`dashboard did not expose device safety: ${JSON.stringify(device)}`);
  }

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "safety-long-retry-device",
      deviceName: "safety-long-retry-device",
      status: "online",
      safety: {
        risk_stopped: true,
        risk_retry_after_seconds: 3600,
        risk_reason: "long-retry",
      },
    }),
  }, "device");
  await db.prepare(
    "UPDATE devices SET safety_updated_at = ?, updated_at = ? WHERE id = ?",
  ).bind(Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000, "safety-long-retry-device").run();
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Long retry smoke",
      message: "still must not be claimed",
      deviceId: "safety-long-retry-device",
      points: 1,
      contacts: [{ name: "long", jid: "long@s.whatsapp.net" }],
    }),
  }, "admin");
  const longRetryPull = await api(mf, "/v1/tasks/pull?deviceId=safety-long-retry-device&limit=1", {}, "device");
  if (!longRetryPull.paused || longRetryPull.tasks.length !== 0) {
    throw new Error(`unexpired retry-after should pause even with old safety_updated_at: ${JSON.stringify(longRetryPull)}`);
  }

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "safety-expired-device",
      deviceName: "safety-expired-device",
      status: "online",
      safety: {
        risk_stopped: true,
        risk_retry_after_seconds: 1,
        risk_reason: "expired",
      },
    }),
  }, "device");
  await db.prepare(
    "UPDATE devices SET safety_updated_at = ?, updated_at = ? WHERE id = ?",
  ).bind(Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000, "safety-expired-device").run();
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Expired safety smoke",
      message: "can be claimed after retry window",
      deviceId: "safety-expired-device",
      points: 1,
      contacts: [{ name: "expired", jid: "expired@s.whatsapp.net" }],
    }),
  }, "admin");
  const expiredPull = await api(mf, "/v1/tasks/pull?deviceId=safety-expired-device&limit=1", {}, "device");
  if (expiredPull.paused || expiredPull.tasks.length !== 1) {
    throw new Error(`expired retry-after should allow claim: ${JSON.stringify(expiredPull)}`);
  }

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "safety-ready-device",
      deviceName: "safety-ready-device",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Ready smoke",
      message: "can be claimed",
      deviceId: "safety-ready-device",
      points: 1,
      contacts: [{ name: "ready", jid: "ready@s.whatsapp.net" }],
    }),
  }, "admin");
  const readyPull = await api(mf, "/v1/tasks/pull?deviceId=safety-ready-device&limit=1", {}, "device");
  if (readyPull.paused || readyPull.tasks.length !== 1) {
    throw new Error(`ready device should receive one task: ${JSON.stringify(readyPull)}`);
  }
  const requeueTaskId = readyPull.tasks[0].id;
  await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      taskId: requeueTaskId,
      deviceId: "safety-ready-device",
      clientMsgId: `dm-${requeueTaskId}`,
      eventType: "message_failed",
      payload: { source: "worker-safety-smoke", reason: "exercise_requeue" },
    }),
  }, "device");
  await api(mf, "/v1/tasks/requeue", {
    method: "POST",
    body: JSON.stringify({ taskId: requeueTaskId, reason: "worker-safety-smoke" }),
  }, "admin");
  const requeuedPending = await api(mf, "/v1/tasks?status=pending&limit=20", {}, "admin");
  if (!requeuedPending.tasks.some((task) => task.id === requeueTaskId)) {
    throw new Error(`requeued task did not return to pending: ${requeueTaskId}`);
  }
  const requeuedPull = await api(mf, "/v1/tasks/pull?deviceId=safety-ready-device&limit=1", {}, "device");
  if (requeuedPull.tasks[0]?.id !== requeueTaskId) {
    throw new Error(`requeued task was not claimable: ${JSON.stringify(requeuedPull)}`);
  }
  await db.prepare(
    "UPDATE tasks SET updated_at = ? WHERE id = ? AND status = 'claimed'",
  ).bind(Date.now() - 20 * 60 * 1000, requeueTaskId).run();
  const staleClaimPull = await api(mf, "/v1/tasks/pull?deviceId=safety-ready-device&limit=1", {}, "device");
  if (staleClaimPull.tasks[0]?.id !== requeueTaskId) {
    throw new Error(`stale claimed task was not released and claimable: ${JSON.stringify(staleClaimPull)}`);
  }
  const claimExpiredEvents = await db.prepare(
    "SELECT * FROM im_events WHERE task_id = ? AND event_type = 'task_claim_expired'",
  ).bind(requeueTaskId).all();
  if (!claimExpiredEvents.results?.length) {
    throw new Error(`stale claim release did not record task_claim_expired for ${requeueTaskId}`);
  }

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "ack-read-device",
      deviceName: "ack-read-device",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Ack read smoke",
      message: "server id ack should mark read",
      deviceId: "ack-read-device",
      points: 7,
      contacts: [{ name: "ack", jid: "ack@s.whatsapp.net" }],
    }),
  }, "admin");
  const ackPull = await api(mf, "/v1/tasks/pull?deviceId=ack-read-device&limit=1", {}, "device");
  const ackTask = ackPull.tasks[0];
  if (!ackTask) {
    throw new Error(`ack-read task was not claimable: ${JSON.stringify(ackPull)}`);
  }
  await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      taskId: ackTask.id,
      deviceId: "ack-read-device",
      clientMsgId: ackTask.clientMsgId,
      eventType: "message_sent",
      payload: {
        source: "worker-safety-smoke",
        server_msg_id: "server-ack-read-smoke",
      },
    }),
  }, "device");
  const ackEvent = await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      deviceId: "ack-read-device",
      eventType: "message_ack",
      payload: {
        server_msg_id: "server-ack-read-smoke",
        ack_level: 2,
      },
    }),
  }, "device");
  if (ackEvent.taskId !== ackTask.id) {
    throw new Error(`message_ack was not correlated by server_msg_id: ${JSON.stringify(ackEvent)}`);
  }
  const ackVerified = await db.prepare(
    "SELECT status, acked_at, read_at FROM tasks WHERE id = ?",
  ).bind(ackTask.id).first();
  if (ackVerified?.status !== "read" || !ackVerified.acked_at || !ackVerified.read_at) {
    throw new Error(`ack_level=2 did not mark task read: ${JSON.stringify(ackVerified)}`);
  }
  const ackLedger = await db.prepare(
    "SELECT points FROM ledger_entries WHERE task_id = ? AND entry_type = 'read_reward'",
  ).bind(ackTask.id).first();
  if (Number(ackLedger?.points || 0) !== 7) {
    throw new Error(`ack_level=2 did not create read_reward ledger: ${JSON.stringify(ackLedger)}`);
  }

  const creator = await api(mf, "/v1/users", {
    method: "POST",
    body: JSON.stringify({
      id: "smoke-user-primary",
      displayName: "Smoke User Primary",
      notes: "worker-safety-smoke",
    }),
  }, "admin");
  if (creator.user?.id !== "smoke-user-primary") {
    throw new Error(`user create did not return created user: ${JSON.stringify(creator)}`);
  }

  await api(mf, "/v1/devices/assign", {
    method: "POST",
    body: JSON.stringify({ deviceId: "ack-read-device", userId: "smoke-user-primary" }),
  }, "admin");
  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "user-second-device",
      deviceName: "user-second-device",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/devices/assign", {
    method: "POST",
    body: JSON.stringify({ deviceId: "user-second-device", userId: "smoke-user-primary" }),
  }, "admin");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Second user device smoke",
      message: "second device contributes points",
      deviceId: "user-second-device",
      points: 3,
      contacts: [{ name: "user-second", jid: "user-second@s.whatsapp.net" }],
    }),
  }, "admin");
  const secondPull = await api(mf, "/v1/tasks/pull?deviceId=user-second-device&limit=1", {}, "device");
  const secondTask = secondPull.tasks[0];
  if (!secondTask) {
    throw new Error(`second user device task was not claimable: ${JSON.stringify(secondPull)}`);
  }
  await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      taskId: secondTask.id,
      deviceId: "user-second-device",
      clientMsgId: secondTask.clientMsgId,
      eventType: "read",
      payload: { source: "worker-safety-smoke" },
    }),
  }, "device");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Pending user smoke",
      message: "sent but unread should be pending confirmation",
      deviceId: "user-second-device",
      points: 4,
      contacts: [{ name: "pending", jid: "pending-user@s.whatsapp.net" }],
    }),
  }, "admin");
  const pendingUserPull = await api(mf, "/v1/tasks/pull?deviceId=user-second-device&limit=1", {}, "device");
  const pendingUserTask = pendingUserPull.tasks[0];
  if (!pendingUserTask) {
    throw new Error(`pending user task was not claimable: ${JSON.stringify(pendingUserPull)}`);
  }
  await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      taskId: pendingUserTask.id,
      deviceId: "user-second-device",
      clientMsgId: pendingUserTask.clientMsgId,
      eventType: "message_sent",
      payload: { source: "worker-safety-smoke" },
    }),
  }, "device");

  await api(mf, "/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      id: "unassigned-user-device",
      deviceName: "unassigned-user-device",
      status: "online",
      safety: { risk_stopped: false },
    }),
  }, "device");
  await api(mf, "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: "Unassigned user smoke",
      message: "unassigned points stay out of user aggregate",
      deviceId: "unassigned-user-device",
      points: 11,
      contacts: [{ name: "unassigned", jid: "unassigned-user@s.whatsapp.net" }],
    }),
  }, "admin");
  const unassignedPull = await api(mf, "/v1/tasks/pull?deviceId=unassigned-user-device&limit=1", {}, "device");
  const unassignedTask = unassignedPull.tasks[0];
  if (!unassignedTask) {
    throw new Error(`unassigned task was not claimable: ${JSON.stringify(unassignedPull)}`);
  }
  await api(mf, "/v1/events", {
    method: "POST",
    body: JSON.stringify({
      taskId: unassignedTask.id,
      deviceId: "unassigned-user-device",
      clientMsgId: unassignedTask.clientMsgId,
      eventType: "read",
      payload: { source: "worker-safety-smoke" },
    }),
  }, "device");

  const users = await api(mf, "/v1/users", {}, "admin");
  const smokeUser = users.users.find((user) => user.id === "smoke-user-primary");
  if (!smokeUser) {
    throw new Error(`created user missing from users list: ${JSON.stringify(users)}`);
  }
  if (Number(smokeUser.points || 0) !== 10 || Number(smokeUser.device_count || 0) !== 2) {
    throw new Error(`user aggregate should include two assigned devices only: ${JSON.stringify(smokeUser)}`);
  }
  if (Number(smokeUser.pending_points || 0) !== 4 || Number(smokeUser.pending_tasks || 0) !== 1) {
    throw new Error(`user pending aggregate should count assigned sent/unread tasks: ${JSON.stringify(smokeUser)}`);
  }
  if (users.users.some((user) => Number(user.points || 0) >= 11 && user.id !== "smoke-user-primary")) {
    throw new Error(`unassigned device points leaked into a user aggregate: ${JSON.stringify(users.users)}`);
  }
  await api(mf, "/v1/contacts/sync", {
    method: "POST",
    body: JSON.stringify({
      deviceId: "ack-read-device",
      contacts: [
        { name: "Shared From Ack Device", jid: "shared-contact@s.whatsapp.net" },
        { name: "Ack Only", jid: "ack-only@s.whatsapp.net" },
      ],
    }),
  }, "device");
  await api(mf, "/v1/contacts/sync", {
    method: "POST",
    body: JSON.stringify({
      deviceId: "user-second-device",
      contacts: [
        { name: "Shared From Second Device", jid: "shared-contact@s.whatsapp.net" },
        { name: "Second Only", jid: "second-only@s.whatsapp.net" },
      ],
    }),
  }, "device");
  const contactsForAckDevice = await api(mf, "/v1/contacts?deviceId=ack-read-device", {}, "admin");
  if (
    contactsForAckDevice.contacts.length !== 2 ||
    !contactsForAckDevice.contacts.some((contact) => contact.wa_jid === "shared-contact@s.whatsapp.net" && contact.device_id === "ack-read-device") ||
    contactsForAckDevice.contacts.some((contact) => contact.device_id !== "ack-read-device")
  ) {
    throw new Error(`device contact ownership query returned wrong rows: ${JSON.stringify(contactsForAckDevice)}`);
  }
  const contactsForSecondDevice = await api(mf, "/v1/contacts?deviceId=user-second-device", {}, "admin");
  if (
    contactsForSecondDevice.contacts.length !== 2 ||
    !contactsForSecondDevice.contacts.some((contact) => contact.wa_jid === "shared-contact@s.whatsapp.net" && contact.device_id === "user-second-device") ||
    contactsForSecondDevice.contacts.some((contact) => contact.device_id !== "user-second-device")
  ) {
    throw new Error(`second device contact ownership query returned wrong rows: ${JSON.stringify(contactsForSecondDevice)}`);
  }
  const contactsForUser = await api(mf, "/v1/contacts?userId=smoke-user-primary", {}, "admin");
  const sharedRowsForUser = contactsForUser.contacts.filter((contact) => contact.wa_jid === "shared-contact@s.whatsapp.net");
  if (
    sharedRowsForUser.length !== 2 ||
    !sharedRowsForUser.some((contact) => contact.device_id === "ack-read-device") ||
    !sharedRowsForUser.some((contact) => contact.device_id === "user-second-device")
  ) {
    throw new Error(`user contact ownership query should include shared jid once per device: ${JSON.stringify(contactsForUser)}`);
  }
  await expectStatus(mf, "contacts query rejects ambiguous owner filters", "/v1/contacts?deviceId=ack-read-device&userId=smoke-user-primary", {
    method: "GET",
  }, "admin", [400]);
  const ledgerIdentity = await db.prepare(
    "SELECT user_id FROM ledger_entries WHERE task_id = ? AND entry_type = 'read_reward'",
  ).bind(ackTask.id).first();
  if (ledgerIdentity?.user_id !== "ack-read-device") {
    throw new Error(`ledger user_id should remain device id, not assigned user id: ${JSON.stringify(ledgerIdentity)}`);
  }

  const state = await mf.getKVNamespace("STATE");
  const stateKeys = await state.list();
  if (stateKeys.keys.length !== 0) {
    throw new Error(`STATE KV should not be written on hot paths, found keys: ${stateKeys.keys.map((key) => key.name).join(", ")}`);
  }

  console.log(JSON.stringify({
    ok: true,
    pausedDevice: pausedPull.safetyStatus,
    longRetryPaused: longRetryPull.paused,
    expiredTaskId: expiredPull.tasks[0].id,
    readyTaskId: readyPull.tasks[0].id,
    requeuedTaskId: requeueTaskId,
    staleClaimReleasedTaskId: requeueTaskId,
    ackReadTaskId: ackTask.id,
    stateKvKeys: stateKeys.keys.length,
  }, null, 2));
} finally {
  await mf.dispose();
  await unlink(bundledScriptPath).catch(() => {});
}
