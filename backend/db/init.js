const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'taskboard.db');

function getDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      due_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
    );

    -- Cross-account board grants. Exactly one active (non-revoked) row per
    -- (board, grantee); revoked rows stay only as historical evidence.
    CREATE TABLE IF NOT EXISTS board_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      grantee_id INTEGER NOT NULL,
      access_level TEXT NOT NULL CHECK(access_level IN ('readonly','edit')),
      granted_by INTEGER NOT NULL,
      granted_at TEXT DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoked_by INTEGER,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY (grantee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id),
      FOREIGN KEY (revoked_by) REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_board_shares_active
      ON board_shares(board_id, grantee_id) WHERE revoked_at IS NULL;

    -- Append-only audit trail of every cross-account permission change.
    -- This log is the single source the audit report's "recent changes" and
    -- the effective-permission view are both derived from.
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      grantee_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('grant','update','revoke')),
      access_level TEXT CHECK(access_level IN ('readonly','edit')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY (grantee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id)
    );
  `);

  return db;
}

module.exports = { getDb, initDb };
