import { spawn } from "node:child_process";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const realContactJid = process.env.DM_REAL_CONTACT_JID || "85255804693@s.whatsapp.net";
const realContactName = process.env.DM_REAL_CONTACT_NAME || "小号 +85255804693";
const runRealE2E = process.env.DM_ACCEPTANCE_RUN_REAL_E2E === "1" || process.env.DM_RUN_REAL_E2E === "1";
const gradle = process.env.GRADLE_BIN || `${process.env.HOME}/.local/share/codex-wa-tools/gradle-8.10.2/bin/gradle`;
const javaHome = process.env.JAVA_HOME || `${process.env.HOME}/.local/share/codex-wa-tools/jdk17/Contents/Home`;
const androidHome = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;

const checks = [
  {
    name: "Worker typecheck",
    command: "npm",
    args: ["run", "worker:check"],
  },
  {
    name: "Web production build",
    command: "npm",
    args: ["run", "web:build"],
  },
  {
    name: "Android debug build",
    command: gradle,
    args: ["--no-daemon", ":app:assembleDebug"],
    cwd: "apps/android",
    env: {
      JAVA_HOME: javaHome,
      ANDROID_HOME: androidHome,
      ANDROID_SDK_ROOT: androidHome,
    },
  },
  {
    name: "Account isolation static check",
    command: "npm",
    args: ["run", "account-isolation:check"],
  },
  {
    name: "Worker local safety/requeue smoke",
    command: "npm",
    args: ["run", "worker:safety-smoke"],
  },
  {
    name: "Worker online safety smoke",
    command: "npm",
    args: ["run", "worker:online-safety-smoke"],
  },
  {
    name: "Worker online read/ledger smoke",
    command: "npm",
    args: ["run", "worker:smoke"],
  },
  {
    name: "Readiness preflight",
    command: "npm",
    args: ["run", "readiness:check"],
  },
  ...(runRealE2E
    ? [
        {
          name: "Real Android E2E",
          command: "npm",
          args: ["run", "e2e:real"],
          env: {
            DM_REAL_CONTACT_JID: realContactJid,
            DM_REAL_CONTACT_NAME: realContactName,
          },
          allowExitCodes: [0, 3],
        },
      ]
    : []),
];

function runCheck(check) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(check.command, check.args, {
      cwd: check.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(check.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        name: check.name,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      });
    });
    child.on("close", (code) => {
      const allowed = check.allowExitCodes || [0];
      resolve({
        name: check.name,
        ok: allowed.includes(code ?? -1),
        exitCode: code,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

function tail(text, lines = 16) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

const results = [];
for (const check of checks) {
  process.stdout.write(`\n==> ${check.name}\n`);
  const result = await runCheck(check);
  results.push(result);
  const status = result.ok ? "PASS" : "FAIL";
  process.stdout.write(`${status} ${check.name} (${result.durationMs}ms, exit ${result.exitCode})\n`);
  const output = [tail(result.stdout), tail(result.stderr)].filter(Boolean).join("\n");
  if (output) process.stdout.write(`${output}\n`);
}

const failed = results.filter((result) => !result.ok);
console.log("\nAcceptance summary");
console.table(results.map((result) => ({
  check: result.name,
  status: result.ok ? "PASS" : "FAIL",
  exit: result.exitCode,
  seconds: Math.round(result.durationMs / 100) / 10,
})));

if (failed.length) {
  console.error(`Acceptance failed: ${failed.map((item) => item.name).join(", ")}`);
  process.exit(1);
}

const realE2E = results.find((result) => result.name === "Real Android E2E");
if (!runRealE2E) {
  console.log("Real Android E2E skipped by default; set DM_ACCEPTANCE_RUN_REAL_E2E=1 to create and send one real IM task.");
} else if (realE2E?.exitCode === 3) {
  console.log("Real Android E2E was safely blocked by SDK/device safety; no real task was created.");
}
