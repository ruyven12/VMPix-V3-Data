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

- `GOOGLE_SHEET_ID`
- tab GIDs such as `GID_MUSIC_BANDS`, `GID_MUSIC_SHOWS`, etc.

## Current routes

```txt
/api/music/bands
/api/music/shows
/api/music/people
/api/music/venues
/api/wrestling/shows
/api/wrestling/people
/api/wrestling/venues
/api/stats
```

Add `?refresh=1` to bypass the short memory cache.

## Notes

This starter intentionally only reads Google Sheet tabs as CSV and returns normalized JSON.
It does not include frontend code, SmugMug photo logic, analytics, or old Music/Wrestling route behavior yet.
