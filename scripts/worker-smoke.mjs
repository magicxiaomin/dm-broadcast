const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const deviceId = process.env.DM_DEVICE_ID || `api-acceptance-${Date.now()}`;
const contactJid = process.env.DM_CONTACT_JID || "acceptance-device@s.whatsapp.net";
const adminToken = process.env.DM_ADMIN_TOKEN || "";
const deviceToken = process.env.DM_DEVICE_TOKEN || "";

function authHeaders(role) {
  const token = role === "device" ? deviceToken : adminToken;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function api(path, options = {}, role = "admin") {
  const res = await fetch(`${apiBase}${path}`, {
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

const created = await api("/v1/campaigns", {
  method: "POST",
  body: JSON.stringify({
    title: "Worker smoke acceptance",
    message: "worker smoke message",
    deviceId,
    points: 1,
    contacts: [{ name: "smoke", jid: contactJid }],
  }),
}, "admin");

const pulled = await api(`/v1/tasks/pull?deviceId=${encodeURIComponent(deviceId)}&limit=1`, {}, "device");
if (!pulled.tasks?.length) {
  throw new Error("expected one pulled task");
}
const task = pulled.tasks[0];
const serverMsgId = `worker-smoke-${Date.now()}`;

await api("/v1/events", {
  method: "POST",
  body: JSON.stringify({
    taskId: task.id,
    deviceId,
    clientMsgId: task.clientMsgId,
    eventType: "message_sent",
    payload: { source: "worker-smoke", server_msg_id: serverMsgId },
  }),
}, "device");

const acked = await api("/v1/events", {
  method: "POST",
  body: JSON.stringify({
    deviceId,
    eventType: "message_ack",
    payload: { source: "worker-smoke", server_msg_id: serverMsgId, ack_level: 2 },
  }),
}, "device");

if (acked.taskId !== task.id) {
  throw new Error(`ack did not correlate by server_msg_id: expected ${task.id}, got ${acked.taskId}`);
}

const dashboard = await api("/v1/dashboard", {}, "admin");
const verified = dashboard.tasks.find((item) => item.id === task.id);
if (!verified) {
  throw new Error(`task not found in dashboard: ${task.id}`);
}
if (verified.status !== "read") {
  throw new Error(`task did not reach read state: ${task.id}, status=${verified.status}`);
}
if (!verified.acked_at || !verified.read_at) {
  throw new Error(`task missing ack/read timestamps: ${JSON.stringify(verified)}`);
}

const ledgerRows = (dashboard.ledger || []).filter((item) => item.task_id === task.id && item.entry_type === "read_reward");
if (ledgerRows.length !== 1) {
  throw new Error(`expected exactly one read_reward ledger row, got ${ledgerRows.length}`);
}

console.log(JSON.stringify({
  ok: true,
  apiBase,
  campaignId: created.campaignId || created.campaign?.id,
  taskId: task.id,
  status: verified.status,
  ackCorrelated: true,
  serverMsgId,
  ledgerRows: ledgerRows.length,
}, null, 2));
