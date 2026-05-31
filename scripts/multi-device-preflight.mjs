import { spawn } from "node:child_process";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const apiBase = process.env.DM_API_BASE || "https://dm-broadcast-api.magicxiaomin.workers.dev";
const adminToken = process.env.DM_ADMIN_TOKEN || "";
const adbBin = process.env.ADB_BIN || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const strict = process.argv.includes("--strict") || process.env.DM_MULTI_DEVICE_STRICT === "1";

const result = {
  ok: false,
  status: "not_ready",
  apiBase,
  checks: [],
};

function record(name, status, detail = {}) {
  result.checks.push({ name, status, ...detail });
}

function finish(ok) {
  result.ok = ok;
  result.status = ok ? "ready" : "not_ready";
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok || !strict ? 0 : 1);
}

if (!adminToken) {
  record("admin-token", "block", {
    message: "Set DM_ADMIN_TOKEN before checking online Worker devices.",
  });
  finish(false);
}

const adb = await run(adbBin, ["devices"]);
if (adb.ok) {
  record("adb-devices", "info", { devices: parseAdbDevices(adb.stdout) });
} else {
  record("adb-devices", "warn", { adbBin, error: adb.stderr || adb.stdout });
}

let devices;
try {
  devices = await api("/v1/devices");
} catch (error) {
  record("worker-devices", "block", { error: error.message });
  finish(false);
}

const rows = devices.devices || [];
const accountScoped = rows.filter((device) => String(device.id || "").startsWith("android-wa-"));
const distinct = Array.from(new Map(accountScoped.map((device) => [String(device.id), device])).values());
const prototypeDevices = rows.filter((device) => String(device.id || "") === "android-prototype");
const readiness = distinct.map((device) => ({
  id: String(device.id || ""),
  waJid: device.wa_jid || null,
  status: device.status || null,
  safetyStatus: device.safety_status || null,
  retryAfterSeconds: Number(device.safety_retry_after_seconds || 0),
  bridgeState: bridgeState(device.safety_json),
  ready: isReady(device),
}));

record("android-wa-devices", distinct.length >= 2 ? "pass" : "block", {
  count: distinct.length,
  ids: distinct.map((device) => device.id),
  message: distinct.length >= 2
    ? "Found at least two distinct account-scoped devices."
    : "Need at least two distinct android-wa-* devices before multi-device testing.",
});
record("no-android-prototype", prototypeDevices.length === 0 ? "pass" : "block", {
  count: prototypeDevices.length,
  ids: prototypeDevices.map((device) => device.id),
});
record("device-safety-ready", readiness.every((device) => device.ready) && readiness.length >= 2 ? "pass" : "block", {
  devices: readiness,
});

finish(
  distinct.length >= 2
    && prototypeDevices.length === 0
    && readiness.length >= 2
    && readiness.every((device) => device.ready),
);

async function api(path) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function bridgeState(value) {
  const safety = parseJson(value);
  return String(safety?.state || "");
}

function isReady(device) {
  const status = String(device.status || "");
  const safetyStatus = String(device.safety_status || "");
  const retryAfterSeconds = Number(device.safety_retry_after_seconds || 0);
  const state = bridgeState(device.safety_json);
  return status === "online"
    && retryAfterSeconds === 0
    && !["risk_stopped", "cooling_down"].includes(safetyStatus)
    && (state === "" || state === "connected");
}

function parseJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
