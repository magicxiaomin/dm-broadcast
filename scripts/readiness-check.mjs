import { spawn } from "node:child_process";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const deviceId = process.env.DM_DEVICE_ID || await findDefaultDeviceId();
const contactJid = process.env.DM_REAL_CONTACT_JID || "85255804693@s.whatsapp.net";
const adbBin = process.env.ADB_BIN || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adbSerial = process.env.DM_ADB_SERIAL || "";
const androidPackage = process.env.DM_ANDROID_PACKAGE || "com.magicxiaomin.dmbroadcast.device";
const strict = process.argv.includes("--strict") || process.env.DM_READINESS_STRICT === "1";

const checks = [];

function record(name, status, detail = {}) {
  checks.push({ name, status, ...detail });
}

function hasBlockingCheck() {
  return checks.some((check) => check.status === "block");
}

async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\ntimeout after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function parseSafetyJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function deviceSafety(device) {
  if (!device) return { blocked: true, reason: "device_not_registered" };

  const now = Date.now();
  const status = String(device.status || "");
  const safetyStatus = String(device.safety_status || "");
  const retryAfterSeconds = Math.max(0, Number(device.safety_retry_after_seconds || 0));
  const safetyUpdatedAt = Number(device.safety_updated_at || 0);
  const safety = parseSafetyJson(device.safety_json);
  const bridgeState = String(safety?.state || "");
  const retryUntil = safetyUpdatedAt && retryAfterSeconds > 0
    ? safetyUpdatedAt + retryAfterSeconds * 1000
    : null;
  const retryActive = Boolean(retryUntil && now < retryUntil);
  const statusBlocked = ["risk_stopped", "cooldown", "cooling_down", "offline"].includes(status);
  const safetyBlocked = safetyStatus === "risk_stopped" || safetyStatus === "cooling_down" || retryActive;
  const stateBlocked = bridgeState !== "" && bridgeState !== "connected";
  return {
    blocked: statusBlocked || safetyBlocked || stateBlocked,
    status,
    safetyStatus,
    bridgeState,
    retryAfterSeconds,
    safetyUpdatedAt,
    retryUntil,
    retryUntilIso: retryUntil ? new Date(retryUntil).toISOString() : null,
    safety,
    reason: statusBlocked ? `device_status_${status}` : safetyBlocked ? "device_safety" : stateBlocked ? `bridge_state_${bridgeState}` : "ready",
  };
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

async function checkWorker() {
  try {
    const health = await api("/health");
    record("worker-health", "pass", {
      apiBase,
      summary: health.summary,
      storage: health.storage,
      freeTierGuard: health.freeTierGuard,
    });
  } catch (error) {
    record("worker-health", "block", { apiBase, error: error.message });
    return;
  }

  try {
    const devices = await api("/v1/devices");
    const device = (devices.devices || []).find((item) => item.id === deviceId);
    const safety = deviceSafety(device);
    record("cloud-device", safety.blocked ? "block" : "pass", { deviceId, safety });
  } catch (error) {
    record("cloud-device", "block", { deviceId, error: error.message });
  }

  try {
    const dashboard = await api("/v1/dashboard");
    const counts = (dashboard.summary?.tasksByStatus || []).reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {});
    record("dashboard", "pass", {
      campaigns: dashboard.summary?.campaigns ?? 0,
      devices: dashboard.summary?.devices ?? 0,
      points: dashboard.summary?.points ?? 0,
      tasksByStatus: counts,
    });
  } catch (error) {
    record("dashboard", "block", { error: error.message });
  }
}

async function checkContact() {
  if (!contactJid || !contactJid.includes("@")) {
    record("real-contact", "block", {
      contactJid,
      message: "Set DM_REAL_CONTACT_JID to a full WhatsApp JID before real E2E.",
    });
    return;
  }
  record("real-contact", "pass", { contactJid });
}

async function checkCloudflareDeploy() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    record("cloudflare-deploy-token", "pass", {
      message: "CLOUDFLARE_API_TOKEN is present for npm run worker:deploy:api.",
    });
  } else {
    record("cloudflare-deploy-token", "warn", {
      message: "No CLOUDFLARE_API_TOKEN; Worker API deploy is not available from this shell.",
    });
  }
}

async function checkAdb() {
  const listed = await run(adbBin, ["devices"]);
  if (!listed.ok) {
    record("adb", "block", { adbBin, error: listed.stderr || listed.stdout });
    return;
  }
  const devices = parseAdbDevices(listed.stdout).filter((item) => item.state === "device");
  const selected = adbSerial
    ? devices.find((item) => item.serial === adbSerial)
    : devices[0];
  if (!selected) {
    record("adb", "block", {
      adbBin,
      requestedSerial: adbSerial || null,
      devices,
      message: "No connected Android device is available for real E2E.",
    });
    return;
  }
  record("adb", "pass", { serial: selected.serial, devices });

  const prefix = adbSerial ? ["-s", selected.serial] : [];
  const packageCheck = await run(adbBin, [...prefix, "shell", "pm", "path", androidPackage]);
  if (!packageCheck.ok || !packageCheck.stdout.includes(androidPackage)) {
    record("android-app", "block", {
      serial: selected.serial,
      androidPackage,
      error: packageCheck.stderr || packageCheck.stdout,
    });
    return;
  }
  record("android-app", "pass", { serial: selected.serial, androidPackage });

  const riskStop = await run(adbBin, [
    ...prefix,
    "shell",
    "run-as",
    androidPackage,
    "sh",
    "-c",
    "cat files/wa-session/risk-stop.json 2>/dev/null || true",
  ]);
  if (!riskStop.ok) {
    record("android-local-safety", "warn", {
      serial: selected.serial,
      message: "Could not read local risk-stop.json through run-as.",
      error: riskStop.stderr || riskStop.stdout,
    });
    return;
  }

  const raw = riskStop.stdout.trim();
  if (!raw) {
    record("android-local-safety", "pass", {
      serial: selected.serial,
      message: "No local risk-stop.json found.",
    });
    return;
  }

  try {
    const localSafety = JSON.parse(raw);
    const untilMs = localSafety.until ? Date.parse(localSafety.until) : 0;
    const active = Number.isFinite(untilMs) && untilMs > Date.now();
    record("android-local-safety", active ? "block" : "pass", {
      serial: selected.serial,
      active,
      until: localSafety.until || null,
      reason: localSafety.reason || null,
    });
  } catch (error) {
    record("android-local-safety", "warn", {
      serial: selected.serial,
      raw,
      error: error.message,
    });
  }
}

await checkWorker();
await checkContact();
await checkCloudflareDeploy();
await checkAdb();

const readyForRealE2E = !hasBlockingCheck();
const result = {
  ok: true,
  readyForRealE2E,
  strict,
  checkedAt: new Date().toISOString(),
  checks,
  nextCommand: readyForRealE2E
    ? `DM_REAL_CONTACT_JID=${contactJid} npm run e2e:real`
    : "Resolve blocking checks before creating a real IM task.",
};

console.log(JSON.stringify(result, null, 2));

if (!readyForRealE2E && strict) {
  process.exit(3);
}
