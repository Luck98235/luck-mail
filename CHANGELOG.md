# Changelog

All notable changes to luck-mail will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[中文版](CHANGELOG.zh-CN.md)

## [Unreleased]

### Added
- Refresh-all button on the mobile/tablet account overview (same refresh-all as desktop)
- Drafts are now stored on the server (audit #5, 2026-11-18): new /api/drafts CRUD, auto-save while composing, sending a draft deletes it, and existing local drafts are migrated once on first load
- Browser notifications for new mail (2026-11-18): a "New mail notifications" toggle in Settings; when the page is in the background, a system notification shows the sender and subject (click opens the mail); multiple mails within 3 seconds merge into one summary notification

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
- Audit #5b follow-up fixes (2026-11-18): send route now has an outer catch (unexpected errors return 500 instead of crashing the process); re-claiming an in-progress send key checks the Sent folder first (the Message-ID is planned and stored at claim time) so a crash after SMTP success no longer resends; batch delete isolates per-message errors into the failed list; sending with a draftId now verifies the draft belongs to the sending account; /api/health no longer exposes the online account count; app-layer security headers removed (OpenResty is the single layer)
- Docs: migration sizes updated to measured values; automatic daily backup documented, and the backup script is now in the repo (scripts/backup-cron.sh)
- No more auto-open (2026-11-18): clicking a folder, searching, clearing a search, or deleting the message being read no longer opens the first/next message automatically — everything opens on click; the reading pane shows an empty state until a message is chosen
- Audit #6 fixes (2026-11-18, third pre-launch review): delete actions now send an idempotencyKey so the backend delete-idempotency protection actually applies; QQ accounts' last-sync time now updates on IDLE-driven syncs; login lockout messages no longer distinguish unknown usernames from known ones; graceful shutdown no longer hangs on open Socket.io connections (the old process used to exit 1 after 30s); docs corrected (stale search auto-open line removed, README mail-flow/IDLE wording, migration service template now includes UMask/MemoryMax and an EnvironmentFile for the DeepL key)
- Automatic backup retention reduced from 7 to 3 copies (2026-11-18, user decision: cap the number of backups so the server disk does not fill up)

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
