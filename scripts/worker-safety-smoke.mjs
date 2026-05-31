import { readFile, unlink } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const scriptPath = new URL("../apps/worker/src/index.ts", import.meta.url).pathname;
const schemaPath = new URL("../apps/worker/migrations/0001_initial.sql", import.meta.url).pathname;
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
  const schema = await readFile(schemaPath, "utf8");
  for (const statement of schema.split(";").map((item) => item.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
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
  await expectStatus(mf, "device token cannot call admin route", "/v1/campaigns", {
    method: "POST",
    body: JSON.stringify({ title: "blocked", message: "blocked", contacts: [] }),
  }, "device", [401, 403]);

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

  console.log(JSON.stringify({
    ok: true,
    pausedDevice: pausedPull.safetyStatus,
    longRetryPaused: longRetryPull.paused,
    expiredTaskId: expiredPull.tasks[0].id,
    readyTaskId: readyPull.tasks[0].id,
    requeuedTaskId: requeueTaskId,
    staleClaimReleasedTaskId: requeueTaskId,
    ackReadTaskId: ackTask.id,
  }, null, 2));
} finally {
  await mf.dispose();
  await unlink(bundledScriptPath).catch(() => {});
}
