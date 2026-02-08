-- BaseMail D1 Schema

-- 帳號表：錢包 ↔ Email handle 映射
CREATE TABLE IF NOT EXISTS accounts (
    handle      TEXT PRIMARY KEY,
    wallet      TEXT NOT NULL UNIQUE,
    basename    TEXT,
    webhook_url TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    tx_hash     TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_wallet ON accounts(wallet);

-- 郵件表：收件匣 + 已寄送
CREATE TABLE IF NOT EXISTS emails (
    id          TEXT PRIMARY KEY,
    handle      TEXT NOT NULL,
    folder      TEXT NOT NULL DEFAULT 'inbox',
    from_addr   TEXT NOT NULL,
    to_addr     TEXT NOT NULL,
    subject     TEXT,
    snippet     TEXT,
    r2_key      TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    read        INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (handle) REFERENCES accounts(handle)
);

CREATE INDEX IF NOT EXISTS idx_emails_inbox ON emails(handle, folder, created_at DESC);

-- Basename 自動註冊等候名單（Coming Soon 功能）
CREATE TABLE IF NOT EXISTS waitlist (
    id              TEXT PRIMARY KEY,
    wallet          TEXT NOT NULL,
    desired_handle  TEXT NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_waitlist_handle ON waitlist(desired_handle);
