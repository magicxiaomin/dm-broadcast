const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const deviceId = process.env.DM_DEVICE_ID || await findDefaultDeviceId();
const contactJid = process.env.DM_REAL_CONTACT_JID;
const contactName = process.env.DM_REAL_CONTACT_NAME || "小号 +85255804693";
const message = process.env.DM_REAL_MESSAGE || `dm-broadcast MVP E2E ${new Date().toISOString()}`;
const points = Number(process.env.DM_REAL_POINTS || "5");
const timeoutMs = Number(process.env.DM_E2E_TIMEOUT_MS || "180000");
const injectRead = process.env.DM_INJECT_READ === "1";
const ignoreDeviceSafety = process.env.DM_IGNORE_DEVICE_SAFETY === "1";

if (!contactJid) {
  console.error("DM_REAL_CONTACT_JID is required. Refusing to create a real IM task without an explicit recipient JID.");
  process.exit(2);
}

if (!contactJid.includes("@")) {
  console.error(`DM_REAL_CONTACT_JID must be a full JID, got: ${contactJid}`);
  process.exit(2);
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findDefaultDeviceId() {
  const devices = await api("/v1/devices");
  const rows = devices.devices || [];
  const accountScoped = rows.filter((item) => String(item.id || "").startsWith("android-wa-"));
  const ready = accountScoped.find((item) => {
    const status = String(item.status || "");
    const safetyStatus = String(item.safety_status || "");
    const retryAfterSeconds = Number(item.safety_retry_after_seconds || 0);
    return status === "online" && retryAfterSeconds === 0 && !["risk_stopped", "cooling_down"].includes(safetyStatus);
  });
  return String((ready || accountScoped[0])?.id || "android-prototype");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findTask(taskId) {
  const dashboard = await api("/v1/dashboard");
  return {
    dashboard,
    task: (dashboard.tasks || []).find((item) => item.id === taskId),
    events: (dashboard.events || []).filter((item) => item.task_id === taskId),
    ledger: (dashboard.ledger || []).filter((item) => item.task_id === taskId),
  };
}

async function assertDeviceCanSend() {
  if (ignoreDeviceSafety) return;
  const devices = await api("/v1/devices");
  const device = (devices.devices || []).find((item) => item.id === deviceId);
  if (!device) return;

  const status = String(device.status || "");
  const safetyStatus = String(device.safety_status || "");
  const retryAfterSeconds = Number(device.safety_retry_after_seconds || 0);
  const safety = parseSafetyJson(device.safety_json);
  const bridgeState = String(safety?.state || "");
  const blocked = ["risk_stopped", "cooldown", "cooling_down"].includes(status)
    || safetyStatus === "risk_stopped"
    || retryAfterSeconds > 0
    || (bridgeState !== "" && bridgeState !== "connected");

  if (blocked) {
    console.error(JSON.stringify({
      ok: false,
      reason: "device_safety_blocked",
      deviceId,
      status,
      safetyStatus,
      bridgeState,
      retryAfterSeconds,
      message: "Refusing to create a real IM task while the Android device is blocked by SDK safety.",
    }, null, 2));
    process.exit(3);
  }
}

function parseSafetyJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

await assertDeviceCanSend();

console.log(JSON.stringify({
  step: "create",
  apiBase,
  deviceId,
  contactName,
  contactJid,
  injectRead,
}, null, 2));

const created = await api("/v1/campaigns", {
  method: "POST",
  body: JSON.stringify({
    title: "Real Android E2E",
    message,
    deviceId,
    points,
    contacts: [{ name: contactName, jid: contactJid }],
  }),
});

let taskId = null;
const createdCampaignId = created.campaignId || created.campaign?.id;
const started = Date.now();
while (Date.now() - started < 15000) {
  const dashboard = await api("/v1/dashboard");
  const task = (dashboard.tasks || []).find((item) => item.campaign_id === createdCampaignId && item.contact_jid === contactJid);
  if (task) {
    taskId = task.id;
    break;
  }
  await sleep(1000);
}

if (!taskId) {
  throw new Error(`created campaign ${createdCampaignId}, but task did not appear in dashboard`);
}

console.log(JSON.stringify({ step: "created", campaignId: createdCampaignId, taskId }, null, 2));

const end = Date.now() + timeoutMs;
let lastStatus = "";
while (Date.now() < end) {
  const { task, events, ledger } = await findTask(taskId);
  if (!task) throw new Error(`task disappeared: ${taskId}`);

  if (task.status !== lastStatus) {
    lastStatus = task.status;
    console.log(JSON.stringify({
      step: "status",
      taskId,
      status: task.status,
      sentAt: task.sent_at,
      readAt: task.read_at,
      events: events.map((event) => event.event_type),
      ledgerPoints: ledger.reduce((sum, entry) => sum + Number(entry.points || 0), 0),
    }, null, 2));
  }

  if (task.status === "sent" && injectRead) {
    await api("/v1/events", {
      method: "POST",
      body: JSON.stringify({
        taskId,
        deviceId,
        clientMsgId: `dm-${taskId}`,
        eventType: "read",
        payload: { source: "real-e2e-injected-read" },
      }),
    });
  }

  if (task.status === "read") {
    console.log(JSON.stringify({
      ok: true,
      campaignId: createdCampaignId,
      taskId,
      status: task.status,
      ledgerRows: ledger.length,
    }, null, 2));
    process.exit(0);
  }

  if (task.status === "failed") {
    throw new Error(`Android send failed: ${task.error || "unknown error"}`);
  }

  await sleep(3000);
}

const { task, events, ledger } = await findTask(taskId);
console.error(JSON.stringify({
  ok: false,
  reason: "timeout",
  task,
  events,
  ledger,
}, null, 2));
process.exit(1);
