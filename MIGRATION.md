# luck-mail — Migration Guide

[中文版](MIGRATION.zh-CN.md)

How to move a running luck-mail instance to a new server, and what to back up
so the move is seamless. Also see [README.md](README.md) for setup and
[API_CONTRACT.md](API_CONTRACT.md) for the data model.

## What is stored where

All luck-mail data lives in **two places** on the server:

| Path | What it holds |
| --- | --- |
| `/opt/luck-mail/.key` | The 32-byte AES-256-GCM encryption key (file mode `0600`). Every mailbox password is encrypted with this key before it is stored in the database. |
| `/opt/luck-mail/data/` | The SQLite database `luck-mail.db`, message bodies in `bodies/`, and pre-2026-11-17 cached attachments in `attachments/`. |

The database holds: the login account, all mailbox accounts (address, **encrypted**
password, server settings, alias, sort order, enabled state), folders synced from
each mail server, message metadata (subject, sender, recipients, date, snippet,
read state, UID, Message-ID), attachment metadata (name, size, type, IMAP part
number — content is **not** stored), per-folder sync state, tombstones of
permanently deleted messages (so a deleted mail never comes back), settings
(signature, default account), drafts (with idempotency keys), the full-text
search index (FTS5) and login sessions.

The code itself is this repository — it does **not** need a separate backup.
Re-deploy it from GitHub on the new server.

The mail itself lives on the mail servers (163, Gmail, Outlook, …). The local
database is a synced copy/cache. That means a lost database can be rebuilt by
re-adding the mailboxes and re-syncing — but restoring the database **together
with the key** is what makes a migration seamless: no re-adding mailboxes, no
full re-sync, read states and folders exactly as before.

**The key and the database must travel together.** One without the other is
useless for the mailbox passwords:

- Key lost, database kept → the accounts are listed but their passwords cannot
  be decrypted. Every mailbox must be deleted and re-added with a fresh
  authorisation code.
- Database lost, key kept → the account list itself is in the database, so every
  mailbox must be re-added. The key alone restores nothing. After re-adding,
  all mail re-syncs from the mail servers (slower first sync).
- Both lost → fresh install: re-create the login account, re-add all mailboxes.
  Mail re-syncs from the servers.

## What does NOT migrate

- **Theme preference** — also browser `localStorage`.
- **Login sessions** — log in again after the migration.
- **TLS certificate** — re-issue it on the new server (Let's Encrypt).

## Backup (on the old server)

Preferred: use the in-app **Backup to local** button (Settings), which downloads a tarball of `.key` + `data/` via `POST /api/backup/download` — it uses a consistent database snapshot (`db.backup()`), so the service does **not** need to stop.

Manual method (if the web UI is unavailable): stop the service first so the SQLite database is in a consistent state, then make one tarball containing **both** the key and the data directory:

```bash
sudo systemctl stop luck-mail
sudo tar -czf luck-mail-backup-$(date +%Y%m%d).tar.gz -C /opt/luck-mail .key data
# copy the tarball to the new server, e.g.:
scp luck-mail-backup-*.tar.gz root@<new-server>:/tmp/
```

The whole data directory is small (6.0 MB as of 2026-11-18 — reference value — with 27 mailboxes and 227 messages: DB 1.7 MB + WAL 4.1 MB + bodies 280 KB + attachments 4.0 KB, an empty directory), so a daily tarball is cheap. Keep backups **off** the same server.

### Automatic daily backup

The repository ships `scripts/backup-cron.sh`, which takes a consistent
database snapshot (`db.backup()` — no need to stop the service), packs the
snapshot + `.key` + `bodies/` + `attachments/` into a tarball, and keeps the
newest **7** copies under `/opt/luck-mail/backups/auto/`. Install it once:

```bash
sudo cp scripts/backup-cron.sh /opt/luck-mail/backup-cron.sh
sudo chmod 700 /opt/luck-mail/backup-cron.sh
# crontab -e, add:
0 3 * * * /opt/luck-mail/backup-cron.sh >> /opt/luck-mail/backups/backup-cron.log 2>&1
```

An automatic backup has the same layout as a manual one (`.key` +
`luck-mail.db` + `bodies/` + `attachments/`), so restore it exactly like a
manual backup (see step 3 in Migration steps): stop the service, extract the
tarball to a staging directory, copy the files into place (`.key` back to mode
`0600`), start the service.

## Migration steps (on the new server)

### 1. Install prerequisites

- **Node.js 22** (the backend runs on Node 22).
- A reverse proxy (OpenResty / nginx) and a domain pointing at the new server.
- SQLite3 CLI is optional, only for inspection.

### 2. Get the code

```bash
git clone https://github.com/Luck98235/luck-mail   # private repo, needs authentication
cd luck-mail/backend && npm ci && npm run build
cd ../frontend && npm ci && npm run build
cp -r dist ../backend/public   # the backend serves the built frontend from public/
# then copy the built backend to /opt/luck-mail/backend
```

Use `npm ci` here (clean, reproducible install from `package-lock.json`); `npm install` is for local development when adding or updating dependencies.

Or copy `/opt/luck-mail/backend` from the old server as-is.

### 3. Restore the key and the data

```bash
sudo mkdir -p /opt/luck-mail
sudo tar -xzf /tmp/luck-mail-backup-YYYYMMDD.tar.gz -C /opt/luck-mail
sudo chmod 600 /opt/luck-mail/.key
sudo ls -l /opt/luck-mail/.key /opt/luck-mail/data/luck-mail.db
```

The key **must** be mode `0600`. If it is readable by others, or missing, the
service cannot decrypt the stored mailbox passwords.

### 4. Create and start the service

`/etc/systemd/system/luck-mail.service`:

```ini
[Unit]
Description=luck-mail
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/luck-mail/backend
ExecStart=/usr/bin/node /opt/luck-mail/backend/dist/server.js
Environment=PORT=8080
Environment=DATA_DIR=/opt/luck-mail/data
Environment=PUBLIC_DIR=/opt/luck-mail/backend/public
Environment=KEY_FILE=/opt/luck-mail/.key
Environment=COOKIE_SECURE=1
Environment=DEEPL_API_KEY=<your DeepL key>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now luck-mail
sudo systemctl status luck-mail   # should be active
```

### 5. Reverse proxy and TLS

Proxy `/` (and `/socket.io/` with the `Upgrade` header for WebSocket) to
`127.0.0.1:8080`, with `proxy_read_timeout 120s` and `client_max_body_size 25m`.
Issue a Let's Encrypt certificate for the domain and redirect HTTP to HTTPS.

Certificate auto-renewal: `/opt/acme/renew.sh` runs daily at 03:30 via cron; it
renews the Let's Encrypt certificate (ACME challenge via webroot) and reloads
the `1Panel-openresty` container (the reverse proxy) so the new certificate
takes effect. Check `/opt/acme/renew.log` for the last run and the next renewal
date.

### 6. Verify

- `systemctl status luck-mail` — active, no errors in
  `journalctl -u luck-mail`.
- Open the site and log in (sessions do not carry over — log in again).
- All mailboxes show online; messages, folders and read states are exactly as
  before.
- Send a test mail and confirm it arrives; open an attachment and confirm it
  downloads (it streams live from the mail server by IMAP part number).

## Backup recommendation

Back up `.key` + `data/` **together**, regularly (daily is fine — the tarball is
only a few MB), and store the backup off the server. A backup that contains only
one of the two cannot restore the mailbox passwords.
