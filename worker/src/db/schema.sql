-- NadMail D1 Schema

-- 帳號表：錢包 ↔ Email handle 映射
CREATE TABLE IF NOT EXISTS accounts (
    handle          TEXT PRIMARY KEY,
    wallet          TEXT NOT NULL UNIQUE,
    nad_name        TEXT,
    token_address   TEXT,
    token_symbol    TEXT,
    token_create_tx TEXT,
    webhook_url     TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    tier            TEXT NOT NULL DEFAULT 'free'
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
    microbuy_tx TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (handle) REFERENCES accounts(handle)
);

CREATE INDEX IF NOT EXISTS idx_emails_inbox ON emails(handle, folder, created_at DESC);

-- 每日發信計數（限制免費 10 封/天）
CREATE TABLE IF NOT EXISTS daily_email_counts (
    handle  TEXT NOT NULL,
    date    TEXT NOT NULL,
    count   INTEGER DEFAULT 0,
    PRIMARY KEY (handle, date)
);

-- 免費 .nad 名稱贈送池
CREATE TABLE IF NOT EXISTS free_nad_names (
    name        TEXT PRIMARY KEY,
    description TEXT,
    claimed_by  TEXT,
    claimed_at  INTEGER,
    FOREIGN KEY (claimed_by) REFERENCES accounts(wallet)
);
