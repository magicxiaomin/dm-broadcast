const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const idSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const deviceId = process.env.DM_ONLINE_SAFETY_DEVICE_ID || `online-safety-${idSuffix}`;
const contactJid = `${deviceId}@s.whatsapp.net`;
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

await api("/v1/devices/register", {
  method: "POST",
  body: JSON.stringify({
    id: deviceId,
    deviceName: deviceId,
    status: "online",
    safety: {
      risk_stopped: true,
      risk_retry_after_seconds: 3600,
      risk_reason: "online-safety-smoke",
    },
  }),
}, "device");

const created = await api("/v1/campaigns", {
  method: "POST",
  body: JSON.stringify({
    title: "Online safety smoke",
    message: "this task must stay pending while device is risk-stopped",
    deviceId,
    points: 1,
    contacts: [{ name: "online safety", jid: contactJid }],
  }),
}, "admin");

const pull = await api(`/v1/tasks/pull?deviceId=${encodeURIComponent(deviceId)}&limit=1`, {}, "device");
if (!pull.paused || pull.tasks.length !== 0) {
  throw new Error(`risk-stopped online device should not receive tasks: ${JSON.stringify(pull)}`);
}

const tasks = await api("/v1/tasks?status=pending&limit=200", {}, "admin");
const pendingTask = (tasks.tasks || []).find((task) => task.campaign_id === created.campaignId && task.device_id === deviceId);
if (!pendingTask) {
  throw new Error(`created safety task was not left pending for ${deviceId}`);
}

await api("/v1/events", {
  method: "POST",
  body: JSON.stringify({
    taskId: pendingTask.id,
    deviceId,
    clientMsgId: `dm-${pendingTask.id}`,
    eventType: "message_failed",
    payload: {
      source: "worker-online-safety-smoke",
      reason: "cleanup_after_pending_assertion",
    },
  }),
}, "device");

const afterCleanup = await api("/v1/tasks?status=failed&limit=200", {}, "admin");
const failedTask = (afterCleanup.tasks || []).find((task) => task.id === pendingTask.id);
if (!failedTask) {
  throw new Error(`safety smoke cleanup did not mark task failed: ${pendingTask.id}`);
}

console.log(JSON.stringify({
  ok: true,
  apiBase,
  deviceId,
  campaignId: created.campaignId,
  taskId: pendingTask.id,
  cleanupStatus: failedTask.status,
  pull,
}, null, 2));
