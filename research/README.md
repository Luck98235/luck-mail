# research/ — third-party reference code (not part of luck-mail)

The files in this directory are **reference excerpts** kept from the early
research phase. They are **not used by luck-mail at build or run time**:
luck-mail is a fresh implementation (Node 22 + Express + TypeScript +
SQLite on the backend, Vue 3 + Vite + TypeScript on the frontend).

## What is here

- `frickmail/` — excerpts from the Frickmail project (a SnappyMail-based
  webmail experiment): unified-inbox and account-switching logic, login
  handling, crypto helpers and Docker files. The files carry **no license
  header**; treat them as reference-only and verify the upstream project's
  license before reusing them.
- `snappymail/` — excerpts from the SnappyMail project (login page,
  mail page, plugin base class). SnappyMail is licensed under the
  **GNU Affero General Public License v3.0 (AGPL-3.0)** — see
  https://github.com/the-djmaze/snappymail.

## Why it is kept

These excerpts informed the design of luck-mail's unified inbox,
multi-account handling and login flow. They are kept for traceability of
those design decisions. If you fork luck-mail and do not need them, you
can safely delete this directory — nothing in `backend/` or `frontend/`
imports from it.
