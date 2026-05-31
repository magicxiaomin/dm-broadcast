import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const adminToken = process.env.DM_ADMIN_TOKEN || "";
const adbBin = process.env.ADB_BIN || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adbSerial = process.env.DM_ADB_SERIAL || "";
const androidPackage = process.env.DM_ANDROID_PACKAGE || "com.magicxiaomin.dmbroadcast.device";
const deviceId = process.env.DM_DEVICE_ID || "";
const contactJid = process.env.DM_REAL_CONTACT_JID || "";
const contactName = process.env.DM_REAL_CONTACT_NAME || "小号 +85255804693";
const message = process.env.DM_REAL_MESSAGE || `dm-broadcast Android verify ${new Date().toISOString()}`;
const points = Number(process.env.DM_REAL_POINTS || "5");
const timeoutMs = Number(process.env.DM_ANDROID_VERIFY_TIMEOUT_MS || "180000");
const allowEmulator = process.env.DM_ALLOW_EMULATOR === "1";
const outputRoot = process.env.DM_ANDROID_VERIFY_OUTPUT_DIR || "outputs/android-device-verify";
const startedAt = new Date();
const outDir = join(outputRoot, startedAt.toISOString().replace(/[:.]/g, "-"));

const summary = {
  ok: false,
  status: "not_started",
  apiBase,
  androidPackage,
  outDir,
  startedAt: startedAt.toISOString(),
  screenshots: [],
};

await mkdir(outDir, { recursive: true });
process.once("uncaughtException", (error) => {
  void safeExit(1, "error", { message: error?.message || String(error) });
});
process.once("unhandledRejection", (error) => {
  void safeExit(1, "error", { message: error?.message || String(error) });
});

const adbDevices = await runText(adbBin, ["devices"], 8000);
if (!adbDevices.ok) {
  await safeExit(0, "no_device", {
    adbBin,
    message: "adb devices failed; no real IM task was created.",
    error: adbDevices.stderr || adbDevices.stdout,
  });
}

const selectedSerial = selectAdbSerial(parseAdbDevices(adbDevices.stdout));
if (!selectedSerial) {
  await safeExit(0, "no_device", {
    devices: parseAdbDevices(adbDevices.stdout),
    message: allowEmulator
      ? "No matching adb device is connected; no real IM task was created."
      : "No matching physical adb device is connected. Set DM_ALLOW_EMULATOR=1 only for local dry runs; no real IM task was created.",
  });
}
summary.adbSerial = selectedSerial;

if (!contactJid) {
  await safeExit(2, "missing_recipient", {
    message: "DM_REAL_CONTACT_JID is required. Refusing to create a real IM task without an explicit recipient JID.",
  });
}

if (!contactJid.includes("@")) {
  await safeExit(2, "invalid_recipient", {
    contactJid,
    message: "DM_REAL_CONTACT_JID must be a full JID, for example 85255804693@s.whatsapp.net.",
  });
}

if (!adminToken) {
  await safeExit(2, "missing_admin_token", {
    message: "Set DM_ADMIN_TOKEN before running android:verify; no real IM task was created.",
  });
}

const packageCheck = await adbText(["shell", "pm", "path", androidPackage], 8000);
if (!packageCheck.ok || !packageCheck.stdout.includes("package:")) {
  await safeExit(2, "app_not_installed", {
    message: `Android package ${androidPackage} is not installed; no real IM task was created.`,
    error: packageCheck.stderr || packageCheck.stdout,
  });
}

const scopedDeviceId = deviceId || await findDefaultDeviceId();
summary.deviceId = scopedDeviceId;
summary.contactJid = contactJid;
summary.contactName = contactName;

if (!scopedDeviceId.startsWith("android-wa-")) {
  await safeExit(2, "invalid_device_id", {
    deviceId: scopedDeviceId,
    message: "android:verify requires a logged-in account-scoped android-wa-* device; no real IM task was created.",
  });
}

await assertDeviceCanSend(scopedDeviceId);

await wakeAndUnlock();
await adbText(["shell", "am", "force-stop", androidPackage], 8000);
await adbText(["logcat", "-c"], 8000);
await launchApp();
await sleep(2000);
await screenshot("01-launched.png");

await tapText("连接 / 生成二维码");
await waitForLog(/IM connected|SELF .*"state":"connected"|DEVICE scoped id=/, 30000, "bridge_connected");
await tapText("读取身份");
await sleep(1500);
await tapText("启动轮询");
await sleep(1500);
await screenshot("02-polling.png");

const created = await api("/v1/campaigns", {
  method: "POST",
  body: JSON.stringify({
    title: "Android Device Verify",
    message,
    deviceId: scopedDeviceId,
    points,
    contacts: [{ name: contactName, jid: contactJid }],
  }),
});
summary.campaignId = created.campaignId || created.campaign?.id;
await screenshot("03-task-created.png");

const taskId = await waitForTask(summary.campaignId, contactJid);
summary.taskId = taskId;
console.log(JSON.stringify({ step: "created", campaignId: summary.campaignId, taskId, deviceId: scopedDeviceId }, null, 2));

const task = await waitForSend(taskId);
summary.finalTask = task;
await screenshot("04-final.png");

const logcatPath = await writeLogcatSnippet();
summary.logcat = logcatPath;

const logcatText = await readLogcatSnippet();
summary.logEvidence = {
  connected: /connected/i.test(logcatText),
  poll: /POLL/.test(logcatText),
  messageSendStart: /message_send_start/.test(logcatText),
  messageSent: /message_sent/.test(logcatText),
};

const missingEvidence = Object.entries(summary.logEvidence)
  .filter(([, present]) => !present)
  .map(([name]) => name);

if (missingEvidence.length > 0) {
  await safeExit(1, "missing_log_evidence", {
    message: `Task reached ${task.status}, but logcat evidence is missing: ${missingEvidence.join(", ")}`,
  });
}

await safeExit(0, "verified", {
  ok: true,
  message: "Android physical-device pull -> sendText verification completed.",
});

async function launchApp() {
  const resolved = await adbText(["shell", "cmd", "package", "resolve-activity", "--brief", androidPackage], 8000);
  if (resolved.ok) summary.resolvedActivity = resolved.stdout.trim();
  const result = await adbText(["shell", "monkey", "-p", androidPackage, "-c", "android.intent.category.LAUNCHER", "1"], 15000);
  if (!result.ok) {
    await safeExit(2, "launch_failed", {
      message: `Could not launch ${androidPackage}; no real IM task was created.`,
      error: result.stderr || result.stdout,
    });
  }
}

async function wakeAndUnlock() {
  await adbText(["shell", "input", "keyevent", "WAKEUP"], 8000);
  await adbText(["shell", "wm", "dismiss-keyguard"], 8000);
  await adbText(["shell", "input", "swipe", "540", "2300", "540", "400", "500"], 8000);
  await sleep(1000);
}

async function waitForLog(pattern, timeout, name) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const logcat = await adbText(["logcat", "-d", "-v", "time"], 12000);
    if (pattern.test(logcat.stdout || "")) return true;
    await sleep(1000);
  }
  await safeExit(3, `${name}_timeout`, {
    message: `Timed out waiting for Android log evidence: ${name}; no real IM task was created.`,
  });
}

async function waitForTask(campaignId, jid) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const dashboard = await api("/v1/dashboard");
    const task = (dashboard.tasks || []).find((item) => item.campaign_id === campaignId && item.contact_jid === jid);
    if (task) return task.id;
    await sleep(1000);
  }
  throw new Error(`created campaign ${campaignId}, but task did not appear in dashboard`);
}

async function waitForSend(taskId) {
  const end = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < end) {
    const { task, events } = await findTask(taskId);
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
      }, null, 2));
    }
    if (task.status === "sent" || task.status === "read") return task;
    if (task.status === "failed") throw new Error(`Android send failed: ${task.error || "unknown error"}`);
    await sleep(3000);
  }
  const { task, events } = await findTask(taskId);
  throw new Error(`timeout waiting for Android send; latest=${JSON.stringify({ task, events })}`);
}

async function findTask(taskId) {
  const dashboard = await api("/v1/dashboard");
  return {
    task: (dashboard.tasks || []).find((item) => item.id === taskId),
    events: (dashboard.events || []).filter((item) => item.task_id === taskId),
  };
}

async function findDefaultDeviceId() {
  const devices = await api("/v1/devices");
  const rows = devices.devices || [];
  const accountScoped = rows.filter((item) => String(item.id || "").startsWith("android-wa-"));
  const ready = accountScoped.find(isReadyDevice);
  if (!ready) {
    await safeExit(3, "device_not_ready", {
      message: "No ready android-wa-* device found in Worker. Log in on the Android app and sync/register before running android:verify.",
      devices: accountScoped.map(deviceSummary),
    });
  }
  return String(ready.id);
}

async function assertDeviceCanSend(id) {
  const devices = await api("/v1/devices");
  const device = (devices.devices || []).find((item) => item.id === id);
  if (!device) {
    await safeExit(3, "device_not_found", {
      deviceId: id,
      message: "Selected device does not exist in Worker; no real IM task was created.",
    });
  }
  if (!isReadyDevice(device)) {
    await safeExit(3, "device_safety_blocked", {
      device: deviceSummary(device),
      message: "Refusing to create a real IM task while the Android device is blocked by SDK safety.",
    });
  }
}

function isReadyDevice(device) {
  const status = String(device.status || "");
  const safetyStatus = String(device.safety_status || "");
  const retryAfterSeconds = Number(device.safety_retry_after_seconds || 0);
  const state = bridgeState(device.safety_json);
  return status === "online"
    && retryAfterSeconds === 0
    && !["risk_stopped", "cooldown", "cooling_down"].includes(safetyStatus)
    && (state === "" || state === "connected");
}

function deviceSummary(device) {
  return {
    id: device.id,
    status: device.status || null,
    safetyStatus: device.safety_status || null,
    retryAfterSeconds: Number(device.safety_retry_after_seconds || 0),
    bridgeState: bridgeState(device.safety_json),
  };
}

function bridgeState(value) {
  const safety = parseJson(value);
  return String(safety?.state || "");
}

function parseJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function tapText(text) {
  const tree = await adbText(["exec-out", "uiautomator", "dump", "/dev/tty"], 12000);
  if (!tree.ok) return false;
  const bounds = findBoundsForText(tree.stdout, text);
  if (!bounds) return false;
  const x = Math.floor((bounds[0] + bounds[2]) / 2);
  const y = Math.floor((bounds[1] + bounds[3]) / 2);
  const tapped = await adbText(["shell", "input", "tap", String(x), String(y)], 8000);
  return tapped.ok;
}

function findBoundsForText(xml, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:text|content-desc)="[^"]*${escaped}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const match = pattern.exec(xml);
  if (!match) return null;
  return match.slice(1).map(Number);
}

async function screenshot(name) {
  const image = await adbBuffer(["exec-out", "screencap", "-p"], 12000);
  if (!image.ok) return null;
  const png = stripToPng(image.stdout);
  if (!png) return null;
  const file = join(outDir, name);
  await writeFile(file, png);
  summary.screenshots.push(file);
  return file;
}

function stripToPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const start = buffer.indexOf(signature);
  return start >= 0 ? buffer.subarray(start) : null;
}

async function writeLogcatSnippet() {
  const logcat = await adbText(["logcat", "-d", "-v", "time"], 20000);
  const rawPath = join(outDir, "logcat-full.txt");
  await writeFile(rawPath, logcat.stdout || logcat.stderr || "");
  const keyLines = (logcat.stdout || "")
    .split("\n")
    .filter((line) => /DmBroadcast|connected|POLL|message_send_start|message_sent/i.test(line))
    .join("\n");
  const path = join(outDir, "logcat-key-lines.txt");
  await writeFile(path, keyLines + (keyLines.endsWith("\n") ? "" : "\n"));
  return path;
}

async function readLogcatSnippet() {
  const logcat = await adbText(["logcat", "-d", "-v", "time"], 20000);
  return (logcat.stdout || "")
    .split("\n")
    .filter((line) => /DmBroadcast|connected|POLL|message_send_start|message_sent/i.test(line))
    .join("\n");
}

function parseAdbDevices(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
}

function selectAdbSerial(devices) {
  const online = devices.filter((device) => device.state === "device");
  if (adbSerial) {
    return online.find((device) => device.serial === adbSerial)?.serial || "";
  }
  const candidates = allowEmulator ? online : online.filter((device) => !device.serial.startsWith("emulator-"));
  return candidates[0]?.serial || "";
}

async function adbText(args, timeout = 8000) {
  return runText(adbBin, ["-s", selectedSerial, ...args], timeout);
}

async function adbBuffer(args, timeout = 8000) {
  return runBuffer(adbBin, ["-s", selectedSerial, ...args], timeout);
}

async function safeExit(code, status, extra = {}) {
  Object.assign(summary, extra, {
    status,
    ok: Boolean(extra.ok),
    finishedAt: new Date().toISOString(),
  });
  const summaryPath = join(outDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  summary.summary = summaryPath;
  const output = JSON.stringify(summary, null, 2);
  if (code === 0) console.log(output);
  else console.error(output);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runText(command, args, timeoutMs = 8000) {
  const result = await runBuffer(command, args, timeoutMs);
  return {
    ...result,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runBuffer(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat([...stderr, Buffer.from(`\ntimeout after ${timeoutMs}ms`)]),
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat([...stderr, Buffer.from(`\n${error.message}`)]),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
