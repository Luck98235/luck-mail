# Changelog

All notable changes to luck-mail will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[中文版](CHANGELOG.zh-CN.md)

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
- Read-pane translation (English to Chinese, free MyMemory API) and sender copy button
- Backup to local: download a .tar.gz with the encryption key + database snapshot + bodies/attachments
- 6 color themes (blue default, green, black-white, purple, orange, cyan), responsive desktop/mobile layout
- Attachments are metadata-only by default and streamed live from IMAP on download
- Migration guide (MIGRATION.md / MIGRATION.zh-CN.md)
