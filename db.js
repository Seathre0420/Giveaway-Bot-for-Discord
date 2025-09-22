import Database from 'better-sqlite3';

const db = new Database('giveaways.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  winners_count INTEGER NOT NULL,
  required_role_id TEXT,
  min_server_age_days INTEGER DEFAULT 0,
  min_account_age_days INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ENDED')) DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS winners (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  notified INTEGER DEFAULT 0,
  PRIMARY KEY (giveaway_id, user_id)
);
`);

export default db;
