# VMPix V3 Data API

Unified backend-only data API for the VMPix V3 archive workbook.

## First setup

```bash
npm install
npm start
```

Local health check:

```txt
http://localhost:3000/health
```

## Environment variables

Copy `.env.example` values into Render environment variables.

Required:

- `DATABASE_URL`
- `GOOGLE_SHEET_ID`
- `ADMIN_TOKEN`
- tab GIDs such as `GID_MUSIC_BANDS`, `GID_MUSIC_SHOWS`, `GID_WRESTLING_MATCHES`, etc.

Optional but recommended:

- `CORS_ALLOW_ORIGINS`
- `SMUG_API_KEY`
- `SMUG_NICKNAME`
- `IMPORT_LOCK_TTL_MS`
- `IMPORT_STALE_WARNING_HOURS`

Do not log or commit real token/API key values.

## Current routes

```txt
/api/music/bands
/api/music/shows
/api/music/people
/api/music/people/db/:personId
/api/music/venues
/api/wrestling/shows
/api/wrestling/people
/api/wrestling/venues
/api/stats
```

Add `?refresh=1` to bypass the short memory cache.

On Render, admin/control routes and public routes with `?refresh=1` require an admin token. Pass it with one of:

```txt
x-admin-token: YOUR_ADMIN_TOKEN
Authorization: Bearer YOUR_ADMIN_TOKEN
?admin_token=YOUR_ADMIN_TOKEN
```

## Production checks

Public health:

```txt
/health
/health/db
/health/tables
```

Admin status and diagnostics:

```txt
/api/admin/status
/api/admin/status/imports
/api/admin/diagnostics
/api/admin/diagnostics/imports
/api/admin/diagnostics/relationships
```

Manual import refresh examples:

```txt
/admin/import/music/bands?refresh=1
/admin/import/wrestling/shows?refresh=1
```

Deployment checklist:

- Confirm `/health` returns `ok: true`.
- Confirm `/api/admin/status` rejects missing/invalid tokens.
- Confirm `/api/admin/status` works with `ADMIN_TOKEN`.
- Confirm `/api/music/bands?refresh=1` rejects missing token.
- Confirm import history updates after a manual import.
- Confirm startup logs do not contain secret values.

## Notes

This repo is backend-only. Public data routes are read-only. Admin/import/stats rebuild/control routes are protected by `ADMIN_TOKEN` in Render/production.

## Calendar / Todoist (CAL-03, disabled by default)

Calendar uses the verified **Voodoo Gigs** project `6gRQ3CfW6Ww7V2fF`. No frontend,
Google Sheets route, existing Admin authentication, or Music/Wrestling import is changed.
`GET /api/calendar` reads PostgreSQL only; visitors never trigger Todoist requests,
schema creation, OAuth refresh, or ingestion. There is no public `refresh=1` bypass.

### Publication contract

An event must have the exact `public-confirmed` label, a nonempty title, a valid
structured scheduled date, and belong to that project. It must be incomplete,
not deleted, top-level, and non-recurring. `cancelled`, `draft`, or `tentative`
labels override approval. Invalid/ineligible tasks are omitted. Conflicting copies
of the same task during pagination reject the whole scan; identical copies are deduplicated.

Optional description fields are single lines, with these exact prefixes:

```text
Location: Venue Name — City, State
Public: Optional visitor-facing description.
```

Only those lines are extracted. Repeated/oversized fields are omitted. Other lines,
comments, attachments, assignees, and raw tasks are never stored or returned.
Returned titles/descriptions are **plain text**; clients must use text rendering,
not HTML insertion. Limits: title 500, location 300, public description 2000 characters.

Events contain only `event_id`, `title`, `date`, `start_time`, `all_day`, `location`,
`status` (`confirmed`), and `description`. IDs remain opaque strings. The envelope
declares `America/New_York`. Date-only values retain their calendar date. Fixed
instants convert to New York; floating times are interpreted there. Nonexistent or
ambiguous floating DST times are withheld; use an explicitly fixed time instead.
Timed events are excluded at their start; all-day events remain through their local
day. Ordering is date ascending, all-day first, timed instant, then stable ID.

### Credentials and provisioning (separate approval required)

No live credentials, schema changes, or Todoist authorization were applied by CAL-03.
Required configuration: existing `DATABASE_URL`, `TODOIST_CALENDAR_ENABLED=1`,
`TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`, `TODOIST_TOKEN_ENCRYPTION_KEY` (canonical
base64 for 32 random bytes), and `TODOIST_REDIRECT_URI`. Keep secrets in the deployment
secret store, never Git, query URLs, logs, or frontend configuration. Do not use an
Admin token or a personal Todoist token as the Todoist access token.

The redirect must exactly match the registered URL and end with
`/api/calendar/oauth/callback`, with no query, fragment, or embedded credentials.
HTTPS is required except loopback HTTP outside production/Render. Configuration
changes invalidate stored authorization; reauthorize after changing the client,
secret, redirect, or encryption key. Preserve the encryption key across restarts.

After separately approving deployment/schema setup:

1. Register an OAuth application for **`data:read` only**. No write scopes are accepted.
2. Make an authenticated `POST /api/admin/calendar/oauth/start` (no request body).
   It uses existing V3 Admin Bearer authorization and its existing Origin /
   `X-V3-Admin-Request` conventions, or a valid legacy credential in a header.
   New Calendar setup/diagnostics reject query-token-only access and development bypass.
3. Open the returned `authorization_url` and explicitly authorize Todoist. The callback
   consumes a 10-minute, single-use hashed state and encrypted PKCE verifier, exchanges
   the code, and durably stores AES-256-GCM-encrypted access/refresh tokens. No token is
   returned. Authorization alone is not proof of publication or project accessibility.
4. The next coordinated refresh validates project access and publishes eligible tasks.

Token refresh is serialized with a separate PostgreSQL advisory lock. Replacement
refresh tokens are saved atomically. A durable in-progress marker makes an interrupted
or ambiguous token rotation require reauthorization rather than replaying a potentially
consumed token. Persistent 401/403, invalid scope, corrupt ciphertext, and lost rotations
stop external attempts until reauthorization. A known 429 observes the supplied delay.
Do not change existing Admin login/session settings to enable Calendar.

### Refresh, snapshots, and failure behavior

One completion-driven timer per process targets five minutes. A dedicated database
advisory lock plus persisted `next_attempt_at` coordinates multiple instances. Lock or
database failures stop publication. No external worker, cron service, or new dependency
is introduced. Request limit: 10 seconds; whole scan: 60 seconds; page size 50; maximum
20 pages; maximum page response 2 MiB. Cursors are opaque, project filters remain fixed,
loops/partial scans fail, and error bodies are not exposed. Rate-limit delays are
persisted, with at least five minutes between failed scans.

Only complete successful retrieval can atomically replace the normalized snapshot.
A valid empty scan withdraws all previous events; losing approval removes an event on
the next successful reconciliation. Failed attempts update operational status only,
never the verification timestamp or published events. Todoist pagination itself is
not a transaction; publication reflects a bounded scan, not instant synchronization.

Snapshots expire no later than five minutes after scan start. Expiry is shortened to
the first included event's start or all-day boundary, so events cannot become overdue
while cached (including fixed instants in the repeated DST hour). A refresh is scheduled
at that boundary, with a 10-second minimum scheduling gap. A brief unavailable state is
possible while a boundary refresh is running. Polling cannot offer immediate withdrawal.

Public response states:

| HTTP | status | events |
| --- | --- | --- |
| 200 | `ready` | Validated public events |
| 200 | `empty` | `[]`, from a fresh successful snapshot |
| 503 | `stale` | `[]`, expired snapshot |
| 503 | `unavailable` | `[]`, disabled/misconfigured, unauthorized, missing/invalid snapshot or DB failure |

The envelope includes `timezone`, `events`, and `freshness` (`verified_at`, `expires_at`,
`age_seconds`, or null). Public caching is capped at 30 seconds and remaining freshness;
there is no stale-while-revalidate allowance. Errors are no-store. Clients show loading
while awaiting the request and must not treat an error as an empty calendar.

`GET /api/admin/calendar/status` is protected and no-store. It reports configuration,
authorization availability, last success, snapshot age/count, refresh status, and a
sanitized error code. It does not query Todoist or expose task/token payloads. Operational
logs contain status/error codes only. The global error serializer is not used here.

This checkout does not establish deployment uptime, instance count, or sleeping policy.
Sleeping services cannot guarantee five-minute refreshes. On wake/restart the database
lock and persisted schedule apply; stale snapshots remain unavailable until a successful
refresh. Do not promise uninterrupted availability without verifying hosting behavior.

### Local verification and deployment safety

`node scripts/test-calendar.js` uses synthetic credentials and injected fetch/database
fixtures. It does not start the server, load `.env`, contact Todoist, or connect to a real
database. It covers API handlers, publication, OAuth, locking and scheduling failures.

**`npm start` / `npm run dev` apply schema and runtime migrations.** Do not use them for
local verification with a production `DATABASE_URL`. Additive table definitions require
a separately authorized migration/deployment. Calendar modules themselves never create
tables. The public endpoint works safely as 503 while the integration remains disabled.
