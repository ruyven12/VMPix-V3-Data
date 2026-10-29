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

## Calendar / Todoist (CAL-03 through CAL-08, disabled by default)

Calendar uses the verified **Voodoo Gigs** project `6gRQ3CfW6Ww7V2fF`. No frontend,
Google Sheets route, existing Admin authentication, or Music/Wrestling import is changed.
`GET /api/calendar` reads PostgreSQL only; visitors never trigger Todoist requests,
schema creation, OAuth refresh, or ingestion. There is no public `refresh=1` bypass.

### Independent integration and public visibility controls (CAL-08)

Both flags default off. `TODOIST_CALENDAR_ENABLED=1` explicitly enables the existing
integration; other values leave it off. `TODOIST_CALENDAR_PUBLIC_ENABLED=true` (or `1`)
explicitly permits public reads; missing, `false`, `0`, and all other values leave them off.
Enabling backend integration is **not authorization to expose Calendar events publicly**.

| Master integration | Public visibility | Behavior |
| --- | --- | --- |
| Off | Off | Integration off; public unavailable |
| Off | On | Integration off; public unavailable |
| On | Off | Configured OAuth, refresh and protected diagnostics work privately; public unavailable |
| On | On | Existing public API behavior, subject to configuration, authorization and freshness |

With exposure disabled, every request reaching `GET /api/calendar` returns
503 / `unavailable`, `events: []`, `freshness: null`, and `Cache-Control: no-store`.
The gate runs before database acquisition. Conditional cache validators, query parameters
and Admin credentials do not bypass it. No snapshot contents or diagnostics are returned,
and public requests never initiate Todoist calls.

The public flag is separate from the credential fingerprint, scheduler, publication
transaction and snapshot freshness. Changing it does not invalidate authorization, reset
the persisted refresh deadline, bypass provider backoff or modify the stored snapshot.
The existing worker resumes against that persisted schedule after a process restart.

Flags are read when the Calendar service is created, not hot-reloaded from environment
changes. Apply an approved configuration deployment/restart to **all** running instances
and verify their effective settings. On Render, use the workflow that applies saved
environment changes; do not assume restarting an older deployment picks them up.
Previously issued successful responses can remain in client/proxy caches for their
remaining lifetime (at most 30 seconds). Disabling visibility cannot revoke bytes already
delivered; origin responses after the new configuration takes effect are always no-store.

### Private validation and public-disable rollback

After separately approved schema, secrets and deployment setup, keep
`TODOIST_CALENDAR_PUBLIC_ENABLED=false` while enabling the master and performing explicitly
authorized OAuth setup. Use the existing authenticated `/api/admin/calendar/status` for
configuration, authorization, refresh status, count and freshness checks. It exposes
`integration_enabled` and `public_enabled` as configured booleans; `configured` and
`authorized` separately describe readiness. A public flag alone does not imply availability.
There is no public preview endpoint or new privileged access mechanism.

Allow the existing bounded worker to perform the approved initial scan, privately validate
only normalized snapshot fields through separately authorized database inspection, then
observe at least two coordinated refresh cycles. Confirm the public endpoint stays
503/unavailable/no-store throughout. Never inspect credentials or raw private tasks.
Only a separate public-exposure approval permits setting the public flag to `true` and
deploying that configuration; then verify the eight-field contract and cache limits.

To withdraw public visibility, set only `TODOIST_CALENDAR_PUBLIC_ENABLED=false`, apply it
to every instance and verify 503/unavailable/no-store, including conditional requests.
OAuth and synchronization may continue privately. If integration must also stop, separately
disable the master flag. Retain the encryption key, credentials and snapshot; do not drop
tables. A code rollback to a version before CAL-08 lacks this gate: disable the master too
before such a rollback. Review startup migrations and environment settings for any deploy.

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
changes to credential configuration invalidate stored authorization; reauthorize after changing the client,
secret, redirect, or encryption key. Preserve the encryption key across restarts.
Changing only `TODOIST_CALENDAR_PUBLIC_ENABLED` does not require reauthorization.

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
4. The next coordinated refresh validates project access and writes eligible tasks to
   the PostgreSQL snapshot. Keep public visibility disabled during this private validation.

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
| 503 | `unavailable` | `[]`, integration/public visibility disabled, misconfigured, unauthorized, missing/invalid snapshot or DB failure |

The envelope includes `timezone`, `events`, and `freshness` (`verified_at`, `expires_at`,
`age_seconds`, or null). Public caching is capped at 30 seconds and remaining freshness;
there is no stale-while-revalidate allowance. Errors are no-store. Clients show loading
while awaiting the request and must not treat an error as an empty calendar.

`GET /api/admin/calendar/status` is protected and no-store. It reports the integration
and public-visibility flags, configuration,
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
database. It covers API handlers, the independent public gate and conditional requests,
publication, OAuth, locking and scheduling failures. Public-response fixtures explicitly
opt in to visibility; private/default-off fixtures do not. Isolated PostgreSQL tests must
also explicitly select public visibility when verifying ready/empty/stale responses.

**`npm start` / `npm run dev` apply schema and runtime migrations.** Do not use them for
local verification with a production `DATABASE_URL`. Additive table definitions require
a separately authorized migration/deployment. Calendar modules themselves never create
tables. The public endpoint works safely as 503 while the integration remains disabled.

## CAL-04 production-readiness review (2026-10-29)

**Recommendation: NO-GO for production activation.** CAL-03 runtime and publication
policy remain unchanged. This pass adds readiness tests and this checklist only.
The inspected checkout baseline was `a6ee74c9fd9961a48d7a0fe2ed0101d66da95956`.
No live OAuth, production schema application, deployment, secret provisioning or
enablement was performed. The production enablement value itself could not be read.

### Verified findings and blockers

- The original 22 Calendar groups pass; five additional readiness groups pass.
  Two new release checks fail: **27/29** total. The failing checks remain enabled.
  1. `requestJson()` reads a top-level `retry_after`, but not Todoist's documented
     `error_extra.retry_after`. A synthetic body-only 900-second backoff results in
     a 300-second retry. Before activation, accept valid nested backoff metadata
     without shortening a valid server delay, and keep invalid values bounded.
  2. Public/diagnostic snapshot reads use `pool.query()`. Its `query_timeout` does
     not cover waiting for an available pool connection. The installed `pg` Pool,
     with a synthetic transport and its only connection held, leaves the Calendar
     read pending beyond 3300ms despite the 3000ms query timeout. Before activation,
     bound Calendar read connection acquisition and clean up late arrivals; return
     sanitized 503/no-store on failure. Do not alter unrelated database consumers.
- OAuth scope, one-use state, PKCE challenge/verifier consistency, denied callbacks,
  encrypted token persistence, rotation serialization and fail-closed interrupted
  rotation are verified with mocks. Legacy token responses and grace-window responses
  without a recoverable replacement refresh token are rejected safely.
- The current official API documents the exact project filter, `results`/`next_cursor`,
  task fields and structured due dates used here. A new OAuth app defaults to rotating
  refresh tokens; a legacy app must explicitly enable that mode. CAL-03 intentionally
  does not support long-lived personal/legacy tokens. Actual provider enforcement of
  PKCE for the configured confidential app still requires an authorized live test.
- Publication excludes unapproved/ineligible tasks; only the eight public fields are
  returned. Tests cover New York DST, all-day boundaries, partial scans, withdrawals,
  valid empty snapshots, credential changes mid-scan and failed token persistence.
- Isolated Express HTTP checks verify ready/empty/stale/unavailable, no-store errors,
  no ingestion from public reads, and no stale 304 response after snapshot expiry.
  Synthetic restart tests preserve the existing snapshot, credentials and retry delay.
- Import Reporting: **22/22**. Wrestling photo-total: **14/16**, with the same two
  missing-`res.locals` fixture failures reproduced against pre-Calendar `3f6620b`.
  No unrelated test repairs were made. JavaScript syntax and scoped diff checks pass.

### PostgreSQL assessment

The two additive tables use singleton primary keys, UUID credential versions,
TIMESTAMPTZ freshness, a JSONB array check, and status/scope/state constraints.
The primary-key indexes are sufficient for their single-row equality lookups; no
additional event, JSONB or ciphertext index is needed. Snapshot replacement uses
BEGIN/UPDATE/COMMIT and ROLLBACK on failure. The credential row is locked FOR SHARE
during publication to prevent publishing under replaced authorization. A valid
empty array is supported. No Music/Wrestling tables or relationships are changed.

Refresh and OAuth coordination use separate session advisory locks on dedicated
connections, plus persisted scheduling and token-rotation markers. Use a **direct
PostgreSQL connection**, not transaction-pooled PgBouncer, for these session locks.
The worker can hold two connections concurrently; retain capacity for public APIs.
On a lost connection PostgreSQL releases session locks and rolls back uncommitted
transactions; a restarted worker consults the persisted schedule before another scan.
An ambiguous committed token exchange deliberately requires reauthorization.

Real schema execution, grants, locking, transaction rollback and connection-loss
recovery remain **unverified**: no disposable PostgreSQL/Docker runtime or explicitly
identified test database was available. Mock SQL tests and the installed-driver probe
are not a substitute. Before migration, check whether either table already exists
and compare its definition; CREATE TABLE IF NOT EXISTS does not validate an existing
table. The existing `db.js` sets `rejectUnauthorized: false`; certificate/network
assurance must be reviewed for the intended production connection separately. This
pre-existing shared setting was inspected but not changed.

### Hosting and live access

Render connector operations were unavailable; the browser reached Render sign-in.
No Render CLI, local Render Blueprint, or configured non-production Todoist credentials
were available in the scoped checks. Service identity, plan, region, instance count,
deployed commit, environment configuration and database state could not be verified.
No account sign-in or authorization was initiated.

Render Free web services sleep after 15 minutes without inbound traffic; an in-process
timer cannot guarantee five-minute refreshes while asleep. Verify a continuously
running service before activation; if the target is Free, an approved paid-compute
change is needed for this design. No cron or additional service is proposed here.
Multiple running instances use the existing database locks/persisted schedule; this
behavior is mock-tested, not yet exercised on Render. Restarts preserve PostgreSQL
snapshots and encrypted tokens; expired snapshots remain withheld until refresh succeeds.

Even on continuous hosting, the current schedule starts the next scan at the freshness
boundary, so a brief 503/stale window can occur during a successful refresh. Rate limits
or downtime can extend unavailability, and removal of approval is bounded by polling,
not instantaneous. Keep the existing health endpoint: Calendar's intentionally disabled
or stale 503 response must not become the whole service's health check.

### Controlled activation checklist — not executed

Every production write, configuration change, authorization or deploy below requires
separate user approval. CAL-05A/B and CAL-06A/B/C address the earlier failing checks and
isolated PostgreSQL verification; they do not establish live Render/Todoist readiness.
Do not create live test tasks.

1. **Migration approval:** verify the target service/database and pending migrations.
   Apply only the two additive CAL-03 definitions under a reviewed transaction with
   bounded lock/statement timeouts; inspect resulting columns, constraints and indexes.
   Existing startup applies the full schema and runtime migrations even when Calendar
   is disabled, so a backend deployment must not be treated as a migration-free step.
2. **Render configuration approval:** verify a continuously running service, correct
   Node runtime (18+), direct PostgreSQL URL, adequate connection capacity, intended
   workspace/region and existing Admin/CORS settings. Keep `TODOIST_CALENDAR_ENABLED=0`
   and `TODOIST_CALENDAR_PUBLIC_ENABLED=false` throughout preparation. No new service or
   scheduler is required by this plan.
3. **Encryption-key approval:** provision `TODOIST_TOKEN_ENCRYPTION_KEY` as canonical
   base64 for 32 cryptographically random bytes in Render secrets. Preserve it securely
   across restarts/rollbacks; do not rotate it casually or print it. Configuration/key
   changes invalidate existing authorization and require a reviewed reauthorization.
4. **OAuth application approval:** configure a confidential Todoist OAuth application
   with refresh tokens enabled, `data:read` only, and an exact HTTPS redirect ending in
   `/api/calendar/oauth/callback`. Provision `TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`
   and `TODOIST_REDIRECT_URI`. Preserve the existing `DATABASE_URL` and Admin credentials.
5. **Private integration and account authorization approval:** enable only
   `TODOIST_CALENDAR_ENABLED=1`, keeping `TODOIST_CALENDAR_PUBLIC_ENABLED=false`.
   Complete the protected OAuth start and explicit account consent. CAL-08 separates
   public exposure from integration: the worker can write the validated snapshot while
   public reads remain unavailable. This is private validation, not a database dry run.
6. **Initial real scan:** allow the existing bounded worker to retrieve only project
   `6gRQ3CfW6Ww7V2fF`; verify approval/exclusion behavior against existing approved tasks.
   Confirm no personal tasks, raw descriptions or extra fields reach storage/output.
7. **Publication verification:** read back only normalized snapshot fields and freshness;
   confirm credential linkage and success, including legitimate empty publication. Never
   print ciphertext, raw OAuth responses or private task fields during inspection.
8. **Refresh monitoring:** use authenticated `/api/admin/calendar/status` and sanitized
   status logs across at least two refresh cycles. Check expiry/cache behavior, retries,
   restart recovery and absence of overlapping workers. Inspect query-string logging
   so OAuth callback codes/state are not retained in proxy/access logs.
9. **Public exposure approval and verification:** only after private validation, set
   `TODOIST_CALENDAR_PUBLIC_ENABLED=true` and deploy the approved configuration to all
   instances. Check the approved production URL for ready or verified
   empty, exact eight-field records, New York dates and bounded cache headers. Exercise
   stale/unavailable and failure injection in staging, not by disrupting production.
   No frontend Calendar changes are part of this activation.
10. **Rollback approval:** set `TODOIST_CALENDAR_PUBLIC_ENABLED=false` and deploy that
    configuration; verify `/api/calendar` returns 503/unavailable/no-store. Disable
    `TODOIST_CALENDAR_ENABLED` as well if synchronization must stop or code is rolled back
    to a version without the public gate. Allow the
    existing public-cache window (at most 30 seconds) to expire. Retain both additive
    tables, snapshot and encrypted credentials; do not drop tables or alter archive data.
    If code rollback is also needed, verify configuration and schema compatibility first:
    a code rollback does not undo migrations or necessarily apply newly saved environment
    values. Token revocation/key rotation are separate approved actions if required.

Current primary references: [Todoist API v1](https://developer.todoist.com/api/v1/),
[Render Free services](https://render.com/docs/free),
[Render deployments](https://render.com/docs/deploys),
[Render health checks](https://render.com/docs/health-checks),
[Render private networking](https://render.com/docs/private-network),
[Render rollbacks](https://render.com/docs/rollbacks).
