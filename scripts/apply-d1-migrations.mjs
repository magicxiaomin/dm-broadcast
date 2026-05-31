import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MIGRATIONS_TABLE,
  loadMigrationFiles,
  migrationFileSql,
} from "./lib/d1-migrations.mjs";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const local = args.includes("--local") || !remote;
const databaseArgIndex = args.indexOf("--database");
const database = databaseArgIndex >= 0 ? args[databaseArgIndex + 1] : "dm_broadcast_mvp";
const migrationsDir = fileURLToPath(new URL("../apps/worker/migrations/", import.meta.url));

function wranglerArgs(extra) {
  return [
    "d1",
    "execute",
    database,
    local ? "--local" : "--remote",
    "--json",
    ...extra,
  ];
}

function runWrangler(extra) {
  return new Promise((resolve, reject) => {
    const child = spawn("wrangler", wranglerArgs(extra), {
      cwd: fileURLToPath(new URL("../apps/worker/", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`wrangler ${wranglerArgs(extra).join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function collectNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  if (typeof value.name === "string") names.add(value.name);
  for (const item of Object.values(value)) collectNames(item, names);
  return names;
}

function parseWranglerJson(stdout) {
  const clean = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning; Wrangler may print non-JSON notices before the JSON payload.
    }
  }
  throw new Error(`wrangler did not return parseable JSON:\n${stdout}`);
}

async function appliedMigrationNames() {
  await runWrangler([
    "--command",
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  ]);
  const result = await runWrangler(["--command", `SELECT name FROM ${MIGRATIONS_TABLE}`]);
  return collectNames(parseWranglerJson(result.stdout || "[]"));
}

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dm-broadcast-d1-migrations-"));

try {
  const migrations = await loadMigrationFiles(migrationsDir);
  const appliedNames = await appliedMigrationNames();
  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }

    const migrationPath = path.join(tmpDir, migration.name);
    await writeFile(migrationPath, migrationFileSql(migration), "utf8");
    await runWrangler(["--file", migrationPath]);
    appliedNames.add(migration.name);
    applied.push(migration.name);
  }

  console.log(JSON.stringify({ ok: true, database, mode: local ? "local" : "remote", applied, skipped }, null, 2));
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
