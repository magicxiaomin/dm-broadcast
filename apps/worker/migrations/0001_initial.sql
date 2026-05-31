CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  wa_jid TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at INTEGER,
  safety_status TEXT,
  safety_retry_after_seconds INTEGER NOT NULL DEFAULT 0,
  safety_json TEXT,
  safety_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  wa_jid TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  contact_jid TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  points INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  scheduled_at INTEGER,
  sent_at INTEGER,
  read_at INTEGER,
  acked_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_device_status ON tasks(device_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id);

CREATE TABLE IF NOT EXISTS im_events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_im_events_task ON im_events(task_id);
CREATE INDEX IF NOT EXISTS idx_im_events_type_created ON im_events(event_type, created_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_id TEXT,
  entry_type TEXT NOT NULL,
  points INTEGER NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger_entries(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_task_read_reward
  ON ledger_entries(task_id, entry_type)
  WHERE task_id IS NOT NULL AND entry_type = 'read_reward';
