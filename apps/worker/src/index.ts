export interface Env {
  DB: D1Database;
  STATE: KVNamespace;
  ADMIN_TOKEN?: string;
  DEVICE_TOKEN?: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

let deviceSafetyColumnsReady = false;
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

const jsonHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...init.headers,
    },
  });
}

function badRequest(message: string) {
  return json({ ok: false, error: "bad_request", message }, { status: 400 });
}

function unauthorized() {
  return json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function forbidden() {
  return json({ ok: false, error: "forbidden" }, { status: 403 });
}

function notFound() {
  return json({ ok: false, error: "not_found" }, { status: 404 });
}

type AuthRole = "admin" | "device";

function bearerToken(request: Request) {
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

function authRole(request: Request, env: Env): AuthRole | null {
  const token = bearerToken(request);
  if (!token) return null;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return "admin";
  if (env.DEVICE_TOKEN && token === env.DEVICE_TOKEN) return "device";
  return null;
}

function requireAuth(request: Request, env: Env, allowed: AuthRole[]) {
  const role = authRole(request, env);
  if (!role) return unauthorized();
  return allowed.includes(role) ? null : forbidden();
}

function nowMs() {
  return Date.now();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parsePayload(value: unknown): string {
  if (value == null) return "{}";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safetyState(value: unknown) {
  const safety = asRecord(value);
  const riskWait = Number(safety.risk_retry_after_seconds || 0);
  const sendWait = Number(safety.send_retry_after_seconds || 0);
  const operationWait = Number(safety.operation_retry_after_seconds || 0);
  const retryAfterSeconds = Math.max(0, riskWait, sendWait, operationWait);
  const riskStopped = safety.risk_stopped === true;
  const connectionState = String(safety.state || "");
  const connecting = connectionState && connectionState !== "connected";
  const status = riskStopped ? "risk_stopped" : retryAfterSeconds > 0 || connecting ? "cooling_down" : "ready";
  return {
    status,
    retryAfterSeconds,
    payloadJson: parsePayload(safety),
  };
}

function deviceBlocksPull(
  device: {
    status?: string | null;
    safety_status?: string | null;
    safety_retry_after_seconds?: number | null;
    safety_updated_at?: number | null;
  } | null,
  now: number,
) {
  if (!device) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(0, Number(device.safety_retry_after_seconds || 0));
  const safetyUpdatedAt = Number(device.safety_updated_at || 0);
  const safetyAgeMs = now - safetyUpdatedAt;
  const hasRecentSafety = Boolean(safetyUpdatedAt) && safetyAgeMs < 2 * 60 * 1000;
  const retryWindowOpen = Boolean(safetyUpdatedAt) && retryAfterSeconds > 0 && now < safetyUpdatedAt + retryAfterSeconds * 1000;
  const blockingStatus = device.status === "risk_stopped" || device.status === "cooldown" || device.status === "cooling_down";
  const blockingSafety =
    retryWindowOpen ||
    (hasRecentSafety && (device.safety_status === "risk_stopped" || device.safety_status === "cooling_down"));

  return { blocked: blockingStatus || blockingSafety, retryAfterSeconds };
}

async function readJson<T>(request: Request): Promise<T> {
  return request.json<T>();
}

async function ensureDeviceSafetyColumns(env: Env) {
  if (deviceSafetyColumnsReady) return;
  const columns = await env.DB.prepare("PRAGMA table_info(devices)").all<{ name: string }>();
  const existing = new Set((columns.results ?? []).map((column) => column.name));
  const statements = [
    ["safety_status", "ALTER TABLE devices ADD COLUMN safety_status TEXT"],
    ["safety_retry_after_seconds", "ALTER TABLE devices ADD COLUMN safety_retry_after_seconds INTEGER NOT NULL DEFAULT 0"],
    ["safety_json", "ALTER TABLE devices ADD COLUMN safety_json TEXT"],
    ["safety_updated_at", "ALTER TABLE devices ADD COLUMN safety_updated_at INTEGER"],
  ]
    .filter(([name]) => !existing.has(name))
    .map(([, sql]) => env.DB.prepare(sql));
  if (statements.length) {
    await env.DB.batch(statements);
  }
  deviceSafetyColumnsReady = true;
}

async function health(env: Env) {
  const [devices, pending, sent, read, ledger] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM devices").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('pending','claimed')").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'sent'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'read'").first<{ count: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS points FROM ledger_entries").first<{ points: number }>(),
  ]);

  return json({
    ok: true,
    service: "dm-broadcast-api",
    storage: { d1: "ok", kv: "ok" },
    summary: {
      devices: devices?.count ?? 0,
      pending: pending?.count ?? 0,
      sent: sent?.count ?? 0,
      read: read?.count ?? 0,
      points: ledger?.points ?? 0,
    },
    freeTierGuard: {
      queueEnabled: false,
      note: "MVP uses D1-backed task polling; Cloudflare Queue is intentionally disabled.",
    },
  });
}

async function dashboard(env: Env) {
  await ensureDeviceSafetyColumns(env);
  const [summary, tasksByStatus, devices, campaigns, tasks, events, ledger] = await Promise.all([
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM devices) AS devices,
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COALESCE(SUM(points), 0) FROM ledger_entries) AS points`,
    ).first(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status").all(),
    env.DB.prepare("SELECT * FROM devices ORDER BY updated_at DESC LIMIT 20").all(),
    env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 20").all(),
    env.DB.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM im_events ORDER BY created_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 100").all(),
  ]);

  return json({
    ok: true,
    summary: { ...(summary ?? {}), tasksByStatus: tasksByStatus.results ?? [] },
    devices: devices.results ?? [],
    campaigns: campaigns.results ?? [],
    tasks: tasks.results ?? [],
    events: events.results ?? [],
    ledger: ledger.results ?? [],
  });
}

async function registerDevice(request: Request, env: Env) {
  await ensureDeviceSafetyColumns(env);
  const body = await readJson<{
    id?: string;
    deviceName?: string;
    waJid?: string;
    status?: string;
    safety?: unknown;
  }>(request);
  const deviceId = body.id || id("dev");
  const now = nowMs();
  const safety = body.safety == null ? null : safetyState(body.safety);
  await env.DB.prepare(
    `INSERT INTO devices (
       id, device_name, wa_jid, status, last_seen_at, safety_status,
       safety_retry_after_seconds, safety_json, safety_updated_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       device_name = excluded.device_name,
       wa_jid = excluded.wa_jid,
       status = excluded.status,
       safety_status = COALESCE(excluded.safety_status, devices.safety_status),
       safety_retry_after_seconds = COALESCE(excluded.safety_retry_after_seconds, devices.safety_retry_after_seconds),
       safety_json = COALESCE(excluded.safety_json, devices.safety_json),
       safety_updated_at = COALESCE(excluded.safety_updated_at, devices.safety_updated_at),
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      deviceId,
      body.deviceName || "android-prototype",
      body.waJid || null,
      body.status || "online",
      now,
      safety?.status ?? null,
      safety?.retryAfterSeconds ?? null,
      safety?.payloadJson ?? null,
      safety ? now : null,
      now,
      now,
    )
    .run();

  return json({ ok: true, id: deviceId });
}

async function listDevices(env: Env) {
  await ensureDeviceSafetyColumns(env);
  const rows = await env.DB.prepare("SELECT * FROM devices ORDER BY updated_at DESC").all();
  return json({ ok: true, devices: rows.results ?? [] });
}

async function syncContacts(request: Request, env: Env) {
  const body = await readJson<{
    contacts?: Array<{ jid?: string; name?: string }>;
  }>(request);
  const contacts = body.contacts || [];
  const now = nowMs();
  const statements = contacts
    .filter((contact) => (contact.jid || "").trim())
    .map((contact) => {
      const jid = (contact.jid || "").trim();
      return env.DB.prepare(
        `INSERT INTO contacts (id, wa_jid, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wa_jid) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, contacts.display_name),
           updated_at = excluded.updated_at`,
      ).bind(`contact_${jid}`, jid, contact.name || null, now, now);
    });

  if (statements.length) {
    await env.DB.batch(statements);
  }

  return json({ ok: true, synced: statements.length });
}

async function listContacts(env: Env) {
  const rows = await env.DB.prepare("SELECT * FROM contacts ORDER BY updated_at DESC LIMIT 500").all();
  return json({ ok: true, contacts: rows.results ?? [] });
}

async function createCampaign(request: Request, env: Env) {
  const body = await readJson<{
    title?: string;
    message?: string;
    contacts?: Array<string | { jid?: string; name?: string }>;
    deviceId?: string;
    points?: number;
  }>(request);
  const title = (body.title || "").trim();
  const message = (body.message || "").trim();
  const contacts = body.contacts || [];
  const points = Number.isFinite(body.points) ? Math.max(0, Math.floor(body.points || 0)) : 1;
  const deviceId = (body.deviceId || "").trim();

  if (!title) return badRequest("title is required");
  if (!message) return badRequest("message is required");
  if (!contacts.length) return badRequest("contacts is required");
  if (!deviceId) return badRequest("deviceId is required");

  const campaignId = id("camp");
  const now = nowMs();
  await registerSyntheticHeartbeat(env, deviceId, now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO campaigns (id, title, message_template, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).bind(campaignId, title, message, now, now),
    ...contacts.map((contact) => {
      const jid = typeof contact === "string" ? contact.trim() : (contact.jid || "").trim();
      const displayName = typeof contact === "string" ? null : contact.name || null;
      if (!jid) throw new Error("contact jid is required");
      const contactId = `contact_${jid}`;
      return env.DB.prepare(
        `INSERT INTO contacts (id, wa_jid, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wa_jid) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, contacts.display_name),
           updated_at = excluded.updated_at`,
      ).bind(contactId, jid, displayName, now, now);
    }),
    ...contacts.map((contact) => {
      const jid = typeof contact === "string" ? contact.trim() : (contact.jid || "").trim();
      return env.DB.prepare(
        `INSERT INTO tasks (id, campaign_id, contact_jid, device_id, status, points, payload_json, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).bind(
        id("task"),
        campaignId,
        jid,
        deviceId,
        points,
        JSON.stringify({ text: message, title }),
        now,
        now,
        now,
      );
    }),
  ]);

  return json({
    ok: true,
    campaignId,
    taskCount: contacts.length,
    campaign: { id: campaignId, taskCount: contacts.length },
  });
}

async function listCampaigns(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT c.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status = 'read' THEN 1 ELSE 0 END) AS read_count,
      SUM(CASE WHEN t.status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM campaigns c
     LEFT JOIN tasks t ON t.campaign_id = c.id
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
  ).all();
  return json({ ok: true, campaigns: rows.results ?? [] });
}

async function listTasks(request: Request, env: Env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const campaignId = url.searchParams.get("campaignId");
  const limit = Math.min(Number(url.searchParams.get("limit") || "100"), 200);
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];
  if (status) {
    clauses.push("status = ?");
    bindings.push(status);
  }
  if (campaignId) {
    clauses.push("campaign_id = ?");
    bindings.push(campaignId);
  }
  bindings.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await env.DB.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).bind(...bindings).all();
  return json({ ok: true, tasks: rows.results ?? [] });
}

async function pullTasks(request: Request, env: Env) {
  await ensureDeviceSafetyColumns(env);
  const url = new URL(request.url);
  const deviceId = (url.searchParams.get("deviceId") || "").trim();
  if (!deviceId) return badRequest("deviceId is required");
  const limit = Math.min(Number(url.searchParams.get("limit") || "5"), 10);
  const now = nowMs();

  const device = await env.DB.prepare(
    "SELECT status, safety_status, safety_retry_after_seconds, safety_updated_at FROM devices WHERE id = ?",
  ).bind(deviceId).first<{
    status: string | null;
    safety_status: string | null;
    safety_retry_after_seconds: number | null;
    safety_updated_at: number | null;
  }>();
  const safety = deviceBlocksPull(device, now);
  if (safety.blocked) {
    await touchDevice(env, deviceId, now);
    return json({
      ok: true,
      tasks: [],
      paused: true,
      reason: "device_safety",
      status: device?.status || "unknown",
      safetyStatus: device?.safety_status || "unknown",
      retryAfterSeconds: safety.retryAfterSeconds,
    });
  }

  await registerSyntheticHeartbeat(env, deviceId, now);
  await releaseStaleClaims(env, now);

  const rows = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE status = 'pending'
       AND device_id = ?
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(deviceId, limit).all<Record<string, unknown>>();

  const tasks = rows.results ?? [];
  if (tasks.length) {
    await env.DB.batch(
      tasks.map((task) =>
        env.DB.prepare(
          `UPDATE tasks
           SET status = 'claimed', device_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).bind(deviceId, now, task.id),
      ),
    );
  }

  return json({
    ok: true,
    tasks: tasks.map((task) => {
      const payload = safeJson(String(task.payload_json || "{}"));
      return {
        id: task.id,
        campaignId: task.campaign_id,
        contactJid: task.contact_jid,
        deviceId,
        text: typeof payload.text === "string" ? payload.text : "",
        points: task.points,
        clientMsgId: `dm-${task.id}`,
      };
    }),
  });
}

async function releaseStaleClaims(env: Env, now: number) {
  const cutoff = now - CLAIM_TIMEOUT_MS;
  const stale = await env.DB.prepare(
    "SELECT id, device_id, updated_at FROM tasks WHERE status = 'claimed' AND updated_at < ? ORDER BY updated_at ASC LIMIT 25",
  ).bind(cutoff).all<{
    id: string;
    device_id: string | null;
    updated_at: number;
  }>();
  const tasks = stale.results ?? [];
  if (!tasks.length) return;

  await env.DB.batch(
    tasks.flatMap((task) => [
      env.DB.prepare(
        `UPDATE tasks
         SET status = 'pending', error = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed'`,
      ).bind(now, task.id),
      env.DB.prepare(
        `INSERT INTO im_events (id, task_id, event_type, payload_json, created_at)
         VALUES (?, ?, 'task_claim_expired', ?, ?)`,
      ).bind(
        id("evt"),
        task.id,
        parsePayload({ deviceId: task.device_id, claimedUpdatedAt: task.updated_at, timeoutMs: CLAIM_TIMEOUT_MS }),
        now,
      ),
    ]),
  );
}

async function registerSyntheticHeartbeat(env: Env, deviceId: string, now: number) {
  await ensureDeviceSafetyColumns(env);
  await env.DB.prepare(
    `INSERT INTO devices (id, device_name, status, last_seen_at, created_at, updated_at)
     VALUES (?, ?, 'online', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = CASE
         WHEN devices.status IN ('risk_stopped', 'cooldown', 'cooling_down') THEN devices.status
         ELSE 'online'
       END,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
  ).bind(deviceId, deviceId, now, now, now).run();
}

async function touchDevice(env: Env, deviceId: string, now: number) {
  await env.DB.prepare(
    `UPDATE devices
     SET last_seen_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now, now, deviceId).run();
}

function safeJson(value: string): Record<string, Json> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function payloadString(payload: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function findTaskIdByServerMsgId(env: Env, serverMsgId: string) {
  if (!serverMsgId) return "";
  const row = await env.DB.prepare(
    `SELECT task_id
     FROM im_events
     WHERE task_id IS NOT NULL
       AND event_type IN ('message_sent', 'sent')
       AND json_extract(payload_json, '$.server_msg_id') = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(serverMsgId).first<{ task_id: string | null }>();
  return row?.task_id || "";
}

async function recordEvent(request: Request, env: Env) {
  const body = await readJson<{
    taskId?: string;
    clientMsgId?: string;
    eventType?: string;
    deviceId?: string;
    serverMsgId?: string;
    payload?: unknown;
  }>(request);
  const eventType = (body.eventType || "unknown").trim();
  const payload = asRecord(body.payload);
  const clientMsgId = body.clientMsgId || payloadString(payload, "clientMsgId", "client_msg_id");
  const serverMsgId = body.serverMsgId || payloadString(payload, "serverMsgId", "server_msg_id");
  const taskId =
    body.taskId ||
    inferTaskId(clientMsgId) ||
    await findTaskIdByServerMsgId(env, serverMsgId);
  const now = nowMs();
  await env.DB.prepare(
    `INSERT INTO im_events (id, task_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id("evt"), taskId || null, eventType, parsePayload(body.payload ?? body), now).run();

  if (taskId) {
    await applyTaskEvent(env, taskId, eventType, now, { ...body, clientMsgId, serverMsgId });
  }

  return json({ ok: true, taskId, eventType });
}

async function requeueTask(request: Request, env: Env) {
  const body = await readJson<{ taskId?: string; reason?: string }>(request);
  const taskId = (body.taskId || "").trim();
  if (!taskId) return badRequest("taskId is required");

  const task = await env.DB.prepare("SELECT id, status FROM tasks WHERE id = ?").bind(taskId).first<{
    id: string;
    status: string;
  }>();
  if (!task) return notFound();
  if (task.status !== "failed" && task.status !== "claimed") {
    return badRequest(`only failed or claimed tasks can be requeued, got ${task.status}`);
  }

  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks
       SET status = 'pending',
           sent_at = NULL,
           read_at = NULL,
           acked_at = NULL,
           error = NULL,
           updated_at = ?
       WHERE id = ?`,
    ).bind(now, taskId),
    env.DB.prepare(
      `INSERT INTO im_events (id, task_id, event_type, payload_json, created_at)
       VALUES (?, ?, 'task_requeued', ?, ?)`,
    ).bind(id("evt"), taskId, parsePayload({ fromStatus: task.status, reason: body.reason || "operator_requeue" }), now),
  ]);

  return json({ ok: true, taskId, status: "pending", previousStatus: task.status });
}

function inferTaskId(clientMsgId: string) {
  return clientMsgId.startsWith("dm-task_") ? clientMsgId.slice(3) : "";
}

async function applyTaskEvent(
  env: Env,
  taskId: string,
  eventType: string,
  now: number,
  body: { deviceId?: string; clientMsgId?: string; serverMsgId?: string; payload?: unknown },
) {
  const normalized = eventType.toLowerCase();
  if (normalized === "message_sent" || normalized === "sent") {
    await env.DB.prepare(
      `UPDATE tasks
       SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ?, error = NULL
       WHERE id = ?`,
    ).bind(now, now, taskId).run();
    return;
  }

  if (normalized === "message_failed" || normalized === "failed") {
    await env.DB.prepare(
      `UPDATE tasks
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(parsePayload(body.payload ?? body), now, taskId).run();
    return;
  }

  if (normalized === "message_ack" || normalized === "ack") {
    const payload = asRecord(body.payload);
    const ackLevel = Number(payload.ack_level ?? payload.ackLevel ?? 0);
    await env.DB.prepare(
      `UPDATE tasks
       SET acked_at = COALESCE(acked_at, ?), updated_at = ?
       WHERE id = ?`,
    ).bind(now, now, taskId).run();

    if (ackLevel >= 2) {
      await markTaskReadAndReward(env, taskId, eventType, now, body);
    }
    return;
  }

  if (normalized === "read" || normalized === "message_read" || normalized === "receipt_read" || normalized === "read_receipt") {
    await markTaskReadAndReward(env, taskId, eventType, now, body);
  }
}

async function markTaskReadAndReward(
  env: Env,
  taskId: string,
  eventType: string,
  now: number,
  body: { deviceId?: string; payload?: unknown },
) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<{
    id: string;
    status: string;
    points: number;
    device_id: string | null;
  }>();
  if (!task) return;

  await env.DB.prepare(
    `UPDATE tasks
     SET status = 'read', read_at = COALESCE(read_at, ?), updated_at = ?
     WHERE id = ?`,
  ).bind(now, now, taskId).run();

  const userId = body.deviceId || task.device_id || "android-prototype";
  await env.DB.prepare(
    `INSERT INTO ledger_entries (id, user_id, task_id, entry_type, points, metadata_json, created_at)
     SELECT ?, ?, ?, 'read_reward', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM ledger_entries WHERE task_id = ? AND entry_type = 'read_reward'
     )`,
  ).bind(
    id("ledger"),
    userId,
    taskId,
    task.points || 0,
    parsePayload({ source: "im_event", eventType }),
    now,
    taskId,
  ).run();
}

async function listLedger(env: Env) {
  const entries = await env.DB.prepare("SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 100").all();
  const totals = await env.DB.prepare(
    `SELECT user_id, COALESCE(SUM(points), 0) AS points, COUNT(*) AS entries
     FROM ledger_entries
     GROUP BY user_id
     ORDER BY points DESC`,
  ).all();
  return json({ ok: true, totals: totals.results ?? [], entries: entries.results ?? [] });
}

async function cleanupTestData(request: Request, env: Env) {
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const taskWhere = `
    t.device_id LIKE 'api-acceptance-%'
    OR t.device_id LIKE 'online-safety-%'
    OR t.device_id LIKE 'online-long-retry-%'
    OR t.device_id LIKE 'safety-gate-%'
    OR t.device_id LIKE 'smoke-device-%'
    OR t.contact_jid = 'acceptance-device@s.whatsapp.net'
    OR t.contact_jid = 'acceptance-contact@s.whatsapp.net'
    OR t.contact_jid LIKE 'online-safety-%@s.whatsapp.net'
    OR t.contact_jid LIKE 'online-long-retry-%@s.whatsapp.net'
    OR t.contact_jid LIKE 'safety-gate-%@s.whatsapp.net'
    OR t.contact_jid LIKE 'smoke-%@s.whatsapp.net'
    OR t.payload_json LIKE '%worker-smoke%'
    OR c.title = 'Worker smoke acceptance'
    OR c.title = 'Online safety smoke'
    OR c.title = 'Online long retry safety smoke'
    OR c.title = 'safety gate'
    OR c.title LIKE 'smoke %'
    OR c.title = 'Android poll acceptance'
    OR c.title = 'Unknown device acceptance'
    OR c.title = 'API acceptance'
  `;
  const counts = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere}`).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM im_events
       WHERE task_id IN (SELECT t.id FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere})
          OR payload_json LIKE '%worker-smoke%'
          OR payload_json LIKE '%worker-online-safety-smoke%'
          OR payload_json LIKE '%online-long-retry%'
          OR payload_json LIKE '%safety-gate%'
          OR payload_json LIKE '%smoke-device%'`,
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM ledger_entries
       WHERE task_id IN (SELECT t.id FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere})
          OR user_id LIKE 'api-acceptance-%'
          OR user_id LIKE 'online-safety-%'
          OR user_id LIKE 'online-long-retry-%'
          OR user_id LIKE 'safety-gate-%'
          OR user_id LIKE 'smoke-device-%'`,
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM devices
       WHERE id LIKE 'api-acceptance-%'
          OR id LIKE 'online-safety-%'
          OR id LIKE 'online-long-retry-%'
          OR id LIKE 'safety-gate-%'
          OR id LIKE 'smoke-device-%'`,
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM contacts
       WHERE wa_jid = 'acceptance-device@s.whatsapp.net'
          OR wa_jid = 'acceptance-contact@s.whatsapp.net'
          OR wa_jid LIKE 'online-safety-%@s.whatsapp.net'
          OR wa_jid LIKE 'online-long-retry-%@s.whatsapp.net'
          OR wa_jid LIKE 'safety-gate-%@s.whatsapp.net'
          OR wa_jid LIKE 'smoke-%@s.whatsapp.net'`,
    ).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM campaigns
       WHERE title = 'Worker smoke acceptance'
          OR title = 'Online safety smoke'
          OR title = 'Online long retry safety smoke'
          OR title = 'safety gate'
          OR title LIKE 'smoke %'
          OR title = 'Android poll acceptance'
          OR title = 'Unknown device acceptance'
          OR title = 'API acceptance'`,
    ).first<{ count: number }>(),
  ]);

  const before = {
    tasks: counts[0]?.count ?? 0,
    events: counts[1]?.count ?? 0,
    ledger: counts[2]?.count ?? 0,
    devices: counts[3]?.count ?? 0,
    contacts: counts[4]?.count ?? 0,
    campaigns: counts[5]?.count ?? 0,
  };

  if (!dryRun) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM ledger_entries
         WHERE task_id IN (SELECT t.id FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere})
            OR user_id LIKE 'api-acceptance-%'
            OR user_id LIKE 'online-safety-%'
            OR user_id LIKE 'online-long-retry-%'
            OR user_id LIKE 'safety-gate-%'
            OR user_id LIKE 'smoke-device-%'`,
      ),
      env.DB.prepare(
        `DELETE FROM im_events
         WHERE task_id IN (SELECT t.id FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere})
            OR payload_json LIKE '%worker-smoke%'
            OR payload_json LIKE '%worker-online-safety-smoke%'
            OR payload_json LIKE '%online-long-retry%'
            OR payload_json LIKE '%safety-gate%'
            OR payload_json LIKE '%smoke-device%'`,
      ),
      env.DB.prepare(`DELETE FROM tasks WHERE id IN (SELECT t.id FROM tasks t LEFT JOIN campaigns c ON c.id = t.campaign_id WHERE ${taskWhere})`),
      env.DB.prepare(
        `DELETE FROM contacts
         WHERE wa_jid = 'acceptance-device@s.whatsapp.net'
            OR wa_jid = 'acceptance-contact@s.whatsapp.net'
            OR wa_jid LIKE 'online-safety-%@s.whatsapp.net'
            OR wa_jid LIKE 'online-long-retry-%@s.whatsapp.net'
            OR wa_jid LIKE 'safety-gate-%@s.whatsapp.net'
            OR wa_jid LIKE 'smoke-%@s.whatsapp.net'`,
      ),
      env.DB.prepare(
        `DELETE FROM devices
         WHERE id LIKE 'api-acceptance-%'
            OR id LIKE 'online-safety-%'
            OR id LIKE 'online-long-retry-%'
            OR id LIKE 'safety-gate-%'
            OR id LIKE 'smoke-device-%'`,
      ),
      env.DB.prepare(
        `DELETE FROM campaigns
         WHERE title = 'Worker smoke acceptance'
            OR title = 'Online safety smoke'
            OR title = 'Online long retry safety smoke'
            OR title = 'safety gate'
            OR title LIKE 'smoke %'
            OR title = 'Android poll acceptance'
            OR title = 'Unknown device acceptance'
            OR title = 'API acceptance'`,
      ),
    ]);
  }

  return json({ ok: true, dryRun, deleted: dryRun ? null : before, matched: before });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: jsonHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") return health(env);
    if (request.method === "GET" && url.pathname === "/v1/dashboard") return requireAuth(request, env, ["admin"]) ?? dashboard(env);
    if (request.method === "GET" && url.pathname === "/v1/devices") return requireAuth(request, env, ["admin"]) ?? listDevices(env);
    if (request.method === "POST" && url.pathname === "/v1/devices/register") return requireAuth(request, env, ["device"]) ?? registerDevice(request, env);
    if (request.method === "GET" && url.pathname === "/v1/contacts") return requireAuth(request, env, ["admin"]) ?? listContacts(env);
    if (request.method === "POST" && url.pathname === "/v1/contacts/sync") return requireAuth(request, env, ["device"]) ?? syncContacts(request, env);
    if (request.method === "GET" && url.pathname === "/v1/campaigns") return requireAuth(request, env, ["admin"]) ?? listCampaigns(env);
    if (request.method === "POST" && url.pathname === "/v1/campaigns") return requireAuth(request, env, ["admin"]) ?? createCampaign(request, env);
    if (request.method === "GET" && url.pathname === "/v1/tasks") return requireAuth(request, env, ["admin"]) ?? listTasks(request, env);
    if (request.method === "GET" && url.pathname === "/v1/tasks/pull") return requireAuth(request, env, ["device"]) ?? pullTasks(request, env);
    if (request.method === "POST" && url.pathname === "/v1/tasks/requeue") return requireAuth(request, env, ["admin"]) ?? requeueTask(request, env);
    if (request.method === "POST" && url.pathname === "/v1/events") return requireAuth(request, env, ["device"]) ?? recordEvent(request, env);
    if (request.method === "GET" && url.pathname === "/v1/ledger") return requireAuth(request, env, ["admin"]) ?? listLedger(env);
    if (url.pathname.startsWith("/v1/admin/")) {
      if (request.method === "POST" && url.pathname === "/v1/admin/cleanup-test-data") {
        return requireAuth(request, env, ["admin"]) ?? cleanupTestData(request, env);
      }
      return requireAuth(request, env, ["admin"]) ?? notFound();
    }

    return notFound();
  },
};
