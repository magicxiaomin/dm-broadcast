import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const MIGRATIONS_TABLE = "_dm_migrations";

export async function loadMigrationFiles(migrationsDir) {
  const dir = typeof migrationsDir === "string" ? migrationsDir : migrationsDir.pathname;
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(
    files.map(async (name) => ({
      name,
      path: path.join(dir, name),
      sql: await readFile(path.join(dir, name), "utf8"),
    })),
  );
}

export function splitSqlStatements(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function escapeSqlString(value) {
  return String(value).replaceAll("'", "''");
}

export async function ensureMigrationTrackingD1(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  ).run();
}

export async function appliedMigrationNamesD1(db) {
  await ensureMigrationTrackingD1(db);
  const rows = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all();
  return new Set((rows.results ?? []).map((row) => String(row.name)));
}

export async function applyMigrationsToD1(db, migrationsDir, now = Date.now()) {
  const migrations = await loadMigrationFiles(migrationsDir);
  const appliedNames = await appliedMigrationNamesD1(db);
  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }

    const statements = splitSqlStatements(migration.sql).map((statement) => db.prepare(statement));
    statements.push(
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).bind(migration.name, now),
    );
    await db.batch(statements);
    appliedNames.add(migration.name);
    applied.push(migration.name);
  }

  return { applied, skipped };
}

export function migrationFileSql(migration, now = Date.now()) {
  const statements = splitSqlStatements(migration.sql);
  statements.push(
    `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES ('${escapeSqlString(migration.name)}', ${Math.floor(now)})`,
  );
  return `${statements.join(";\n")};\n`;
}
