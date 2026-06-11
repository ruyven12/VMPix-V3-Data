CREATE TABLE IF NOT EXISTS music_bands (
    id SERIAL PRIMARY KEY,
    band_id TEXT UNIQUE,
    band TEXT NOT NULL,
    smug_folder TEXT,
    logo_url TEXT,
    region TEXT,
    location TEXT,
    state TEXT,
    country TEXT,
    members TEXT,
    past_members TEXT,
    tags TEXT,
    status TEXT,
    notes TEXT,
    archived_sets INTEGER DEFAULT 0,
    total_sets INTEGER DEFAULT 0,
    gallery_id TEXT,
    album_id TEXT,
    cover_image_url TEXT,
    photo_count INTEGER DEFAULT 0,
    smug_last_synced_at TIMESTAMPTZ,
    smug_sync_status TEXT,
    smug_sync_error TEXT,
    general JSONB DEFAULT '{}'::jsonb,
    personnel JSONB DEFAULT '{}'::jsonb,
    stats JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS general JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS personnel JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS gallery_id TEXT;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS album_id TEXT;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS smug_last_synced_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS smug_sync_status TEXT;

ALTER TABLE IF EXISTS music_bands
    ADD COLUMN IF NOT EXISTS smug_sync_error TEXT;

CREATE TABLE IF NOT EXISTS music_shows (
    id SERIAL PRIMARY KEY,
    show_id INTEGER UNIQUE NOT NULL,
    name TEXT,
    venue_id TEXT,
    venue TEXT,
    city TEXT,
    state TEXT,
    date TEXT,
    show_date DATE,
    poster TEXT,
    show_url TEXT,
    notes TEXT,
    camera_1 TEXT,
    camera_2 TEXT,
    gallery_id TEXT,
    album_id TEXT,
    cover_image_url TEXT,
    photo_count INTEGER DEFAULT 0,
    smug_last_synced_at TIMESTAMPTZ,
    smug_sync_status TEXT,
    smug_sync_error TEXT,
    bands JSONB DEFAULT '[]'::jsonb,
    stats JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS show_id INTEGER;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS name TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS venue_id TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS venue TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS date TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS show_date DATE;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS poster TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS show_url TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS camera_1 TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS camera_2 TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS bands JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS gallery_id TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS album_id TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS smug_last_synced_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS smug_sync_status TEXT;

ALTER TABLE IF EXISTS music_shows
    ADD COLUMN IF NOT EXISTS smug_sync_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS music_shows_show_id_key
    ON music_shows (show_id);

CREATE TABLE IF NOT EXISTS music_people (
    id SERIAL PRIMARY KEY,
    person_id INTEGER UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    aliases JSONB DEFAULT '[]'::jsonb,
    bands JSONB DEFAULT '[]'::jsonb,
    associations JSONB DEFAULT '[]'::jsonb,
    stats JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS person_id INTEGER;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS name TEXT;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS aliases JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS bands JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS associations JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_people
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS music_people_person_id_key
    ON music_people (person_id);

CREATE TABLE IF NOT EXISTS music_venues (
    id SERIAL PRIMARY KEY,
    venue_id INTEGER UNIQUE NOT NULL,
    venue_key TEXT UNIQUE,
    venue TEXT NOT NULL,
    city TEXT,
    state TEXT,
    country TEXT,
    region TEXT,
    gps_lat TEXT,
    gps_lng TEXT,
    logo TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    description TEXT,
    notes TEXT,
    status TEXT,
    geo JSONB DEFAULT '{}'::jsonb,
    location JSONB DEFAULT '{}'::jsonb,
    media JSONB DEFAULT '{}'::jsonb,
    stats JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS venue_id INTEGER;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS venue_key TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS venue TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS country TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS region TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS gps_lat TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS gps_lng TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS logo TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS geo JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS location JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS media JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS music_venues_venue_id_key
    ON music_venues (venue_id);

CREATE UNIQUE INDEX IF NOT EXISTS music_venues_venue_key_key
    ON music_venues (venue_key);

CREATE TABLE IF NOT EXISTS system_import_logs (
    id SERIAL PRIMARY KEY,
    area TEXT,
    route TEXT,
    status TEXT,
    rows_read INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    rows_updated INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS area TEXT;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS route TEXT;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS rows_read INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS rows_inserted INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS rows_updated INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;

ALTER TABLE IF EXISTS system_import_logs
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS system_import_logs_area_route_finished_at_idx
    ON system_import_logs (area, route, finished_at DESC);

CREATE TABLE IF NOT EXISTS import_history (
    id SERIAL PRIMARY KEY,
    section TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    import_type TEXT,
    source_identifier TEXT,
    rows_fetched INTEGER DEFAULT 0,
    rows_imported INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    rows_updated INTEGER DEFAULT 0,
    rows_skipped INTEGER DEFAULT 0,
    total_rows_after_import INTEGER,
    error_message TEXT,
    warnings JSONB DEFAULT '[]'::jsonb,
    errors JSONB DEFAULT '[]'::jsonb,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS import_type TEXT;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS source_identifier TEXT;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS rows_fetched INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS rows_inserted INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS rows_updated INTEGER DEFAULT 0;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS total_rows_after_import INTEGER;

ALTER TABLE IF EXISTS import_history
    ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS import_history_section_category_started_at_idx
    ON import_history (section, category, started_at DESC);

CREATE INDEX IF NOT EXISTS import_history_status_started_at_idx
    ON import_history (status, started_at DESC);

CREATE TABLE IF NOT EXISTS import_locks (
    id SERIAL PRIMARY KEY,
    section TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    owner TEXT,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS import_locks_section_category_status_expires_at_idx
    ON import_locks (section, category, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS stats_snapshots (
    id SERIAL PRIMARY KEY,
    section TEXT NOT NULL,
    category TEXT NOT NULL,
    snapshot_key TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS stats_snapshots_section_category_snapshot_key_idx
    ON stats_snapshots (section, category, snapshot_key);

CREATE INDEX IF NOT EXISTS stats_snapshots_section_generated_at_idx
    ON stats_snapshots (section, generated_at DESC);

CREATE TABLE IF NOT EXISTS wrestling_shows (
    id SERIAL PRIMARY KEY,
    show_id INTEGER UNIQUE NOT NULL,
    show_key TEXT UNIQUE NOT NULL,
    promotion TEXT,
    show_name TEXT,
    date TEXT,
    show_date DATE,
    venue_id TEXT,
    venue TEXT,
    city TEXT,
    state TEXT,
    poster TEXT,
    camera_1 TEXT,
    camera_2 TEXT,
    matches JSONB DEFAULT '[]'::jsonb,
    stats JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS show_id INTEGER;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS show_key TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS promotion TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS show_name TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS date TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS show_date DATE;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS venue_id TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS venue TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS poster TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS camera_1 TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS camera_2 TEXT;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS matches JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

ALTER TABLE IF EXISTS wrestling_shows
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS wrestling_shows_show_id_key
    ON wrestling_shows (show_id);

CREATE UNIQUE INDEX IF NOT EXISTS wrestling_shows_show_key_key
    ON wrestling_shows (show_key);

CREATE TABLE IF NOT EXISTS wrestling_people (
    id SERIAL PRIMARY KEY,
    slug TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    aliases TEXT[] DEFAULT '{}'::text[],
    teams TEXT[] DEFAULT '{}'::text[],
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS slug TEXT;

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS name TEXT;

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}'::text[];

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS teams TEXT[] DEFAULT '{}'::text[];

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

ALTER TABLE IF EXISTS wrestling_people
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS wrestling_people_slug_key
    ON wrestling_people (slug);

CREATE TABLE IF NOT EXISTS wrestling_venues (
    id SERIAL PRIMARY KEY,
    venue_id TEXT UNIQUE,
    venue_name TEXT NOT NULL,
    city TEXT,
    state TEXT,
    country TEXT,
    region TEXT,
    venue_type TEXT,
    status TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    notes TEXT,
    geo JSONB DEFAULT '{}'::jsonb,
    raw_sheet JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS venue_id TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS venue_name TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS country TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS region TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS venue_type TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS geo JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS raw_sheet JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

ALTER TABLE IF EXISTS wrestling_venues
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS wrestling_venues_venue_id_key
    ON wrestling_venues (venue_id);


