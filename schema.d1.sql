CREATE TABLE IF NOT EXISTS totp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  role_name TEXT,
  encrypted_secret BLOB NOT NULL,
  iv BLOB NOT NULL,
  created_by_discord_id TEXT NOT NULL,
  updated_by_discord_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_totp_accounts_service_name ON totp_accounts (service_name);
CREATE INDEX IF NOT EXISTS idx_totp_accounts_account_name ON totp_accounts (account_name);
CREATE INDEX IF NOT EXISTS idx_totp_accounts_created_by ON totp_accounts (created_by_discord_id);
CREATE INDEX IF NOT EXISTS idx_totp_accounts_deleted_at ON totp_accounts (deleted_at);
