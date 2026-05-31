import { readFile } from "node:fs/promises";

const android = await readFile("apps/android/app/src/main/java/com/magicxiaomin/dmbroadcast/device/MainActivity.kt", "utf8");
const web = await readFile("apps/web/src/main.ts", "utf8");
const realE2E = await readFile("scripts/real-e2e.mjs", "utf8");
const readiness = await readFile("scripts/readiness-check.mjs", "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  android.includes('private var deviceId = FALLBACK_DEVICE_ID'),
  "Android deviceId must be mutable and initialized from FALLBACK_DEVICE_ID.",
);
assert(
  android.includes("private fun deviceIdForSelfJid(jid: String): String"),
  "Android must derive a cloud deviceId from the logged-in account JID.",
);
assert(
  android.includes('deviceId = deviceIdForSelfJid(selfJid)'),
  "Android must update deviceId after reading self_jid.",
);
assert(
  android.includes('.put("accountJid", selfJid)'),
  "Android device registration should include accountJid for operator visibility.",
);
assert(
  android.includes('private const val FALLBACK_DEVICE_ID = "android-prototype"'),
  "Android should keep android-prototype only as the pre-login fallback device ID.",
);
assert(
  android.includes('private const val DEVICE_ID_PREFIX = "android-wa-"'),
  "Android account scoped device IDs should use the android-wa- prefix.",
);

assert(
  web.includes("defaultDeviceId()") && web.includes('placeholder: "android-wa-..."'),
  "Web task form should default to an account-scoped online device instead of hard-coding android-prototype.",
);
assert(
  realE2E.includes("findDefaultDeviceId") && realE2E.includes('DM_DEVICE_ID || await findDefaultDeviceId()'),
  "Real E2E should default to an account-scoped ready device when DM_DEVICE_ID is not set.",
);
assert(
  readiness.includes("findDefaultDeviceId") && readiness.includes('DM_DEVICE_ID || await findDefaultDeviceId()'),
  "Readiness check should inspect an account-scoped device by default.",
);

console.log(JSON.stringify({ ok: true, check: "account-isolation" }, null, 2));
