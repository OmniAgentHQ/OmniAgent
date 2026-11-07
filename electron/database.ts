import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function databaseIsUnreadable(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error ?? '');
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return /SQLITE_CORRUPT|SQLITE_NOTADB/.test(code)
    || /malformed|not a database|file is not a database|disk image|database corrupt|encrypted or is not a database|failed its integrity check/i.test(detail);
}

export function corruptDatabaseBackupNames(file: string, stamp: string) {
  return ['', '-wal', '-shm'].map((suffix) => ({ from: `${file}${suffix}`, to: `${file}${suffix}.corrupt-${stamp}` }));
}

function prepareDatabase(file: string) {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const [row] = db.pragma('quick_check(1)') as Array<{ quick_check?: string }>;
    const verdict = String(row?.quick_check ?? 'ok');
    if (verdict !== 'ok') throw new Error(`The workspace database failed its integrity check: ${verdict}`);
    return db;
  } catch (error) {
    try { db.close(); } catch {  }
    throw error;
  }
}

export type OpenedWorkspaceDatabase = { db: Database.Database; replacedCorruptFile: string };

export function openWorkspaceDatabase(
  userData: string,
  open: (file: string) => Database.Database = prepareDatabase
): OpenedWorkspaceDatabase {
  const file = path.join(userData, 'omniagent.db');
  try {
    return { db: open(file), replacedCorruptFile: '' };
  } catch (error) {
    if (!databaseIsUnreadable(error) || !fs.existsSync(file)) throw error;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let kept = '';
    for (const { from, to } of corruptDatabaseBackupNames(file, stamp)) {
      if (!fs.existsSync(from)) continue;
      try {
        fs.renameSync(from, to);
        if (!kept) kept = path.basename(to);
      } catch {
        try {
          fs.rmSync(from, { force: true });
        } catch {
        }
      }
    }
    return { db: open(file), replacedCorruptFile: kept };
  }
}

const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        encrypted_secret BLOB NOT NULL,
        masked_value TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        models_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        UNIQUE(provider, label)
      );
      CREATE TABLE IF NOT EXISTS ai_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        account_email TEXT,
        plan_type TEXT,
        status TEXT NOT NULL DEFAULT 'disconnected',
        models_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        team_json TEXT NOT NULL,
        next_loop_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        provider_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        run_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id, created_at);
    `
  },
  {
    version: 2,
    sql: `ALTER TABLE provider_credentials ADD COLUMN endpoint TEXT;`
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS step_details (
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, owner_id, step_id)
      );
    `
  }
];

export function applyMigrations(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version)
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
    })();
  }
}

export function readSetting<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare(`SELECT value_json FROM app_settings WHERE key=?`).get(key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function writeSetting(db: Database.Database, key: string, value: unknown) {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}
