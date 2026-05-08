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
