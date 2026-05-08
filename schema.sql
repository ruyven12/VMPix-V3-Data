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
