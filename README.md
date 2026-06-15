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
