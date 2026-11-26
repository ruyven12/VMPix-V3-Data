'use strict';

const crypto = require('node:crypto');
const { guardClient, clientFailure, isConnectionError, retryDatabaseRead } = require('./db-resilience');
const VERSION = 1;
const DEFINITION = 'music_people_linked_album_caption_relationships_v1';
const SNAPSHOT_KEY = 'relationship_population:v1';
const metadata = new WeakMap();
const PEOPLE_SQL = 'SELECT person_id, name, aliases FROM music_people ORDER BY person_id';
const SHOWS_SQL = `SELECT id, show_id, name, date, show_date, show_url, venue, city, state,
  gallery_id, album_id, cover_image_url, smug_albums FROM music_shows ORDER BY show_date DESC NULLS LAST, show_id DESC NULLS LAST, id DESC`;
const failure = code => Object.assign(new Error(code), { code });
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const personKey = row => String(row?.person_id ?? '').trim();
const identitySignature = row => hash([personKey(row), row?.name ?? '', row?.aliases ?? []]);
const showFields = ['id', 'show_id', 'name', 'date', 'show_date', 'show_url', 'venue', 'city', 'state',
  'gallery_id', 'album_id', 'cover_image_url'];
const albumFields = ['album_id', 'albumId', 'gallery_id', 'galleryId', 'cover_image_url'];
const project = (row, fields) => Object.fromEntries(fields.map(key => [key, row?.[key] ?? null]));

function projectSource(people, shows) {
  const identities = new Map();
  const population = people.map(row => ({ person_id: row.person_id, name: row.name ?? '', aliases: row.aliases ?? [] }));
  population.forEach(row => {
    const id = personKey(row);
    if (!id || identities.has(id)) throw failure('source_check_failed');
    identities.set(id, identitySignature(row));
  });
  const albums = shows.map(row => ({ ...project(row, showFields),
    show_date: row.show_date instanceof Date ? row.show_date.toISOString().slice(0, 10) : row.show_date ?? null,
    smug_albums: Array.isArray(row.smug_albums) ? row.smug_albums.map(album => project(album, albumFields)) : [] }));
  const fingerprint = hash({
    definition: DEFINITION,
    people: population.slice().sort((a, b) => personKey(a).localeCompare(personKey(b))),
    shows: albums.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
  });
  return { people: population, shows: albums, identities, fingerprint };
}

async function readSource(db, { retry = true } = {}) {
  const read = () => db.query(`SELECT
    coalesce((SELECT jsonb_agg(p) FROM (${PEOPLE_SQL}) p), '[]'::jsonb) AS people,
    coalesce((SELECT jsonb_agg(s) FROM (${SHOWS_SQL}) s), '[]'::jsonb) AS shows`);
  const result = await (retry ? retryDatabaseRead(read) : read());
  const row = result.rows?.[0];
  if (!Array.isArray(row?.people) || !Array.isArray(row?.shows)) throw failure('source_check_failed');
  return projectSource(row.people, row.shows);
}

const countFields = ['photo_count', 'set_count', 'show_count', 'event_count'];
const valueFields = ['gallery_id', 'album_id', 'cover_image_url', 'first_seen', 'first_seen_date_time_original',
  'first_seen_display', 'latest_seen', 'latest_seen_date_time_original', 'latest_seen_display'];
const photoFields = ['image_key', 'caption', 'date_taken', 'taken_at', 'date_time_original', 'thumbnail_url',
  'small_url', 'medium_url', 'large_url', 'album_id', 'gallery_id', 'show_id', 'show_key', 'show_title',
  'show_name', 'show_date', 'venue', 'location'];
const taggedFields = ['show_id', 'show_key', 'show_title', 'album_id', 'gallery_id', 'title', 'date', 'venue', 'location'];
function text(value, key) {
  if (value == null) return null;
  if (typeof value !== 'string') throw failure('persistence_invalid');
  if (key.endsWith('_url')) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password
        || [...url.searchParams.keys()].some(name => /^(api_?key|token|authorization|password|secret)$/i.test(name))) return null;
    } catch (_) { return null; }
  }
  return value;
}
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('persistence_invalid');
  return Object.fromEntries(fields.map(key => [key, text(value[key], key)]));
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('persistence_invalid');
  return value;
}
function relationship(value) {
  if (!value || typeof value !== 'object') throw failure('persistence_invalid');
  const result = { ...Object.fromEntries(countFields.map(key => [key, count(value[key])])), ...record(value, valueFields) };
  if (!Array.isArray(value.matched_photos) || !Array.isArray(value.tagged_shows)) throw failure('persistence_invalid');
  result.matched_photos = value.matched_photos.map(photo => record(photo, photoFields));
  result.tagged_shows = value.tagged_shows.map(show => ({
    ...record(show, taggedFields), tagged_photo_count: count(show.tagged_photo_count),
    matched_photos: Array.isArray(show.matched_photos) ? show.matched_photos.map(photo => record(photo, photoFields))
      : (() => { throw failure('persistence_invalid'); })()
  }));
  if (result.matched_photos.length > result.photo_count) throw failure('persistence_invalid');
  return result;
}
function emptyRelationship() {
  return { ...Object.fromEntries(countFields.map(key => [key, 0])),
    ...Object.fromEntries(valueFields.map(key => [key, null])), matched_photos: [], tagged_shows: [] };
}
function coverageRecord(value, people) {
  const result = { known_people: people, total_albums: count(value.total_albums),
    albums_processed: count(value.albums_processed), pages_processed: count(value.pages_processed), albums_from_cache: count(value.albums_from_cache) };
  if (result.albums_processed !== result.total_albums || result.albums_from_cache > result.albums_processed) throw failure('persistence_invalid');
  return result;
}
function encode(source, value, generation, verifiedAt, startedAt, coverage) {
  if (!(value instanceof Map) || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(startedAt))) throw failure('persistence_invalid');
  if ([...value.keys()].some(id => typeof id !== 'string' || !source.identities.has(id))) throw failure('persistence_invalid');
  return { version: VERSION, definition: DEFINITION, complete: true, source_fingerprint: source.fingerprint,
    generation, verified_at: verifiedAt, build_started_at: startedAt, coverage: coverageRecord(coverage, source.identities.size), identities: [...source.identities].sort(([a], [b]) => a.localeCompare(b)),
    relationships: [...source.identities.keys()].sort().map(id => [id, relationship(value.has(id) ? value.get(id) : emptyRelationship())]) };
}
function decode(data, source) {
  try {
    if (!data || data.version !== VERSION || data.definition !== DEFINITION || data.complete !== true
      || data.source_fingerprint !== source.fingerprint || !Number.isSafeInteger(data.generation) || data.generation < 0
      || typeof data.verified_at !== 'string' || !Number.isFinite(Date.parse(data.verified_at))
      || typeof data.build_started_at !== 'string' || !Number.isFinite(Date.parse(data.build_started_at))
      || !Array.isArray(data.identities) || !Array.isArray(data.relationships)
      || data.identities.length !== source.identities.size || data.relationships.length !== source.identities.size) return null;
    if (data.coverage?.known_people !== source.identities.size) return null;
    const coverage = coverageRecord(data.coverage, source.identities.size);
    const identities = new Map(data.identities), value = new Map();
    if (identities.size !== source.identities.size) return null;
    for (const [id, signature] of source.identities) if (identities.get(id) !== signature) return null;
    for (const [id, item] of data.relationships) {
      if (!source.identities.has(id) || value.has(id)) return null;
      value.set(id, relationship(item));
    }
    metadata.set(value, { fingerprint: source.fingerprint, identities, generation: data.generation, verifiedAt: data.verified_at, startedAt: data.build_started_at, coverage });
    return value;
  } catch (_) { return null; }
}

function describeRelationships(value) { return metadata.get(value) || null; }
function matchesIdentity(value, row) {
  return metadata.get(value)?.identities.get(personKey(row)) === identitySignature(row);
}

function createMusicPeopleRelationshipStore({ db, now = Date.now }) {
  async function load(source) {
    const result = await retryDatabaseRead(() => db.query(`SELECT data FROM stats_snapshots
      WHERE section = 'music' AND category = 'people' AND snapshot_key = $1`, [SNAPSHOT_KEY]));
    return decode(result.rows?.[0]?.data, source);
  }
  async function publish({ source, value, generation, startedAt = new Date(now()).toISOString(), coverage = { total_albums: 0, albums_processed: 0, pages_processed: 0, albums_from_cache: 0 }, isCancelled = () => false }) {
    let client;
    let damaged = false;
    try {
      client = guardClient(await db.connect());
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout = '3000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query('LOCK TABLE music_people, music_shows IN SHARE MODE');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('music_people_relationship_population_v1'))");
      const current = await readSource(client, { retry: false });
      if (isCancelled() || current.fingerprint !== source.fingerprint) throw failure('preparation_invalidated');
      const verifiedAt = new Date(now()).toISOString();
      const previous = await client.query(`SELECT data FROM stats_snapshots
        WHERE section = 'music' AND category = 'people' AND snapshot_key = $1 FOR UPDATE`, [SNAPSHOT_KEY]);
      const newer = decode(previous.rows?.[0]?.data, current);
      if (newer && Date.parse(describeRelationships(newer).startedAt) > Date.parse(startedAt)) {
        await client.query('COMMIT');
        if (clientFailure(client)) throw clientFailure(client);
        return newer;
      }
      const envelope = encode(current, value, generation, verifiedAt, startedAt, coverage);
      if (isCancelled()) throw failure('preparation_invalidated');
      await client.query(`INSERT INTO stats_snapshots (section, category, snapshot_key, data, generated_at, meta)
        VALUES ('music', 'people', $1, $2::jsonb, $3, $4::jsonb)
        ON CONFLICT (section, category, snapshot_key) DO UPDATE SET data = EXCLUDED.data,
          generated_at = EXCLUDED.generated_at, meta = EXCLUDED.meta`,
      [SNAPSHOT_KEY, JSON.stringify(envelope), verifiedAt, JSON.stringify({ definition: DEFINITION, version: VERSION })]);
      if (isCancelled()) throw failure('preparation_invalidated');
      await client.query('COMMIT');
      if (clientFailure(client)) throw clientFailure(client);
      return decode(envelope, current);
    } catch (error) {
      damaged = !!clientFailure(client) || isConnectionError(error);
      if (client && !damaged) {
        try { await client.query('ROLLBACK'); } catch (_) { damaged = true; }
      }
      if (!['preparation_invalidated', 'source_check_failed', 'persistence_invalid'].includes(error?.code)) {
        throw failure('persistence_failed');
      }
      throw error;
    } finally { if (client) client.release(damaged || !!clientFailure(client)); }
  }
  return { load, publish };
}

module.exports = { VERSION, DEFINITION, SNAPSHOT_KEY, PEOPLE_SQL, SHOWS_SQL, projectSource, readSource,
  identitySignature, describeRelationships, matchesIdentity, createMusicPeopleRelationshipStore };
