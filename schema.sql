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

CREATE TABLE IF NOT EXISTS music_shows (
    id SERIAL PRIMARY KEY,
    show_id INTEGER UNIQUE NOT NULL,
    name TEXT,
    venue TEXT,
    city TEXT,
    state TEXT,
    date TEXT,
    show_date DATE,
    poster TEXT,
    notes TEXT,
    camera_1 TEXT,
    camera_2 TEXT,
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
    venue TEXT NOT NULL,
    city TEXT,
    state TEXT,
    gps_lat TEXT,
    gps_lng TEXT,
    logo TEXT,
    description TEXT,
    notes TEXT,
    status TEXT,
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
    ADD COLUMN IF NOT EXISTS venue TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS gps_lat TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS gps_lng TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS logo TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS music_venues
    ADD COLUMN IF NOT EXISTS status TEXT;

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
