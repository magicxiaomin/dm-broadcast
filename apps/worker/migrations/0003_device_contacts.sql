CREATE TABLE IF NOT EXISTS device_contacts (
  device_id TEXT NOT NULL,
  wa_jid TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, wa_jid),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_device_contacts_wa_jid
  ON device_contacts(wa_jid);

CREATE INDEX IF NOT EXISTS idx_device_contacts_device_updated
  ON device_contacts(device_id, updated_at);
