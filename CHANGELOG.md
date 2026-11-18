# Changelog

All notable changes to luck-mail will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[中文版](CHANGELOG.zh-CN.md)

## [Unreleased]

### Added
- Refresh-all button on the mobile/tablet account overview (same refresh-all as desktop)
- Search results switch the reading pane to the first result on desktop
- Drafts are now stored on the server (audit #5, 2026-11-18): new /api/drafts CRUD, auto-save while composing, sending a draft deletes it, and existing local drafts are migrated once on first load

### Changed
- Search: FTS coverage backfilled to 100%, multi-word queries are AND, results ranked by bm25 relevance; search is global by default instead of view-scoped
- Mobile swipe-back redesigned on the History API (edge swipe = system back, mid-screen swipe = in-app back a level)
- Pagination: deleting the last item on a page returns to the previous page; moving a message to spam decrements the total
- Audit #2 cleanup (2026-11-18): single delete asks for confirmation; delete/move-to-spam no longer trusts the current view — permanence is decided by the message's actual folder, and a missing trash folder errors instead of silently deleting permanently; delete-status polling no longer leaks; reconnect reconciles; send path reports partial rejections and APPEND failures instead of silently dropping them
- Sent mail is now cached locally even when the server APPEND returns no UID: `appendToSent` looks the UID up by Message-ID in the same IMAP session (2026-11-18; 163 returns a UID via UIDPLUS, so the fallback is dormant for 163 and matters for other providers)
- Draft search verified 5/5 (2026-11-18): a local draft is excluded from search, never pops the compose window, and survives clearing the search
- Audit #3 (2026-11-18): folder sync no longer rebuilds on every sync — full refetch only when UIDVALIDITY is actually present and changed; SMTP connection pooling; send idempotency (the same key never sends twice); batch delete is now async with a taskId + status polling
- Audit #4 (2026-11-18): sent-mail duplicates removed (same Message-ID deduplicated within a folder, deleting also removes the server's auto-saved copy); QQ `\NoSelect` folders are skipped (case-insensitive match); send falls back to a Message-ID lookup when APPEND returns no UID; switching folders clears the old list before loading
- Audit #5 fixes (2026-11-18): backup/export downloads are POST-only with SameSite=Strict (CSRF); session expiry now compares correctly and remember-me is honored (default 1 day); trust proxy set; 163 accounts poll instead of IDLE; drafts API; CSV import (template also CSV, export stays xlsx); multer/nodemailer/imapflow upgraded; automatic daily backup; /api/health; backend listens on 127.0.0.1 only

### Removed
- Dead-code cleanup across frontend, backend and config: unused functions, dead endpoints (`/api/search`, `/api/status`), SnappyMail scaffolding, old `frontend/main/` and `research/` references

## [0.1.0] - 2026-11-17

### Added
- Single-user login: username (case-insensitive) + password, 5-failure lockout, 30-day remember-me, change username/password in Settings
- Unified inbox: all mailboxes merged by time; aggregate views for inbox, unread, drafts, sent, trash
- Real folders only: folder list synced from the IMAP server via `LIST`, never fabricated
- Known-provider presets: 163, Gmail, Outlook, QQ, iCloud and more auto-fill IMAP/SMTP on add
- Real-time push: new mail arrives over WebSocket, unread badges update instantly
- Read, send, delete, batch delete (up to 200), pagination (50 per page), full-text search (SQLite FTS5 trigram)
- Mailbox management popup: serial numbers, alias (inline edit), drag-to-sort, per-row connectivity test, enable/disable, delete
- Export all mailboxes to Excel (.xlsx, includes authorization codes) and batch import from a template
- Read-pane translation (English to Chinese, DeepL) and sender copy button
- Backup to local: download a .tar.gz with the encryption key + database snapshot + bodies/attachments
- 6 color themes (blue default, green, black-white, purple, orange, cyan), responsive desktop/mobile layout
- Attachments are metadata-only by default and streamed live from IMAP on download
- Migration guide (MIGRATION.md / MIGRATION.zh-CN.md)
