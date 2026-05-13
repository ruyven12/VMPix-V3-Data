# VMPix V3 Data Backend v1 Freeze

Backend v1 is frozen for frontend/admin shell integration after the checks below pass on Render.

## Runtime Commands

```bash
npm install
npm start
npm run dev
node --check server.js
```

## Required Environment Variables

```txt
DATABASE_URL
GOOGLE_SHEET_ID
ADMIN_TOKEN
GID_MUSIC_BANDS
GID_MUSIC_SHOWS
GID_MUSIC_PEOPLE
GID_MUSIC_VENUES
GID_WRESTLING_MATCHES
GID_WRESTLING_PEOPLE
GID_WRESTLING_VENUES
GID_STATS
```

Optional:

```txt
PORT
ADMIN_PASSWORD
ADMIN_REQUIRE_TOKEN
CORS_ALLOW_ORIGINS
SMUG_API_KEY
SMUG_NICKNAME
SMUG_TOTAL_PHOTOS_CACHE_TTL_MS
IMPORT_LOCK_TTL_MS
IMPORT_STALE_WARNING_HOURS
IMPORT_DEBUG
```

## Admin Token Usage

Use one of these for protected routes:

```txt
x-admin-token: YOUR_ADMIN_TOKEN
Authorization: Bearer YOUR_ADMIN_TOKEN
?admin_token=YOUR_ADMIN_TOKEN
```

Protected route families:

```txt
/api/admin/*
/admin/import/*
/api/wrestling/people/import
public sheet routes when ?refresh=1 is used
```

Public route families:

```txt
/health
/health/db
/health/tables
public data routes without ?refresh=1
```

## Public Route Commands

Replace `BASE_URL` with `https://vmpix-data.onrender.com` or `http://localhost:3000`.

```txt
GET BASE_URL/
GET BASE_URL/health
GET BASE_URL/health/db
GET BASE_URL/health/tables

GET BASE_URL/api/music/bands
GET BASE_URL/api/music/shows
GET BASE_URL/api/music/people
GET BASE_URL/api/music/venues
GET BASE_URL/api/wrestling/shows
GET BASE_URL/api/wrestling/people
GET BASE_URL/api/wrestling/venues
GET BASE_URL/api/stats

GET BASE_URL/api/music/bands/db?limit=25&page=1
GET BASE_URL/api/v3/music/bands/db?limit=25&page=1
GET BASE_URL/api/music/bands/stats
GET BASE_URL/api/music/shows/db?limit=25&page=1
GET BASE_URL/api/music/shows/stats
GET BASE_URL/api/music/people/db?limit=25&page=1
GET BASE_URL/api/music/people/stats
GET BASE_URL/api/music/venues/db?limit=25&page=1
GET BASE_URL/api/music/venues/stats
GET BASE_URL/api/status/music

GET BASE_URL/api/wrestling/shows/db?limit=25&page=1
GET BASE_URL/api/wrestling/shows/stats
GET BASE_URL/api/wrestling/people?limit=25&page=1
GET BASE_URL/api/wrestling/people/db?limit=25&page=1
GET BASE_URL/api/wrestling/people/stats
GET BASE_URL/api/wrestling/venues/db?limit=25&page=1
GET BASE_URL/api/wrestling/venues/stats
```

## Protected Admin Route Commands

Append `?admin_token=YOUR_ADMIN_TOKEN`, or send an admin token header.

```txt
GET BASE_URL/api/admin/overview
GET BASE_URL/api/admin/status
GET BASE_URL/api/admin/status/imports
GET BASE_URL/api/admin/diagnostics
GET BASE_URL/api/admin/diagnostics/imports
GET BASE_URL/api/admin/diagnostics/music
GET BASE_URL/api/admin/diagnostics/wrestling
GET BASE_URL/api/admin/diagnostics/relationships
GET BASE_URL/api/admin/diagnostics/music/relationships
GET BASE_URL/api/admin/diagnostics/wrestling/relationships

GET BASE_URL/api/admin/import-history
GET BASE_URL/api/admin/import-history/music
GET BASE_URL/api/admin/import-history/wrestling
GET BASE_URL/api/admin/import-history/latest

GET BASE_URL/api/admin/import-locks
GET BASE_URL/api/admin/import-locks/music
GET BASE_URL/api/admin/import-locks/wrestling

GET BASE_URL/api/admin/relationships
GET BASE_URL/api/admin/relationships/summary
GET BASE_URL/api/admin/relationships/music
GET BASE_URL/api/admin/relationships/wrestling

GET BASE_URL/api/admin/stats/summary
GET BASE_URL/api/admin/stats/rebuild
GET BASE_URL/api/admin/stats/rebuild/music
GET BASE_URL/api/admin/stats/rebuild/wrestling
```

## Protected Import Commands

Append `?refresh=1&admin_token=YOUR_ADMIN_TOKEN`.

```txt
GET BASE_URL/admin/import/music/bands?refresh=1
GET BASE_URL/admin/import/music/shows?refresh=1
GET BASE_URL/admin/import/music/people?refresh=1
GET BASE_URL/admin/import/music/venues?refresh=1

GET BASE_URL/admin/import/wrestling/shows?refresh=1
GET BASE_URL/admin/import/wrestling/people?refresh=1
GET BASE_URL/admin/import/wrestling/venues?refresh=1
GET BASE_URL/api/wrestling/people/import?refresh=1
```

## Protected Public Refresh Commands

Append `admin_token=YOUR_ADMIN_TOKEN` when using `refresh=1`.

```txt
GET BASE_URL/api/music/bands?refresh=1
GET BASE_URL/api/music/shows?refresh=1
GET BASE_URL/api/music/people?refresh=1
GET BASE_URL/api/music/venues?refresh=1
GET BASE_URL/api/wrestling/shows?refresh=1
GET BASE_URL/api/wrestling/people?refresh=1
GET BASE_URL/api/wrestling/venues?refresh=1
GET BASE_URL/api/stats?refresh=1
```

## Manual QA Checklist

```txt
1. node --check server.js passes.
2. /health returns ok true.
3. /health/db connects when DATABASE_URL is configured.
4. /health/tables lists expected tables.
5. /api/admin/status rejects missing token.
6. /api/admin/status rejects invalid token.
7. /api/admin/status accepts valid token.
8. /api/music/bands works without refresh token.
9. /api/music/bands?refresh=1 rejects missing token.
10. DB routes clamp limit to 100 and default bad page values to 1.
11. Invalid sort fields fall back to allowlisted defaults.
12. Import route failures are recorded in import history.
13. /api/admin/diagnostics/relationships returns relationship issue counts.
14. /api/admin/status/imports returns recent import/stale status.
15. /api/admin/stats/summary returns cached snapshots or an empty safe state.
```

## Schema Safety

`schema.sql` is additive. It uses `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS`, safe indexes, and upsert-compatible tables.

Do not add `DROP`, `TRUNCATE`, or destructive migration behavior for Backend v1.

## Known Backend v1 Limitations

```txt
SmugMug sync automation is not included.
Write APIs are not included.
User accounts/sessions are not included.
AI tagging helpers are not included.
Advanced caching is not included.
Live notifications/websockets are not included.
Advanced analytics are not included.
Exact inserted-vs-updated import counts depend on importer-level reporting.
```

